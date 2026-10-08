# Investigation log — local provider not registerable in OpenCode V2

**Date:** 2026-10-08
**OpenCode:** `v2.0.24` (Windows, `C:\nvm4w\nodejs\node_modules\@opencode\cli`)
**Goal:** make a local `llama-swap` (llama.cpp) router usable as a model provider,
and auto-pull its model list.

**Verdict:** on this build a non-catalog provider cannot be registered by any of the
documented means. Verified six independent ways. Not caused by plugins, not caused
by configuration, not fixable by an upgrade (2.0.24 is the latest stable release).

---

## 1. Environment facts

| Item | Value |
|---|---|
| OpenCode version | `2.0.24` (npm `latest` for `@opencode/cli`) |
| Server URL | `http://127.0.0.1:49374` |
| API auth | HTTP Basic, user `opencode`, password from `%USERPROFILE%\.config\opencode\service.json` |
| Config dir | `%USERPROFILE%\.config\opencode` |
| Log file | `%USERPROFILE%\.local\share\opencode\log\opencode.log` |
| Router | llama-swap, `http://127.0.0.1:9932` |

### Router endpoints

```
/health             -> HTTP 200
/v1/models          -> HTTP 200
/props              -> HTTP 200
/api/v1/models      -> HTTP 404
/api/tags           -> HTTP 404
```

### Router `/v1/models` — 10 models

```
gemma4-26a4b-styletune-rp            owned_by=llamacpp  ctx=65536  reasoning=off
gemma4-26a4b-styletune-rp-think      owned_by=llamacpp  ctx=65536  reasoning=on
gemma4-31b-blume-v1                  owned_by=llamacpp  ctx=51200  reasoning=off
gemma4-31b-blume-v1-think            owned_by=llamacpp  ctx=51200  reasoning=on
gemma4-31b-dark-thoughts             owned_by=llamacpp  ctx=51200  reasoning=off
gemma4-31b-dark-thoughts-think       owned_by=llamacpp  ctx=51200  reasoning=on
gemma4-31b-glistening                owned_by=llamacpp  ctx=51200  reasoning=off
gemma4-31b-glistening-think          owned_by=llamacpp  ctx=51200  reasoning=on
gemma4-31b-schattenblume             owned_by=llamacpp  ctx=51200  reasoning=off
gemma4-31b-schattenblume-think       owned_by=llamacpp  ctx=51200  reasoning=on
```

Context size is exposed only as a server flag in `status.args`
(`--ctx-size 65536`), and in `status.preset` (`ctx-size = 65536`).

### Original (broken) configuration

```jsonc
"providers": {
  "LocalAI": {
    "name": "Local Host",
    "package": "aisdk:@ai-sdk/openai-compatible",
    "settings": { "baseURL": "http://192.168.0.124:8080/v1", "apiKey": "sk-LocalAPI_Key" },
    "models": { "Qwen3-Coder": { ... } }
  }
}
```

Two problems visible on sight: `aisdk:@ai-sdk/openai-compatible` is not a V2
package name, and the ID `LocalAI` has uppercase letters.

---

## 2. Attempt log

| # | Attempt | Result |
|---|---|---|
| 1 | Fix `package` -> `@opencode/ai/providers/openai-compatible` | provider still absent |
| 2 | Add bootstrap model (catalog requires >= 1 model) | still absent |
| 3 | Add `"activation": "enabled"` | field dropped on read; still absent |
| 4 | Rename provider ID `LocalAI` -> `localai` | still absent |
| 5 | Connect credential: `POST /api/integration/localai/connect/key` | credential created, `active=True`, still absent |
| 6 | Plugin publishes models via `ctx.provider.transform` -> `editor.models.set` | `editor.get("localai")` returns `undefined`; `editor.list()` contains only the models.dev catalog |
| 7 | Plugin publishes via `ctx.model.transform` -> `editor.update` | provider has no model candidates, nothing to update |
| 8 | Plugin registers provider: `editor.add({ info, models })` | executes without error, provider still not listed |
| 9 | Add `integrationID: "localai"` + default `apiKey` to the added provider | still not listed |
| 10 | Catalog provider `vllm` with `baseURL` -> router | still not listed |
| 11 | Connect credential for `lmstudio` | credential created, still not listed |
| 12 | Shim: expose router as LM Studio (`/api/v1/models`) + point `lmstudio` at it | **zero HTTP requests reached the shim** |
| 13 | Disable both plugins, keep config provider | still absent (control: model count changed 15 -> 44, so disabling worked) |

---

## 3. Key evidence

### 3.1 `ctx.provider.transform` only exposes the models.dev catalog

Diagnostic written to a file from inside the transform callback:

```
setup: providerID=LocalAI baseURL=http://127.0.0.1:9932 tools=false
transform: editor ids=["deepinfra","perplexity-agent","bailing","poe",...,"opencode-go","lmstudio",...,"opencode",...]
transform: get(LocalAI) -> undefined
transform: provider absent, skip models.set
```

`localai` is **not** in that list, although it exists as an *integration*
(`/api/integration/localai` returns it with `connections: []` at the time).

### 3.2 The config is read, but produces no provider

`GET /api/config` returns the loaded config documents:

```
--- C:\Users\DefaultDF\.config\opencode\opencode.json
providers: {"localai":{"name":"Local Host","package":"@opencode/ai/providers/openai-compatible",
           "settings":{"baseURL":"http://127.0.0.1:9932/v1","apiKey":"sk-LocalAPI_Key"},
           "models":{"discovery-seed":{"name":"discovery seed"}}}}
```

Yet the provider is absent from the registry:

```
GET /api/provider              -> opencode-go, opencode
GET /api/provider/localai      -> {"_tag":"ProviderNotFoundError","message":"Provider not found: localai"}  (HTTP 404)
opencode run --model localai/discovery-seed
                              -> Error: Model unavailable: localai/discovery-seed
```

### 3.3 A credential is not enough

```
GET /api/credential
id=cred_0f9f5cbbf001MBIT0BFWrY4Iyd  integration=opencode  label=Default      active=True
id=cred_11a7ed2cd001ANmiVg9qeW9vpt  integration=localai   label=local llama-swap active=True
```

Both active, only `opencode` providers visible.

### 3.4 Discovery never probes — decisive

`evidence/lmstudio-shim.mjs` served the router in LM Studio shape (and logged
every inbound request). With it configured:

```
opencode api get /api/model | Select-String lmstudio     -> (empty)

# private server, full startup cycle
opencode run --standalone --model lmstudio/gemma4-31b-blume-v1 "hi"
  -> Error: Model unavailable: lmstudio/gemma4-31b-blume-v1

shim request log:
  NO REQUESTS REACHED THE SHIM
```

Discovery does not run at all, even though both `/health` and `/v1/models`
answer `200` on the router. This is not a "found nothing" result — no probe was
ever issued.

### 3.5 Plugins are not the cause

Config `"plugins": ["-localai.discovery", "-opencode.models-disabler"]` with
`providers.localai` present in config:

```
PROVIDERS: opencode-go, opencode
total models: 44   (opencode-go=30, opencode=14)   <- disabling had an effect
```

Still no `localai`. Plugins enabled again afterwards: model count returned to 15.

### 3.6 Not fixable by upgrading

npm `@opencode/cli`:

```
latest: 2.0.24
last stable: 2.0.17 ... 2.0.24
```

Installed == latest.

---

## 4. What the documentation promises vs. what happens

Documented behaviour (V2 providers guide):

- "Add a provider when its API is not already in the catalog" via a `providers`
  entry with `package` + `settings.baseURL` + `models`.
- Built-in discovery for Ollama (`/api/tags`), LM Studio (`/api/v1/models`) and
  vLLM (`/health` + `/v1/models`).
- Plugin API: `ctx.provider.transform` -> `editor.add({ info, models })` for
  account-specific discovery; `editor.models.set(providerID, models)` to replace
  a provider's source inventory.

Observed on 2.0.24:

- A `providers` entry for a non-catalog provider is parsed but never
  materialized.
- No discovery probe is issued, even when the endpoint answers correctly.
- `editor.add()` succeeds but the provider never becomes available.

Note: `https://opencode.ai/config.json` serves a **V1** schema (fields `npm`,
`api`, `options`, `whitelist`, `blacklist`) and must not be used to infer V2
config shapes.

---

## 5. Side notes discovered along the way

- Provider/model IDs are case-sensitive: the built-in local integration is
  `localai` (lowercase), so `LocalAI/...` references never resolve.
- `opencode api --standalone` / `opencode run --standalone` only accept
  `--standalone` **after** the subcommand.
- `--data` with inline JSON is mangled by the `opencode.ps1` wrapper on Windows
  (quoted argument is re-parsed). Use `Invoke-RestMethod` against the server URL
  with Basic auth instead.
- Plugin `console.log` output does **not** appear in `opencode.log`; a file-based
  log is the only reliable way to see plugin diagnostics.
- Config reloads are automatic, but **provider materialization and discovery run
  at startup**. Testing provider changes by editing config and waiting is invalid
  for this class of provider.
- `opencode.models-disabler` works correctly on this build (15 models: free ones
  plus the three allowlisted Go models), because it operates on catalog providers
  that are available.

---

## 6. Cleanup performed

- Shim process stopped, probe directory `oc-probe` deleted, trace files removed.
- Global `opencode.json`: `providers` and the `plugins` disable list removed.
- Credentials created during testing (`localai`, `lmstudio`) deleted.
- Backups kept in `%USERPROFILE%\.config\opencode\`:
  `opencode.json.bak-modelsdisabler`, `.bak-before-policies-removal`,
  `.bak-before-port`, `.bak-before-discovery`.

---

## 7. Reproduction (for a bug report)

1. Start a llama-swap router on `127.0.0.1:9932` (or any OpenAI-compatible
   server) serving `/v1/models`.
2. In `%USERPROFILE%\.config\opencode\opencode.json` add:

   ```jsonc
   "providers": {
     "localai": {
       "name": "Local Host",
       "package": "@opencode/ai/providers/openai-compatible",
       "settings": { "baseURL": "http://127.0.0.1:9932/v1", "apiKey": "local" },
       "models": { "any-model": { "name": "any model" } }
     }
   }
   ```

3. `opencode service restart`
4. `opencode api get /api/provider` — expected `localai`, observed absent.
5. `opencode api get /api/model` — expected the declared model, observed absent.

A second reproduction without any config, via a plugin:

1. Plugin calls `ctx.provider.transform(editor => editor.add({ info, models }))`.
2. The callback runs without error (logged from inside it).
3. `opencode api get /api/provider` — provider still absent.