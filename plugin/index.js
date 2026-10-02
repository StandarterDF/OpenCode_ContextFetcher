// Dynamic context detection for a local llama.cpp / llama-swap server.
//
// OpenCode does not auto-detect the context window for custom
// OpenAI-compatible providers, so this plugin reads the server's
// /v1/models metadata (llama.cpp exposes `meta.n_ctx`) and updates the
// model's `limit.context` through the model transform.
//
// IMPORTANT: an explicit `limit.context` in opencode.json wins over this
// transform. Leave `limit.context` unset for the provider/model so the
// plugin can control it.

import { appendFileSync } from "node:fs"

const PROVIDER_ID = "LocalAI"
const FALLBACK_BASE_URL = "http://192.168.0.124:8080"
const REFRESH_MS = 30_000

// Optional debug log file. Set LOCALAI_CONTEXT_DEBUG to a path to enable.
const DEBUG_LOG = process.env.LOCALAI_CONTEXT_DEBUG

function log(message) {
  console.log(`[dynamic-context] ${message}`)
  if (!DEBUG_LOG) return
  try {
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // Ignore debug write failures.
  }
}

function readContext(model) {
  // llama.cpp: meta.n_ctx (runtime) / meta.n_ctx_train (trained).
  // llama-swap: context_length. vLLM-style: max_model_len. LM Studio: details.
  const candidates = [
    model?.meta?.n_ctx,
    model?.context_length,
    model?.max_model_len,
    model?.meta?.n_ctx_train,
    model?.details?.context_length,
  ]
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.floor(value)
    }
  }
  return undefined
}

function modelsUrl(baseURL) {
  const base = String(baseURL).replace(/\/+$/, "")
  // baseURL may already include the /v1 suffix (e.g. http://host:8080/v1).
  return base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`
}

async function fetchContexts(baseURL) {
  const response = await fetch(modelsUrl(baseURL), {
    headers: { Accept: "application/json" },
  })
  if (!response.ok) throw new Error(`GET ${modelsUrl(baseURL)} -> ${response.status}`)

  const body = await response.json()
  const entries = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body?.models)
      ? body.models
      : []

  const result = new Map()
  for (const entry of entries) {
    const id = entry?.id ?? entry?.model ?? entry?.name
    const context = readContext(entry)
    if (typeof id === "string" && context) result.set(id, context)
  }
  return result
}

export default {
  id: "localai.dynamic-context",

  async setup(ctx) {
    let baseURL = FALLBACK_BASE_URL
    try {
      const provider = await ctx.provider.get({ providerID: PROVIDER_ID })
      const configured =
        provider?.settings?.baseURL ?? provider?.provider?.settings?.baseURL
      if (typeof configured === "string" && configured) baseURL = configured
    } catch {
      // Provider is not registered yet; keep the fallback and retry on refresh.
    }

    let contexts = new Map()

    const refresh = async () => {
      const next = await fetchContexts(baseURL)

      let changed = next.size !== contexts.size
      if (!changed) {
        for (const [id, value] of next) {
          if (contexts.get(id) !== value) {
            changed = true
            break
          }
        }
      }
      if (!changed) return

      contexts = next
      log(`detected ${[...contexts].map(([id, value]) => `${id}=${value}`).join(", ")}`)
      await ctx.model.reload()
    }

    // Register the transform first; the initial refresh below calls
    // ctx.model.reload(), which replays it with the loaded contexts.
    await ctx.model.transform((editor) => {
      const models = editor.list(PROVIDER_ID)
      for (const model of models) {
        const context = contexts.get(model.id)
        if (!context) continue
        editor.update(PROVIDER_ID, model.id, (draft) => {
          draft.limit.context = context
        })
        log(`applied limit.context=${context} to ${PROVIDER_ID}/${model.id}`)
      }
    })

    try {
      await refresh()
    } catch (error) {
      log(`initial refresh failed: ${error}`)
    }

    const timer = setInterval(
      () => void refresh().catch((error) => log(`refresh failed: ${error}`)),
      REFRESH_MS,
    )

    return () => clearInterval(timer)
  },
}
