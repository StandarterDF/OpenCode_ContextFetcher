# Изменения (незакоммичено)

## 0.3.0 — журнал расследования, плагин признан неработающим

- Добавлен `INVESTIGATION.md`: полный лог попыток, сырые ответы API,
  доказательства и шаги воспроизведения для issue.
- Добавлен `evidence/lmstudio-shim.mjs` — шим-конвертер в формат LM Studio, на
  котором доказано, что discovery не делает ни одного запроса.
- В README добавлено предупреждение: на OpenCode v2.0.24 плагин не работает.
- Временный каталог `tmp/` удалён.

## 0.2.2 — плагин регистрирует провайдера сам

- **Исправлено (главное)**: кастомный провайдер **не создаётся** из
  `opencode.json` и не входит в каталог models.dev, поэтому ни одна опция
  конфига его не поднимала. Теперь плагин добавляет провайдера целиком через
  `ctx.provider.transform` → `editor.add({ info, models })`.
- `editor.models.set()` оставлен как fallback на случай, если провайдер уже
  зарегистрирован (например, появится в будущей версии OpenCode).
- Блок `providers.localai` удалён из глобального `opencode.json`: плагин —
  единственный источник правды.
- `baseURL` нормализуется до `.../v1` — рантайм требует суффикс.
- Подключён credential интеграции `localai` (через `/api/integration/localai`).
- Документировано: `/connect` → Local Host больше не обязателен.

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