# AGENTS.md — архитектура OpenCode_LocalAI

## Назначение

Плагин OpenCode V2, который берёт список моделей с локального
OpenAI-совместимого сервера (llama.cpp / llama-swap) и публикует его в реестр
провайдера `LocalAI` через `ctx.provider.transform`.

Задача: снять ручное перечисление моделей в `opencode.json` и подхватывать
смену моделей на сервере без перезапуска.

Ранее плагин назывался `localai.dynamic-context` (репозиторий
OpenCode_ContextFetcher) и только прописывал `limit.context` для моделей,
описанных в конфиге. Теперь он сам создаёт модели.

## Файлы

| Файл | Роль |
|---|---|
| `plugin/index.js` | Сам плагин. Экспортирует объект с `id` и `setup(ctx)`. Внешних зависимостей нет. |
| `plugin/package.json` | `"type": "module"` — обязательно, т.к. `index.js` использует ESM `import`. |
| `opencode.json` | Проектный конфиг (только `$schema`). Плагин здесь намеренно **не** подключается, чтобы не дублировать глобальную установку. |
| `install.bat` | Копирует `plugin/` в глобальный каталог плагинов OpenCode (Windows) и удаляет устаревший `localai-context`. |
| `README.md` | Описание, установка, настройка, проверка. |
| `CHANGES.md` | Незакоммиченные изменения. |
| `AGENTS.md` | Этот файл. |
| `LICENSE` | MIT. |

## Точка входа

```js
export default {
  id: "localai.discovery",
  async setup(ctx) { ... return cleanup }
}
```

Возвращаемая функция останавливает таймер опроса.

## Поток данных

1. `setup(ctx)` читает `ctx.options` (`provider`, `tools`, `refreshMs`,
   `baseURL`) и определяет адрес сервера: сначала пробует
   `ctx.provider.get({ providerID })` → `provider.settings.baseURL`, иначе
   `FALLBACK_BASE_URL`.
2. Регистрируется `ctx.provider.transform(callback)`. Callback синхронный: он
   **не делает сетевых запросов**, а публикует уже загруженный `inventory`
   через `editor.models.set(providerID, inventory)`. Если провайдера нет в
   `editor.list()` — ничего не делает.
3. `refresh()`: `fetchEntries(baseURL)` → `GET {baseURL}/v1/models` →
   `toModelInfo()` для каждой записи → сортировка по id → сравнение с
   предыдущей сигнатурой (`id:context:tools` через `|`).
4. Если сигнатура изменилась — `inventory` перезаписывается, пишется лог,
   вызывается `await ctx.provider.reload()`, который переигрывает transform.
5. `setInterval(refreshMs)` повторяет шаг 3, поэтому смена моделей в
   llama-swap подхватывается без перезапуска OpenCode.

## Ключевые функции (`plugin/index.js`)

| Функция | Назначение |
|---|---|
| `log(message)` | Пишет в `console.log` и (если задан `LOCALAI_DEBUG`) в файл. |
| `modelsUrl(baseURL)` | Собирает URL `/v1/models`, учитывая, что `baseURL` может уже содержать суффикс `/v1`. |
| `fetchEntries(baseURL)` | `GET /v1/models`, поддерживает `data[]` и `models[]`, отбрасывает записи без id. |
| `argValue(args, names)` | Ищет значение флага в массиве `status.args` (llama-swap): `--ctx-size 65536` и `--ctx-size=65536`. |
| `presetValue(preset, keys)` | Ищет `key = число` в тексте preset-файла `status.preset`. |
| `readContext(entry)` | Контекст: `context_length` → `max_model_len` → `meta.n_ctx` → `meta.n_ctx_train` → `details.context_length` → `status.args` → `status.preset` → `FALLBACK_CONTEXT`. |
| `readModalities(entry)` | `capabilities.input/output` из `architecture.input_modalities/output_modalities`, иначе `["text"]`. |
| `toModelInfo(entry, providerID, tools)` | Собирает объект `Model.Info` по схеме OpenCode V2 API. |

## Важное: схема Model.Info

`Model.Info` в схеме объявлен с `additionalProperties: false`, а набор
обязательных полей фиксирован:

`id`, `modelID`, `providerID`, `name`, `capabilities`, `variants`, `time`,
`cost`, `status`, `enabled`, `limit`.

Поэтому `toModelInfo()` собирает объект целиком, а не «частично»:

- `capabilities` = `{ tools, input, output }` — без лишних полей;
- `cost` = массив тиров, каждый `{ input, output, cache: { read, write } }`;
- `time` = `{ released }`;
- `limit` = `{ context, output }`.

Плагин намеренно **не импортирует** `@opencode/plugin`: импорт `Model`/
`Provider` там недоступен на диске, а собственный объект проверен тестом
(`tmp/test-discovery.mjs`) на соответствие схеме.

## Настройки (константы в `plugin/index.js`)

| Константа | Значение | Смысл |
|---|---|---|
| `PROVIDER_ID` | `LocalAI` | ID провайдера. |
| `FALLBACK_BASE_URL` | `http://127.0.0.1:9932` | Адрес, если не удалось прочитать из конфига. |
| `REFRESH_MS` | `30000` | Период перечитывания `/v1/models`, мс. |
| `FALLBACK_CONTEXT` | `32768` | Контекст, если сервер не сообщил размер. |
| `FALLBACK_OUTPUT` | `8192` | Лимит ответа. |
| `TOOLS` | `false` | Tool calling выключен по умолчанию. |

## Переменные окружения

| Переменная | Назначение |
|---|---|
| `LOCALAI_DEBUG` | Путь к файлу отладочного лога. Если не задана — лог только в stdout. |

## Внешние зависимости

Нет. Используются только встроенные средства Node.js: `node:fs`
(`appendFileSync`), глобальный `fetch`, `setInterval`. Со стороны OpenCode:
`ctx.options`, `ctx.provider.get`, `ctx.provider.transform`,
`ctx.provider.reload`.

## Архитектурные ограничения

- Явно заданный в `opencode.json` `limit.context` **перебивает** публикуемый
  плагином инвентарь. Блок `models` у `LocalAI` следует удалить.
- Плагин не трогает другие провайдеры: `editor.models.set()` вызывается
  только для `providerID` из настроек.
- Плагин не удаляет и не подменяет настройки провайдера — только его список
  моделей.
- Встроенное автообнаружение OpenCode покрывает только Ollama, LM Studio и
  vLLM; для llama-swap нужен этот плагин (подробности в `README.md`).