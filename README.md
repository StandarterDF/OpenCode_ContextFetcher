# OpenCode_ContextFetcher

> Плагин для OpenCode V2: динамически определяет контекст локального
> llama.cpp / llama-swap сервера и прописывает его в `limit.context` модели.

## Описание

OpenCode не умеет автоопределять контекст для кастомных
OpenAI-совместимых провайдеров, поэтому плагин читает `/v1/models`
(llama.cpp отдаёт `meta.n_ctx`) и обновляет лимит контекста модели прямо во
время работы.

**Возможности:**

- автоопределение `limit.context` для локального OpenAI-совместимого сервера
  (llama.cpp, llama-swap, vLLM, LM Studio);
- порядок источников контекста: `meta.n_ctx` → `context_length` →
  `max_model_len` → `meta.n_ctx_train` → `details.context_length`;
- периодическая перепроверка (по умолчанию раз в 30 секунд) и
  `ctx.model.reload()` при смене модели на сервере — без перезапуска OpenCode;
- без внешних зависимостей — чистый JS (только встроенные средства Node.js);
- необязательный отладочный лог через переменную окружения
  `LOCALAI_CONTEXT_DEBUG`.

## ⚠️ Главное правило

Если у модели в `opencode.json` **явно прописан `limit.context`**, он
**перебивает** плагин. Поэтому для моделей, которыми должен управлять плагин,
`limit` в конфиге нужно **не задавать**.

## Требования

- OpenCode **V2**.
- Node.js **18+** (нужен глобальный `fetch`; в OpenCode уже есть).
- Локальный OpenAI-совместимый сервер, отдающий список моделей с метаданными
  контекста (например, llama.cpp / llama-swap).
- Windows, Linux или macOS. Инструкции с `install.bat` — только для Windows,
  остальные способы кроссплатформенные.

## Структура

```
OpenCode_ContextFetcher/
├── opencode.json          # тестовый конфиг проекта (LocalAI + plugins:["./plugin"], без limit)
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

Способы ниже равнозначны — выбери любой. Для всех вариантов действует одно
правило: у управляемой модели `LocalAI/Qwen3-Coder` в `opencode.json` не
должно быть `limit.context`.

### Вариант 1. Автоматически, силами нейросети (рекомендуется)

Скопируй промт ниже и отправь его OpenCode. Агент сам скачает плагин,
установит его, поправит конфиг, перезапустит сервис и проверит результат.

```text
Установи мне плагин OpenCode V2 для автоопределения контекста из репозитория
https://github.com/StandarterDF/OpenCode_ContextFetcher (замени URL на свой форк,
если он у тебя другой).

Что нужно сделать:
1. Определи каталог глобального конфига OpenCode:
   - Windows: %USERPROFILE%\.config\opencode  (или %XDG_CONFIG_HOME%\opencode)
   - Linux/macOS: ~/.config/opencode  (или $XDG_CONFIG_HOME/opencode)
   Каталог глобальных плагинов — <config>/plugins/.
2. Установи плагин одним из способов (предпочтительно через CLI, он сам
   пропишет плагин в конфиг):
   - выполни: opencode plugin add github:StandarterDF/OpenCode_ContextFetcher#main::path:plugin
   - если CLI недоступен или репозиторий ещё не опубликован, скопируй содержимое
     папки plugin/ репозитория (файлы index.js и package.json) в
     <config>/plugins/localai-context/.
3. Открой глобальный <config>/opencode.json. Найди провайдера LocalAI и модель
   Qwen3-Coder. Убедись, что у модели НЕ задан "limit.context" (и вообще "limit").
   Если задан — удали его, иначе он перебьёт плагин.
4. Проверь, что baseURL провайдера LocalAI совпадает с твоим сервером. Если он
   отличается от http://192.168.0.124:8080/v1, поправь переменную
   FALLBACK_BASE_URL в <config>/plugins/localai-context/index.js (или оставь —
   плагин берёт baseURL из настроек провайдера, а fallback нужен только на случай
   недоступности конфига).
5. Перезапусти сервис: opencode service restart
6. Проверь работу: выставь переменную окружения LOCALAI_CONTEXT_DEBUG в путь к
   лог-файлу, выполни opencode run --agent build "reply with OK" и покажи мне
   строки из лога вида:
   [dynamic-context] detected Qwen3-Coder=...
   [dynamic-context] applied limit.context=... to LocalAI/Qwen3-Coder
   Если контекст не подхватился — продиагностируй причину и доведи установку до
   конца.

Действуй автономно, лишних вопросов не задавай. В конце кратко отчитайся: что
установил, какие файлы изменил, какой контекст определился.
```

### Вариант 2. Одной командой через CLI

Если репозиторий уже опубликован на GitHub:

```bash
opencode plugin add 'github:StandarterDF/OpenCode_ContextFetcher#main::path:plugin'
```

CLI сам скачает пакет, установит его и добавит запись в глобальный конфиг.
После этого не забудь удалить `limit.context` у модели и перезапустить сервис:

```bash
opencode service restart
```

### Вариант 3. Вручную (Windows)

Запусти из корня репозитория:

```bat
install.bat
```

Скрипт скопирует `plugin/` в
`%USERPROFILE%\.config\opencode\plugins\localai-context\`.

Вручную то же самое — просто скопировать два файла:

```
plugin\index.js       →  %USERPROFILE%\.config\opencode\plugins\localai-context\index.js
plugin\package.json   →  %USERPROFILE%\.config\opencode\plugins\localai-context\package.json
```

Для Linux / macOS глобальный путь — `~/.config/opencode/plugins/localai-context/`.

### Вариант 4. Только для одного проекта

Положи плагин в проект и подключи его проектной конфигурацией:

- создай `<project>/.opencode/plugins/localai-context/` с файлами `index.js` и
  `package.json` — OpenCode подхватит такой каталог автоматически;

  **или**

- положи каталог рядом и укажи его явно в `<project>/opencode.json`:

  ```jsonc
  {
    "$schema": "https://opencode.ai/config.json",
    "plugins": ["./plugin"]
  }
  ```

После установки удали `limit.context` у модели `LocalAI/Qwen3-Coder` и
перезапусти сервис: `opencode service restart`.

## Настройка

### Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `LOCALAI_CONTEXT_DEBUG` | — | Путь к файлу, куда пишется отладочный лог. Если не задана — лог идёт только в stdout. |

### Константы в `plugin/index.js`

| Константа | По умолчанию | Описание |
|---|---|---|
| `PROVIDER_ID` | `LocalAI` | ID провайдера в `opencode.json`. |
| `FALLBACK_BASE_URL` | `http://192.168.0.124:8080` | Используется, если baseURL не удалось прочитать из конфига провайдера. |
| `REFRESH_MS` | `30000` | Период перепроверки контекста, мс. |

## Проверка

Запусти OpenCode с включённым отладочным логом:

```bash
# Windows (PowerShell)
$env:LOCALAI_CONTEXT_DEBUG="$PWD\context-debug.log"; opencode run --agent build "reply with OK"

# Linux / macOS
LOCALAI_CONTEXT_DEBUG="$PWD/context-debug.log" opencode run --agent build "reply with OK"
```

В логе должны появиться строки:

```
[dynamic-context] detected Qwen3-Coder=163840
[dynamic-context] applied limit.context=163840 to LocalAI/Qwen3-Coder
```

Если строк нет, по порядку проверь:

1. `limit.context` у модели не задан (см. «Главное правило»).
2. `PROVIDER_ID` в `plugin/index.js` совпадает с ID провайдера в конфиге.
3. Сервер отвечает на `GET {baseURL}/v1/models` и в ответе есть контекст
   (`meta.n_ctx`, `context_length`, `max_model_len` и т.п.).
4. Плагин действительно загружен: при старте в логе OpenCode есть запись
   `[dynamic-context] ...`.

## Тестирование

Отдельного набора автотестов пока нет: плагин не содержит публичного API, а его
работа целиком зависит от внешнего локального сервера. Проверка выполняется
вручную по разделу «Проверка» — это интеграционная проверка «плагин ↔ сервер ↔
OpenCode».

Временные отладочные скрипты, если понадобятся, складывай в `tmp/` в корне
проекта (каталог не коммитится).

## Обновление

```bash
opencode plugin update            # обновить все плагины
opencode plugin update opencode-localai-dynamic-context
```

Для ручной установки (варианты 3–4) просто замени `index.js` на новую версию и
перезапусти сервис: `opencode service restart`.

## Удаление

1. Убери запись плагина из `opencode.json` (при установке через CLI —
   `opencode plugin remove ...`).
2. Удали каталог `<config>/plugins/localai-context/` (или
   `<project>/.opencode/plugins/localai-context/`).
3. Перезапусти сервис: `opencode service restart`.

## ВАЖНО

Временное решение. Когда в OpenCode вльют PR #27554 (local LAN provider
discovery + автоопределение контекста), плагин можно удалить.

## Ссылки

- [Документация OpenCode V2 — плагины](https://opencode.ai/v2/docs/build/plugins)
- [Конфигурация плагинов OpenCode V2](https://opencode.ai/v2/docs/plugins)
- [OpenCode V2](https://opencode.ai/v2/docs/)

## Лицензия

MIT — см. [LICENSE](LICENSE).
