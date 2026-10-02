# AGENTS.md — архитектура ContextAutodetect_OCV2

## Назначение

Плагин OpenCode V2, который динамически определяет размер контекстного окна
(`limit.context`) для кастомного OpenAI-совместимого провайдера `LocalAI`
(локальный llama.cpp / llama-swap).

OpenCode не автоопределяет контекст для таких провайдеров, поэтому плагин
опрашивает `/v1/models` и проставляет лимит через model-transform.

## Файлы

| Файл | Роль |
|---|---|
| `plugin/index.js` | Сам плагин. Экспортирует объект с `id` и `setup(ctx)`. Внешних зависимостей нет. |
| `plugin/package.json` | `"type": "module"` — обязательно, т.к. `index.js` использует ESM `import`. |
| `opencode.json` | Тестовый конфиг проекта: провайдер `LocalAI` + `"plugins": ["./plugin"]`. Без `limit`. |
| `install.bat` | Копирует `plugin/` в глобальный каталог плагинов OpenCode (Windows). |
| `README.md` | Описание, установка, промт для автоустановки нейросетью. |
| `CHANGES.md` | Незакоммиченные изменения. |
| `AGENTS.md` | Этот файл. |

## Точка входа

`plugin/index.js` экспортирует по умолчанию:

```js
export default {
  id: "localai.dynamic-context",
  async setup(ctx) { ... return cleanup }
}
```

OpenCode вызывает `setup(ctx)` при загрузке плагина. Возвращаемая функция
вызывается при выгрузке (в ней останавливается таймер).

## Поток данных

1. `setup(ctx)` пытается прочитать `baseURL` провайдера:
   `ctx.provider.get({ providerID: "LocalAI" })` →
   `provider.settings.baseURL`.
   Если провайдер ещё не зарегистрирован или поле пустое — используется
   константа `FALLBACK_BASE_URL`.
2. Регистрируется `ctx.model.transform(callback)`. Callback синхронный:
   перебирает модели провайдера и для каждой найденной в `contexts` модели
   делает `editor.update("LocalAI", model.id, draft => draft.limit.context = ...)`.
3. Выполняется первичный `refresh()`: `fetchContexts(baseURL)` →
   `GET {baseURL}/v1/models` → построение `Map<modelId, context>`.
4. Если карта контекстов изменилась — вызывается `ctx.model.reload()`.
   `reload()` переигрывает зарегистрированные transform'ы, поэтому
   `limit.context` применяется к моделям.
5. `setInterval` с периодом `REFRESH_MS` повторяет шаг 3–4. Так плагин
   подхватывает подмену модели на сервере без перезапуска OpenCode.

## Ключевые функции (`plugin/index.js`)

| Функция | Назначение |
|---|---|
| `readContext(model)` | Перебирает кандидатов `meta.n_ctx` → `context_length` → `max_model_len` → `meta.n_ctx_train` → `details.context_length`, возвращает первое положительное число. |
| `modelsUrl(baseURL)` | Собирает URL `/v1/models`, учитывая, что `baseURL` может уже содержать суффикс `/v1`. |
| `fetchContexts(baseURL)` | `GET /v1/models`, поддерживает ответы с `data[]` или `models[]`, возвращает `Map`. |
| `log(message)` | Пишет в `console.log` и (если задан `LOCALAI_CONTEXT_DEBUG`) в файл. |

## Настройки (константы в `plugin/index.js`)

| Константа | Значение | Смысл |
|---|---|---|
| `PROVIDER_ID` | `LocalAI` | ID провайдера в `opencode.json`. |
| `FALLBACK_BASE_URL` | `http://192.168.0.124:8080` | URL, если не удалось прочитать из конфига. |
| `REFRESH_MS` | `30000` | Период перепроверки, мс. |

## Переменные окружения

| Переменная | Назначение |
|---|---|
| `LOCALAI_CONTEXT_DEBUG` | Путь к файлу отладочного лога. Если не задана — лог только в stdout. |

## Внешние зависимости

Нет. Используются только встроенные средства Node.js: `node:fs`
(`appendFileSync`), глобальный `fetch` (нужен Node.js 18+), `setInterval`.

Со стороны OpenCode используются методы plugin-context:
`ctx.provider.get`, `ctx.model.transform`, `ctx.model.reload`.

## Архитектурное ограничение

Явно заданный в `opencode.json` `limit.context` **перебивает** transform
плагина. Для управляемых моделей `limit`/`limit.context` задавать нельзя.
Это проверено на практике и является главным правилом проекта.
