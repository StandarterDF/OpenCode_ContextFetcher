# Изменения (незакоммичено)

## 0.2.0 — репозиторий переименован в OpenCode_LocalAI

- Плагин переименован: `localai.dynamic-context` → `localai.discovery`
  (`opencode-localai-discovery`, глобальный каталог `localai-discovery`).
- **Новое**: плагин публикует список моделей сам через
  `ctx.provider.transform` → `editor.models.set(...)`, больше не требует
  перечисления моделей в `opencode.json`.
- **Новое**: `limit.context` берётся из `status.args` (`--ctx-size`) и
  `status.preset` llama-swap, если сервер не отдаёт `context_length` и т.п.
- **Новое**: `capabilities.input/output` из `architecture.input_modalities`.
- **Новое**: список сортируется по id; при неизменном списке `reload()`
  не вызывается.
- Значения по умолчанию переведены на `http://127.0.0.1:9932`
  (llama-swap-роутер); `0.0.0.0` убран — по нему нельзя ходить как клиенту.
- Переменная окружения `LOCALAI_CONTEXT_DEBUG` → `LOCALAI_DEBUG`.
- Проектный `opencode.json` больше не подключает плагин локально.

## 0.1.0

- Первая версия: определение `limit.context` для локального
  OpenAI-совместимого сервера (`localai.dynamic-context`).