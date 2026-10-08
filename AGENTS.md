# AGENTS.md — архитектура OpenCode_LocalAI

## Назначение

Плагин OpenCode V2, который берёт список моделей с локального
OpenAI-совместимого сервера (llama.cpp / llama-swap) и делает их доступными в
OpenCode.

Задача: снять ручное перечисление моделей в `opencode.json` и подхватывать
смену моделей на сервере без перезапуска.

## Ключевое ограничение платформы

На OpenCode **2.0.24** отдельный (не-каталожный) провайдер зарегистрировать
нельзя. Проверено, что не работает ни один документированный путь:

- `providers.<new_id>` в `opencode.json` — парсится, но в реестр не попадает;
- `ctx.provider.transform` → `editor.add({info, models})` — попадает в реестр
  (`ctx.provider.list()` его видит), но провайдер никогда не становится
  активным (`GET /api/provider` его не показывает), поэтому модель не
  выбирается (`Model unavailable`);
- то же с `integrationID` существующей интеграции, с активным credential и с
  `sourceConnection`; поле `canonical` не помогает;
- встроенный discovery (Ollama/LM Studio/vLLM) опрашивает дефолтные порты, но
  тоже не активирует провайдера.

При этом **добавление моделей к уже активному каталожному провайдеру** через
`providers` и через `ctx.model.transform` → `editor.update(...)` работает.
Активны только провайдеры с рабочим подключением (`opencode`, `opencode-go`).

Полный лог проверок — в `INVESTIGATION.md`.

## Рабочая схема

Плагин прикрепляет локальные модели к активному провайдеру `host` (по
умолчанию `opencode`) как **алиасы** `<host>/<prefix><localID>`. Для каждого
алиаса через `editor.update(host, alias, draft => …)` задаются:

| Поле | Значение | Зачем |
|---|---|---|
| `modelID` | `options.baseModel` (`big-pickle`) | каталожный id, без него модель не материализуется |
| `settings.baseURL` | локальный сервер `/v1` | перенаправление запросов |
| `body.model` | реальный id на сервере | подмена имени модели в теле запроса |
| `limit` / `capabilities` | из `/v1/models` | корректный контекст и модальности |
| `cost` | `0/0` | алиас не отключается `opencode.models-disabler` |
| `enabled` / `status` | `true` / `active` | выбор в `/models` |

## Файлы

| Файл | Роль |
|---|---|
| `plugin/index.js` | Сам плагин. Экспортирует объект с `id` и `setup(ctx)`. Внешних зависимостей нет. |
| `plugin/package.json` | `"type": "module"` — обязательно, т.к. `index.js` использует ESM `import`. |
| `opencode.json` | Проектный конфиг (только `$schema`). Плагин подключается глобально. |
| `install.bat` | Копирует `plugin/` в глобальный каталог плагинов OpenCode (Windows) и удаляет устаревший `localai-context`. |
| `README.md` | Описание, установка, настройка, проверка. |
| `INVESTIGATION.md` | Лог расследования ограничения платформы. |
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

Возвращаемая функция останавливает таймер и делает `registration.dispose()`.

## Поток данных

1. `setup(ctx)` читает `ctx.options` (`host`, `baseModel`, `prefix`, `tools`,
   `refreshMs`, `baseURL`, `logFile`).
2. Регистрируется `ctx.model.transform(callback)`. Callback синхронный и
   повторяемый: удаляет устаревшие алиасы (`id.startsWith(prefix)` и нет в
   текущем инвентаре) и через `editor.update(host, alias, …)` создаёт/обновляет
   алиасы из уже загруженного `inventory`.
3. `refresh()`: `GET {baseURL}/v1/models` → `toDescriptor()` для каждой записи
   → сортировка по id → сравнение сигнатуры (`id:context:tools`).
4. Если сигнатура изменилась — `inventory` и `inventoryAliases` перезаписываются,
   вызывается `await ctx.model.reload()` (переигрывает transform).
5. `setInterval(refreshMs)` повторяет шаг 3.

## Ключевые функции (`plugin/index.js`)

| Функция | Назначение |
|---|---|
| `log(message)` | Пишет в `console.log` и (если задан `LOCALAI_DEBUG`) в файл. |
| `endpointUrl(baseURL)` | Нормализует адрес до суффикса `/v1`. |
| `modelsUrl(baseURL)` | Собирает URL `/v1/models`. |
| `fetchEntries(baseURL)` | `GET /v1/models`, поддерживает `data[]` и `models[]`. |
| `argValue(args, names)` | Флаг из `status.args` (llama-swap): `--ctx-size 65536` / `--ctx-size=65536`. |
| `presetValue(preset, keys)` | `key = число` из `status.preset`. |
| `readContext(entry)` | Контекст: поля API → `status.args` → `status.preset` → fallback. |
| `readModalities(entry)` | `capabilities.input/output` из `architecture.input_modalities`. |
| `toDescriptor(entry, tools)` | Лёгкий дескриптор модели для transform (id, limit, capabilities). |

## Настройки (константы в `plugin/index.js`)

| Константа | Значение | Смысл |
|---|---|---|
| `HOST_PROVIDER` | `opencode` | Активный провайдер-носитель алиасов. |
| `BASE_MODEL` | `big-pickle` | Каталожный `modelID` для материализации алиасов. |
| `ALIAS_PREFIX` | `local-` | Префикс алиасов. |
| `FALLBACK_BASE_URL` | `http://127.0.0.1:9931` | Адрес сервера по умолчанию. |
| `REFRESH_MS` | `30000` | Период опроса `/v1/models`. |
| `FALLBACK_CONTEXT` | `32768` | Контекст, если сервер не сообщил размер. |
| `FALLBACK_OUTPUT` | `8192` | Лимит ответа. |
| `TOOLS` | `false` | Tool calling выключен по умолчанию. |

## Переменные окружения

| Переменная | Назначение |
|---|---|
| `LOCALAI_DEBUG` | Путь к файлу отладочного лога. |

## Внешние зависимости

Нет. Только Node.js (`node:fs`, `node:os`, `node:path`, глобальный `fetch`,
`setInterval`) и plugin-context OpenCode: `ctx.options`, `ctx.model.transform`,
`ctx.model.reload`, `ctx.model.list`.

## Архитектурные ограничения

- Схема зависит от наличия активного каталожного провайдера (`host`). Если
  сменить `host`, он обязан быть активным, и его `baseModel` — существующим.
- Плагин трогает только модели хоста с префиксом `prefix`; чужие не изменяет.
- Алиасы наследуют контекст/возможности базовой модели, если не переопределены;
  плагин всегда проставляет `limit` и `capabilities` явно.
- `opencode.models-disabler` совместим: алиасы дешевые (`cost 0/0`) и потому
  остаются включёнными. Если `unknown: "disable"` (по умолчанию) и у алиаса не
  было бы `cost`, он был бы отключён — поэтому `cost` обязателен.
