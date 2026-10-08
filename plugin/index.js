// LocalAI discovery for OpenCode V2.
//
// Custom OpenAI-compatible providers (llama.cpp, llama-swap, LM Studio, vLLM)
// are not auto-discovered by OpenCode: built-in discovery only covers Ollama,
// LM Studio and vLLM runtimes, and every other "Compatible" provider must list
// its models in opencode.json by hand.
//
// This plugin removes that manual step: it reads `<baseURL>/v1/models` and
// publishes the returned inventory through the model transform, so OpenCode
// shows whatever the local server currently serves. Model metadata that
// llama-swap exposes in `status.args` / `status.preset` is used for
// `limit.context`.
//
// IMPORTANT 1: the provider ID in opencode.json must match the provider's
// catalog/integration ID. The built-in local provider is `localai`
// (lowercase). A custom ID such as `LocalAI` never registers.
//
// IMPORTANT 2: a custom provider needs at least one model entry in opencode.json
// to register at all, so keep a single bootstrap model there. The plugin
// replaces the rest of the inventory.
//
// The transform is re-run through ctx.model.reload() whenever the inventory
// changes, so switching models in llama-swap needs no restart.

import { appendFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// Built-in local provider ID (matches the `localai` integration).
const PROVIDER_ID = "localai"
const FALLBACK_BASE_URL = "http://127.0.0.1:9932"
const REFRESH_MS = 30_000

// Used when the server does not report a context size.
const FALLBACK_CONTEXT = 32_768
const FALLBACK_OUTPUT = 8_192

// Local llama.cpp chat templates rarely implement OpenAI tool calling, so
// discovered models start with tools off. Set `tools: true` in plugin options
// if your template does support it.
const TOOLS = false

// Log file: LOCALAI_DEBUG overrides the path, pass logFile: false to disable.
const DEFAULT_LOG_FILE = join(homedir(), ".config", "opencode", "localai-discovery.log")

function resolveLogFile(options) {
  if (options?.logFile === false) return undefined
  if (typeof process.env.LOCALAI_DEBUG === "string" && process.env.LOCALAI_DEBUG) {
    return process.env.LOCALAI_DEBUG
  }
  return DEFAULT_LOG_FILE
}

let logFile

function log(message) {
  const line = `[localai-discovery] ${message}`
  console.log(line)
  if (!logFile) return
  try {
    appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // Ignore log write failures.
  }
}

function modelsUrl(baseURL) {
  const base = String(baseURL).replace(/\/+$/, "")
  return base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`
}

async function fetchEntries(baseURL) {
  const url = modelsUrl(baseURL)
  const response = await fetch(url, { headers: { Accept: "application/json" } })
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`)

  const body = await response.json()
  const entries = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : []
  return entries.filter((entry) => typeof (entry?.id ?? entry?.model ?? entry?.name) === "string")
}

// llama-swap/llama.cpp report the context size only as a server flag.
function argValue(args, names) {
  if (!Array.isArray(args)) return undefined
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i])
    for (const name of names) {
      if (arg === name) {
        const value = Number(args[i + 1])
        if (Number.isFinite(value)) return value
      }
      if (arg.startsWith(`${name}=`)) {
        const value = Number(arg.slice(name.length + 1))
        if (Number.isFinite(value)) return value
      }
    }
  }
  return undefined
}

function presetValue(preset, keys) {
  if (typeof preset !== "string") return undefined
  for (const key of keys) {
    const match = new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*(\\d+)`, "i").exec(preset)
    if (!match) continue
    const value = Number(match[1])
    if (Number.isFinite(value)) return value
  }
  return undefined
}

// Order: explicit API metadata, then llama-swap server args, then preset file,
// then the fallback.
function readContext(entry) {
  const candidates = [
    entry?.context_length,
    entry?.max_model_len,
    entry?.meta?.n_ctx,
    entry?.meta?.n_ctx_train,
    entry?.details?.context_length,
  ]
  for (const value of candidates) {
    const context = Number(value)
    if (Number.isFinite(context) && context > 0) return Math.floor(context)
  }

  const fromArgs = argValue(entry?.status?.args, ["--ctx-size", "-c", "--ctx"])
  if (fromArgs) return Math.floor(fromArgs)

  const fromPreset = presetValue(entry?.status?.preset, ["ctx-size", "ctx_size", "n_ctx"])
  if (fromPreset) return Math.floor(fromPreset)

  return FALLBACK_CONTEXT
}

function readModalities(entry) {
  const architecture = entry?.architecture ?? {}
  return {
    input: Array.isArray(architecture.input_modalities) && architecture.input_modalities.length
      ? architecture.input_modalities
      : ["text"],
    output: Array.isArray(architecture.output_modalities) && architecture.output_modalities.length
      ? architecture.output_modalities
      : ["text"],
  }
}

function toModel(entry, tools) {
  const id = String(entry.id ?? entry.model ?? entry.name)
  const capabilities = readModalities(entry)
  return {
    id,
    name: id,
    tools,
    input: capabilities.input,
    output: capabilities.output,
    context: readContext(entry),
  }
}

export default {
  id: "localai.discovery",

  async setup(ctx) {
    const options = ctx.options ?? {}
    logFile = resolveLogFile(options)

    const providerID =
      typeof options.provider === "string" && options.provider ? options.provider : PROVIDER_ID
    const tools = options.tools === true
    const refreshMs =
      Number.isFinite(options.refreshMs) && options.refreshMs > 0 ? Number(options.refreshMs) : REFRESH_MS

    let baseURL = typeof options.baseURL === "string" && options.baseURL ? options.baseURL : FALLBACK_BASE_URL
    try {
      const provider = await ctx.provider.get({ providerID })
      const configured = provider?.settings?.baseURL ?? provider?.provider?.settings?.baseURL
      if (typeof configured === "string" && configured) baseURL = configured
      else log(`provider "${providerID}" found but settings.baseURL is empty; using ${baseURL}`)
    } catch {
      log(
        `provider "${providerID}" is not registered (check that opencode.json declares ` +
          `"providers": { "${providerID}": ... } with a model entry); using ${baseURL}`,
      )
    }

    // Captured by the transform; refreshed by the poll loop.
    let inventory = null
    let signature = ""
    let published = false

    await ctx.model.transform((editor) => {
      if (!inventory) return

      const existing = editor.list(providerID)
      if (existing.length === 0) {
        log(`provider "${providerID}" has no models available yet; inventory not published`)
        return
      }

      for (const model of inventory) {
        editor.update(providerID, model.id, (draft) => {
          draft.name = model.name
          // `update` may create the model, and the draft is not guaranteed to
          // carry every nested object, so build them defensively.
          if (!draft.capabilities || typeof draft.capabilities !== "object") {
            draft.capabilities = { tools: model.tools, input: [], output: [] }
          }
          if (!draft.limit || typeof draft.limit !== "object") {
            draft.limit = { context: model.context, output: FALLBACK_OUTPUT }
          }
          draft.capabilities.tools = model.tools
          draft.capabilities.input = model.input
          draft.capabilities.output = model.output
          draft.limit.context = model.context
          draft.limit.output = FALLBACK_OUTPUT
        })
      }

      // Drop models the server no longer serves (including the bootstrap entry).
      const wanted = new Set(inventory.map((model) => model.id))
      for (const model of existing) {
        if (!wanted.has(model.id)) editor.remove(providerID, model.id)
      }

      published = true
    })

    const refresh = async () => {
      const entries = await fetchEntries(baseURL)
      const next = entries.map((entry) => toModel(entry, tools)).sort((a, b) => a.id.localeCompare(b.id))

      const nextSignature = next.map((model) => `${model.id}:${model.context}:${model.tools}`).join("|")
      if (nextSignature === signature) return

      signature = nextSignature
      inventory = next
      log(
        `discovered ${next.length} model(s) from ${modelsUrl(baseURL)}: ` +
          next.map((model) => `${model.id} (ctx=${model.context})`).join(", "),
      )
      published = false
      await ctx.model.reload()
      log(published ? "inventory published" : "inventory NOT published (provider unavailable)")
    }

    try {
      await refresh()
    } catch (error) {
      log(`initial discovery failed: ${error}`)
    }

    const timer = setInterval(
      () => void refresh().catch((error) => log(`discovery failed: ${error}`)),
      refreshMs,
    )

    return () => clearInterval(timer)
  },
}