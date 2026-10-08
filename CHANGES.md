# Изменения (незакоммичено)

## 0.2.1 — починено обнаружение

- **Исправлено**: публикация инвентаря переведена с `ctx.provider.transform`
  (`editor.models.set`) на `ctx.model.transform` (`editor.update` +
  `editor.remove`). `ctx.provider.transform` работает только с каталогом
  models.dev и не видит кастомных провайдеров вообще.
- **Исправлено**: ID провайдера — `localai` строчными. С `LocalAI` провайдер
  не регистрировался (`ProviderNotFoundError`), поэтому не работал и плагин.
- **Новое**: лог по умолчанию пишется в
  `~/.config/opencode/localai-discovery.log` (`console.log` плагинов не
  попадает в `opencode.log`). Отключается опцией `logFile: false`.
- **Новое**: `draft.capabilities` / `draft.limit` дозаполняются, если
  `editor.update` создаёт модель с нуля.
- Документированы три главных правила: ID `localai`, обязательная
  bootstrap-модель, запрет явного `limit.context`.

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