// LocalAI discovery for OpenCode V2.
//
// Custom OpenAI-compatible providers (llama.cpp, llama-swap, LM Studio, vLLM)
// are not auto-discovered by OpenCode: built-in discovery only covers Ollama,
// LM Studio and vLLM runtimes, and every other "Compatible" provider must list
// its models in opencode.json by hand.
//
// This plugin removes that manual step for the configured provider: it reads
// `<baseURL>/v1/models` and publishes the returned inventory through the
// provider registry, so OpenCode shows whatever the local server currently
// serves. Model metadata that llama-swap exposes in `status.args` /
// `status.preset` is used for `limit.context`.
//
// IMPORTANT: an explicit `limit.context` in opencode.json wins over the
// inventory published here. Remove such overrides so the plugin can control
// the limit.
//
// The transform is re-run through ctx.provider.reload() whenever the inventory
// changes, so switching models in llama-swap needs no restart.

import { appendFileSync } from "node:fs"

const PROVIDER_ID = "LocalAI"
const FALLBACK_BASE_URL = "http://127.0.0.1:9932"
const REFRESH_MS = 30_000

// Used when the server does not report a context size.
const FALLBACK_CONTEXT = 32_768
const FALLBACK_OUTPUT = 8_192

// Local llama.cpp chat templates rarely implement OpenAI tool calling, so
// discovered models start with tools off. Set `tools: true` in plugin options
// if your template does support it.
const TOOLS = false

// Optional debug log file. Set LOCALAI_DEBUG to a path to enable.
const DEBUG_LOG = process.env.LOCALAI_DEBUG

function log(message) {
  console.log(`[localai-discovery] ${message}`)
  if (!DEBUG_LOG) return
  try {
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // Ignore debug write failures.
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

// Model.Info (see OpenCode V2 API schema). Fields are kept complete and exact:
// Model.Info forbids extra properties.
function toModelInfo(entry, providerID, tools) {
  const id = String(entry.id ?? entry.model ?? entry.name)
  const created = Number(entry.created)
  const capabilities = readModalities(entry)

  return {
    id,
    modelID: id,
    providerID,
    name: id,
    capabilities: { tools, input: capabilities.input, output: capabilities.output },
    variants: [],
    time: { released: Number.isFinite(created) && created > 0 ? Math.floor(created * 1000) : 0 },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    status: "active",
    enabled: true,
    limit: { context: readContext(entry), output: FALLBACK_OUTPUT },
  }
}

export default {
  id: "localai.discovery",

  async setup(ctx) {
    const options = ctx.options ?? {}

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
    } catch {
      // Provider is not registered yet; keep the configured fallback.
    }

    // Captured by the transform below; refreshed by the poll loop.
    let inventory = null
    let signature = ""

    await ctx.provider.transform((editor) => {
      if (!inventory) return
      const known = editor.list().some((record) => record.provider.id === providerID)
      if (!known) return
      editor.models.set(providerID, inventory)
    })

    const refresh = async () => {
      const entries = await fetchEntries(baseURL)
      const next = entries.map((entry) => toModelInfo(entry, providerID, tools))
      next.sort((a, b) => a.id.localeCompare(b.id))

      const nextSignature = next
        .map((model) => `${model.id}:${model.limit.context}:${model.capabilities.tools}`)
        .join("|")
      if (nextSignature === signature) return

      signature = nextSignature
      inventory = next
      log(
        `discovered ${next.length} model(s) from ${modelsUrl(baseURL)}: ` +
          next.map((model) => `${model.id} (ctx=${model.limit.context})`).join(", "),
      )
      await ctx.provider.reload()
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