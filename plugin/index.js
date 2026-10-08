// LocalAI discovery for OpenCode V2.
//
// A local llama.cpp / llama-swap server behind an OpenAI-compatible endpoint is
// NOT created by OpenCode from opencode.json, and it is not part of the
// models.dev catalog either — so it never appears in /api/provider or /models,
// no matter how it is declared.
//
// This plugin registers that provider itself: it reads `<baseURL>/v1/models`
// and publishes both the provider and its models through
// `ctx.provider.transform` -> `editor.add({ info, models })`. It then re-reads
// the inventory on a timer and calls `ctx.provider.reload()` when it changes,
// so switching models in llama-swap needs no restart of OpenCode.
//
// Metadata that llama-swap exposes in `status.args` / `status.preset` is used
// for `limit.context`.

import { appendFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const PROVIDER_ID = "localai"
const PROVIDER_NAME = "Local Host"
const PROVIDER_PACKAGE = "@opencode/ai/providers/openai-compatible"
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

// The OpenAI-compatible runtime expects the endpoint to include /v1.
function endpointUrl(baseURL) {
  const base = String(baseURL).replace(/\/+$/, "")
  return base.endsWith("/v1") ? base : `${base}/v1`
}

function modelsUrl(baseURL) {
  return `${endpointUrl(baseURL)}/models`
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

// Model.Info per the OpenCode V2 API schema. The schema forbids extra
// properties, so the object is built complete rather than partially.
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
    logFile = resolveLogFile(options)

    const providerID =
      typeof options.provider === "string" && options.provider ? options.provider : PROVIDER_ID
    const providerName =
      typeof options.name === "string" && options.name ? options.name : PROVIDER_NAME
    const tools = options.tools === true
    const refreshMs =
      Number.isFinite(options.refreshMs) && options.refreshMs > 0 ? Number(options.refreshMs) : REFRESH_MS
    const apiKey = typeof options.apiKey === "string" && options.apiKey ? options.apiKey : undefined

    let baseURL = typeof options.baseURL === "string" && options.baseURL ? options.baseURL : FALLBACK_BASE_URL

    // If the provider is already registered (previous run), prefer the endpoint
    // from its settings so config and plugin cannot drift apart.
    try {
      const provider = await ctx.provider.get({ providerID })
      const configured = provider?.settings?.baseURL ?? provider?.provider?.settings?.baseURL
      if (typeof configured === "string" && configured) baseURL = configured
    } catch {
      // Not registered yet — the plugin registers it below.
    }

    // Captured by the transform; refreshed by the poll loop.
    let inventory = null
    let signature = ""
    let published = false

    const providerInfo = {
      id: providerID,
      name: providerName,
      activation: "enabled",
      package: PROVIDER_PACKAGE,
      settings: apiKey ? { baseURL: endpointUrl(baseURL), apiKey } : { baseURL: endpointUrl(baseURL) },
    }

    await ctx.provider.transform((editor) => {
      if (!inventory) return
      const known = editor.list().some((record) => (record?.provider?.id ?? record?.id) === providerID)
      if (known) editor.models.set(providerID, inventory)
      else editor.add({ info: providerInfo, models: inventory })
      published = true
    })

    const refresh = async () => {
      const entries = await fetchEntries(baseURL)
      const next = entries
        .map((entry) => toModelInfo(entry, providerID, tools))
        .sort((a, b) => a.id.localeCompare(b.id))

      const nextSignature = next.map((model) => `${model.id}:${model.limit.context}`).join("|")
      if (nextSignature === signature) return

      signature = nextSignature
      inventory = next
      log(
        `discovered ${next.length} model(s) from ${modelsUrl(baseURL)}: ` +
          next.map((model) => `${model.id} (ctx=${model.limit.context})`).join(", "),
      )

      published = false
      await ctx.provider.reload()
      log(published ? "provider published" : "provider NOT published")
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

    log(`watching ${baseURL} every ${refreshMs} ms (provider "${providerID}")`)

    return () => clearInterval(timer)
  },
}