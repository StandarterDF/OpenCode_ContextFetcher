# OpenCode_LocalAI

> Плагин для OpenCode V2: сам подтягивает список моделей с локального
> llama.cpp / llama-swap сервера и прописывает их контекст.

## Описание

OpenCode умеет автоопнаруживать модели только у Ollama, LM Studio и vLLM. Для
остальных OpenAI-совместимых провайдеров (в том числе для роутера
llama-swap на llama.cpp) модели нужно перечислять в `opencode.json` вручную, и
при каждом добавлении или смене модели на сервере правь конфиг.

Плагин снимает эту ручную работу:

- опрашивает `<baseURL>/v1/models` и публикует ответ через
  `ctx.model.transform`: добавляет и обновляет модели провайдера, убирает те,
  которых на сервере больше нет;
- берёт `limit.context` из того, что отдаёт сервер: явные поля
  (`context_length`, `max_model_len`, `meta.n_ctx`, …), затем флаги запуска
  llama-swap (`status.args` → `--ctx-size`) и его preset-файл
  (`status.preset` → `ctx-size = …`);
- перечитывает список каждые 30 секунд и при изменении вызывает
  `ctx.provider.reload()` — переключение моделей в роутере подхватывается без
  перезапуска OpenCode;
- задаёт `capabilities.input/output` из `architecture.input_modalities`;
- не ходит в сеть, кроме опроса самого локального сервера;
- без внешних зависимостей — чистый JS.

Модели в роутере больше не нужно описывать в конфиге: блок `models` у
провайдера можно удалить целиком.

## Что НЕ поддерживается из коробки

| Runtime | Автообнаружение в OpenCode | Твой роутер |
|---|---|---|
| Ollama | есть, `GET /api/tags` | 404 |
| LM Studio | есть, `GET /api/v1/models` | 404 |
| vLLM | есть, `GET /health` + `/v1/models`, фильтр `owned_by == "vllm"` | `/health` и `/v1/models` отвечают, но `owned_by` у всех моделей `llamacpp` — не подходит |

LM Studio и llama.cpp используют один и тот же движок инференса, но **разные
HTTP-интерфейсы**: у LM Studio свой нативный REST API (`/api/v1/*`), а
llama.cpp/llama-swap — OpenAI-совместимый (`/v1/*`). Поэтому встроенный
discovery для LM Studio к llama.cpp не подходит.

## Требования

- OpenCode **V2**.
- Node.js **18+** (нужен глобальный `fetch`; в OpenCode уже есть).
- Локальный OpenAI-совместимый сервер, отдающий `/v1/models`
  (llama.cpp, llama-swap, vLLM, LM Studio, Ollama через прокси).

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
├── AGENTS.md              # описание архитектуры проекта
└── LICENSE                # MIT
```

## Установка

Способы ниже равнозначны — выбери любой.

### Вариант 1. Вручную (Windows)

Запусти из корня репозитория:

```bat
install.bat
```

Скрипт скопирует `plugin/` в
`%USERPROFILE%\.config\opencode\plugins\localai-discovery\` и удалит
устаревший `localai-context`.

Для Linux / macOS глобальный путь — `~/.config/opencode/plugins/localai-discovery/`.

### Вариант 2. Одной командой через CLI

```bash
opencode plugin add 'github:StandarterDF/OpenCode_LocalAI#main::path:plugin'
opencode service restart
```

### Вариант 3. Только для одного проекта

- положи плагин в `<project>/.opencode/plugins/localai-discovery/` (файлы
  `index.js` и `package.json`) — OpenCode подхватит каталог автоматически;

  **или**

- укажи каталог явно в `<project>/opencode.json`:

  ```jsonc
  {
    "$schema": "https://opencode.ai/config.json",
    "plugins": ["./plugin"]
  }
  ```

## Настройка

### Провайдер

Плагин ведёт провайдера `LocalAI`. В глобальном конфиге у него должны быть
только настройки подключения — без блока `models`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "LocalAI": {
      "name": "Local Host",
      "package": "aisdk:@ai-sdk/openai-compatible",
      "settings": {
        "baseURL": "http://127.0.0.1:9932/v1",
        "apiKey": "..."
      }
    }
  }
}
```

> Указывай `127.0.0.1`, а не `0.0.0.0`. `0.0.0.0` — адрес прослушивания
> (bind), по нему нельзя ходить как клиенту.

### ⚠️ Главные правила

1. **ID провайдера — `localai`**, строчными буквами. Это ID встроенной
   интеграции OpenCode. С большой буквы (`LocalAI`) провайдер не
   регистрируется вообще: `/api/provider` отвечает `ProviderNotFoundError`,
   модели не появляются, и плагину нечего обновлять.
2. **Нужна одна bootstrap-модель** в `opencode.json` — кастомный провайдер без
   единой модели не материализуется. Плагин подхватит остальные модели и
   удалит bootstrap-модель сам.
3. **Не задавай `limit.context` явно** — такое значение перебьёт то, что
   плагин взял из `/v1/models`.

### Параметры плагина (`ctx.options`)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./plugin",
      "options": {
        "provider": "LocalAI",
        "tools": false,
        "refreshMs": 30000,
        "baseURL": "http://127.0.0.1:9932/v1"
      }
    }
  ]
}
```

| Опция | По умолчанию | Описание |
|---|---|---|
| `provider` | `localai` | ID провайдера, чей список моделей ведётся. |
| `tools` | `false` | Включать ли tool calling для обнаруженных моделей. Локальные chat-template редко его поддерживают. |
| `refreshMs` | `30000` | Период перечитывания `/v1/models`, мс. |
| `baseURL` | из настроек провайдера, иначе `http://127.0.0.1:9932` | Адрес сервера, если он не задан в конфиге. |
| `logFile` | `~/.config/opencode/localai-discovery.log` | Путь к лог-файлу. `false` — писать только в stdout. |

### Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `LOCALAI_DEBUG` | — | Переопределяет путь к лог-файлу. |

## Проверка

```powershell
# Windows (PowerShell)
$env:LOCALAI_DEBUG="$PWD\localai-debug.log"; opencode run "reply with OK"
```

```bash
# Linux / macOS
LOCALAI_DEBUG="$PWD/localai-debug.log" opencode run "reply with OK"
```

В логе должна появиться строка:

```
[localai-discovery] discovered 10 model(s) from http://127.0.0.1:9932/v1/models:
  gemma4-26a4b-styletune-rp (ctx=65536), ... (ctx=51200)
[localai-discovery] inventory published
```

По умолчанию лог пишется в `~/.config/opencode/localai-discovery.log` —
это самый быстрый способ проверки, потому что `console.log` плагинов не
попадает в `opencode.log`.

Если моделей нет, проверь по порядку:

1. Лог: ищи `inventory NOT published` или `provider "localai" is not registered`.
2. Сервер отвечает: `curl http://127.0.0.1:9932/v1/models`.
3. В `opencode.json` ключ провайдера — именно `localai`, и в нём есть хотя бы
   одна модель (см. «Главные правила»).
4. Провайдер подключён: `opencode api get /api/provider` содержит `localai`.
   Если нет — выполни `/connect` в TUI и выбери **Local Host**.
5. Сервис перезапущен после правки конфига: `opencode service restart`.

## Тестирование

Отдельного набора автотестов в репозитории нет. Локальная проверка разбора
метаданных выполняется скриптом в `tmp/` (каталог не коммитится) на живых
данных `/v1/models`.

## Удаление

1. Убери запись плагина из `opencode.json` (при установке через CLI —
   `opencode plugin remove ...`).
2. Удали каталог `<config>/plugins/localai-discovery/`.
3. Верни в конфиг блок `models` у провайдера `LocalAI`.
4. Перезапусти сервис: `opencode service restart`.

## Ссылки

- [Документация OpenCode V2 — плагины](https://opencode.ai/v2/docs/build/plugins)
- [Конфигурация плагинов OpenCode V2](https://opencode.ai/v2/docs/plugins)
- [OpenCode V2](https://opencode.ai/v2/docs/)

## Лицензия

MIT — см. [LICENSE](LICENSE).