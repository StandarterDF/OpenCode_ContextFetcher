# OpenCode_LocalAI

> Плагин для OpenCode V2: сам подтягивает список моделей с локального
> llama.cpp / llama-swap сервера и делает их доступными в OpenCode.

> **⚠️ Как это работает.** На OpenCode 2.0.24 отдельный (не-каталожный)
> провайдер зарегистрировать нельзя — ни через `providers` в `opencode.json`,
> ни из плагина через `ctx.provider.transform`/`editor.add`: он попадает в
> реестр, но никогда не становится «доступным», и модели не выбираются
> (`Model unavailable`). Поэтому плагин прикрепляет локальные модели к уже
> доступному каталожному провайдеру (по умолчанию `opencode`, Zen) в виде
> алиасов. Детали и все проверки — в [`INVESTIGATION.md`](INVESTIGATION.md).

## Описание

OpenCode умеет автообнаруживать модели только у Ollama, LM Studio и vLLM. Для
остальных OpenAI-совместимых провайдеров (в том числе для роутера llama-swap на
llama.cpp) модели нужно перечислять вручную. Плагин снимает эту ручную работу:

- опрашивает `<baseURL>/v1/models` каждые 30 секунд;
- публикует каждую найденную модель как алиас на активном провайдере
  (`opencode` по умолчанию), с model-level `baseURL` на локальный сервер и
  подменой имени модели в теле запроса;
- берёт `limit.context` из того, что отдаёт сервер: явные поля
  (`context_length`, `max_model_len`, `meta.n_ctx`, …), затем флаги запуска
  llama-swap (`status.args` → `--ctx-size`) и его preset-файл
  (`status.preset` → `ctx-size = …`);
- перечитывает список и вызывает `ctx.model.reload()` при изменении —
  переключение моделей в роутере подхватывается без перезапуска OpenCode;
- задаёт `capabilities.input/output` из `architecture.input_modalities`;
- удаляет алиасы моделей, которые исчезли с сервера;
- не ходит в сеть, кроме опроса самого локального сервера;
- без внешних зависимостей — чистый JS.

## Как устроен алиас

Для каждой локальной модели `X` плагин создаёт модель
`<host>/<prefix>X` (например `opencode/local-gemma4-26a4b-styletune-rp`) со
такими полями:

| Поле | Значение | Зачем |
|---|---|---|
| `modelID` | id базовой каталожной модели (по умолчанию `big-pickle`) | чтобы OpenCode материализовал алиас: у не-каталожного `modelID` модель отбрасывается |
| `settings.baseURL` | `http://<сервер>/v1` | перенаправляет запросы этой модели на локальный сервер |
| `body.model` | реальный id модели на сервере | подменяет имя модели в теле запроса |
| `limit` / `capabilities` | из ответа `/v1/models` | иначе унаследуются от базовой модели |
| `cost` | `0/0` | чтобы `opencode.models-disabler` не отключил алиас |

## Требования

- OpenCode **V2** (проверено на `2.0.24`).
- Node.js **18+** (нужен глобальный `fetch`; в OpenCode уже есть).
- Локальный OpenAI-совместимый сервер, отдающий `/v1/models`
  (llama.cpp, llama-swap, vLLM, LM Studio, Ollama через прокси).
- **Доступный каталожный провайдер** — по умолчанию `opencode` (OpenCode Zen,
  он подключён через `/connect`). Его модели нужны как «носитель» алиасов.
  Провайдер можно сменить опцией `host`, но он обязан быть активным.

## Структура

```
LocalAI_OCV2/
├── opencode.json          # проектный конфиг (только $schema)
├── install.bat            # установка плагина в глобальный каталог OpenCode (Windows)
├── plugin/
│   ├── index.js           # сам плагин (чистый JS, без внешних зависимостей)
│   └── package.json       # "type": "module"
├── README.md
├── CHANGES.md             # незакоммиченные изменения
├── INVESTIGATION.md       # почему не работает нативный провайдер и как найден обход
├── AGENTS.md              # описание архитектуры проекта
└── LICENSE                # MIT
```

## Установка

```bat
install.bat
```

Скрипт копирует `plugin/` в
`%USERPROFILE%\.config\opencode\plugins\localai-discovery\` и удаляет
устаревший `localai-context`.

Для Linux / macOS глобальный путь — `~/.config/opencode/plugins/localai-discovery/`.

После установки плагин подхватывается автоматически (глобальные плагины
перезагружаются при изменении файлов). Если что-то не так — перезапусти сервис:
`opencode service restart`.

## Настройка

### Параметры плагина (`ctx.options`)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "file:///C:/Users/<you>/.config/opencode/plugins/localai-discovery",
      "options": {
        "host": "opencode",
        "baseModel": "big-pickle",
        "prefix": "local-",
        "tools": false,
        "refreshMs": 30000,
        "baseURL": "http://127.0.0.1:9931"
      }
    }
  ]
}
```

> Авто-обнаруженный плагин (каталог `plugins/`) получает `ctx.options = {}`.
> Чтобы задать опции, ссылайся на каталог плагина явной записью, как выше
> (и не держи вторую, авто-обнаруженную копию).

| Опция | По умолчанию | Описание |
|---|---|---|
| `host` | `opencode` | Активный провайдер, к которому цепляются алиасы. |
| `baseModel` | `big-pickle` | Каталожный `modelID` хоста, через который материализуются алиасы. |
| `prefix` | `local-` | Префикс id алиасов; по нему же удаляются устаревшие. |
| `tools` | `false` | Включать ли tool calling для обнаруженных моделей. |
| `refreshMs` | `30000` | Период перечитывания `/v1/models`, мс. |
| `baseURL` | `http://127.0.0.1:9931` | Адрес локального сервера. |
| `logFile` | `~/.config/opencode/localai-discovery.log` | Путь к лог-файлу. `false` — только stdout. |

> При глобальной установке (каталог `plugins/`) параметры из `opencode.json`
> **не передаются**, используются значения по умолчанию. Чтобы задать опции,
> добавь плагин в `opencode.json` объектной формой с `options`.

> Указывай `127.0.0.1`, а не `0.0.0.0`.

### Переменные окружения

| Переменная | Назначение |
|---|---|
| `LOCALAI_DEBUG` | Переопределяет путь к лог-файлу. |

## Проверка

```powershell
opencode run --model "opencode/local-gemma4-26a4b-styletune-rp" "Reply with exactly: OK"
```

Должно вернуться `OK`, а в логе появиться строка вида:

```
[localai-discovery] discovered 10 model(s) from http://127.0.0.1:9931/v1/models: ...
[localai-discovery] transform replay: published 10 alias(es) on opencode
```

Список алиасов — `opencode models | Select-String 'opencode/local-'`.

Если моделей нет, проверь по порядку:

1. Лог `~/.config/opencode/localai-discovery.log` (по умолчанию пишется всегда).
2. Сервер отвечает: `curl http://127.0.0.1:9931/v1/models`.
3. Хост-провайдер активен: `opencode api get /api/provider` содержит `opencode`.
4. Сервис перезапущен после правки `opencode.json` (если задавал `options`).

## Удаление

1. Убери запись плагина из `opencode.json` (если добавлял).
2. Удали каталог `<config>/plugins/localai-discovery/`.
3. Перезапусти сервис: `opencode service restart`.

## Ссылки

- [Документация OpenCode V2 — плагины](https://opencode.ai/v2/docs/build/plugins)
- [Конфигурация плагинов OpenCode V2](https://opencode.ai/v2/docs/plugins)
- [Провайдеры OpenCode V2](https://opencode.ai/v2/docs/providers/)
- [OpenCode V2](https://opencode.ai/v2/docs/)

## Лицензия

MIT — см. [LICENSE](LICENSE).
