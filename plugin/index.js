// LocalAI discovery for OpenCode V2 (workaround build).
//
// Background: on OpenCode 2.0.24 a *new* provider (whether declared in
// `providers` in opencode.json or added from a plugin via
// `ctx.provider.transform` -> `editor.add`) is registered but never becomes
// "available", so its models are not selectable ("Model unavailable").
// See INVESTIGATION.md for the full evidence.
//
// Working scheme, verified on 2.0.24: attach the local models to an already
// available catalog provider (default `opencode`). For each local model the
// plugin creates an *alias* model on that provider with:
//
//   * `modelID` set to a real catalog model of the host provider, so OpenCode
//     materialises the alias (a non-catalog modelID is dropped);
//   * model-level `settings.baseURL` pointing at the local server;
//   * `body.model` overriding the outgoing model name with the real local one;
//   * explicit `limit` / `capabilities` / `cost` (otherwise they are inherited
//     from the catalog base model and would be wrong).
//
// The alias is exposed as `<host>/<prefix><localModelID>` (e.g.
// `opencode/local-gemma4-26a4b-styletune-rp`).
//
// The list is re-read every `refreshMs` and published with
// `ctx.model.transform`, so switching models in llama-swap needs no OpenCode
// restart. No external dependencies, no network except the local server.

import { appendFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// Available catalog provider the local models are attached to.
const HOST_PROVIDER = "opencode"
// Catalog modelID used to materialise aliases. Must be a real model of the host
// provider; a free one keeps the alias enabled under opencode.models-disabler.
const BASE_MODEL = "big-pickle"
// Prefix that marks plugin-managed aliases on the host provider.
const ALIAS_PREFIX = "local-"

const FALLBACK_BASE_URL = "http://127.0.0.1:9931"
const REFRESH_MS = 30_000

const FALLBACK_CONTEXT = 32_768
const FALLBACK_OUTPUT = 8_192

// Local llama.cpp chat templates rarely implement OpenAI tool calling.
const TOOLS = false

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

// Turn one `/v1/models` entry into the descriptor captured by the transform.
function toDescriptor(entry, tools) {
  const id = String(entry.id ?? entry.model ?? entry.name)
  const modalities = readModalities(entry)
  return {
    id,
    modelID: id,
    name: id,
    limit: { context: readContext(entry), output: FALLBACK_OUTPUT },
    capabilities: { tools, input: modalities.input, output: modalities.output },
  }
}

export default {
  id: "localai.discovery",

  async setup(ctx) {
    const options = ctx.options ?? {}
    logFile = resolveLogFile(options)

    const host = typeof options.host === "string" && options.host ? options.host : HOST_PROVIDER
    const baseModel =
      typeof options.baseModel === "string" && options.baseModel ? options.baseModel : BASE_MODEL
    const prefix = typeof options.prefix === "string" && options.prefix ? options.prefix : ALIAS_PREFIX
    const tools = options.tools === true
    const refreshMs =
      Number.isFinite(options.refreshMs) && options.refreshMs > 0 ? Number(options.refreshMs) : REFRESH_MS
    const baseURL =
      typeof options.baseURL === "string" && options.baseURL ? options.baseURL : FALLBACK_BASE_URL

    // Captured by the transform; refreshed by the poll loop.
    let inventory = null
    let inventoryAliases = new Set()
    let signature = ""
    let published = 0

    let registration
    try {
      registration = await ctx.model.transform((editor) => {
        // Keep the last known aliases while the server is unreachable.
        if (!inventory) return

        // Drop aliases whose model disappeared from the local server.
        let existing = []
        try {
          existing = editor.list(host)
        } catch {
          // Host provider is not present in this location.
        }
        for (const model of existing) {
          const id = String(model?.id ?? "")
          if (id.startsWith(prefix) && !inventoryAliases.has(id)) {
            editor.remove(host, id)
            log(`removed stale alias ${host}/${id}`)
          }
        }

        published = 0
        for (const model of inventory) {
          const alias = prefix + model.id
          editor.update(host, alias, (draft) => {
            draft.modelID = baseModel
            draft.name = `Local: ${model.name}`
            // Redirect this model's endpoint to the local server.
            draft.settings = { ...(draft.settings ?? {}), baseURL: endpointUrl(baseURL) }
            // Rewrite the outgoing model name to the real local one.
            draft.body = { ...(draft.body ?? {}), model: model.modelID }
            draft.limit = { context: model.limit.context, output: model.limit.output }
            draft.capabilities = model.capabilities
            draft.cost = [{ input: 0, output: 0, cache: { read: 0, write: 0 } }]
            draft.variants = []
            draft.time = { released: 0 }
            draft.status = "active"
            draft.enabled = true
          })
          published += 1
        }
        log(`transform replay: published ${published} alias(es) on ${host}`)
      })
    } catch (error) {
      log(`could not register the model transform: ${error}`)
      return
    }

    const refresh = async () => {
      const entries = await fetchEntries(baseURL)
      const next = entries.map((entry) => toDescriptor(entry, tools)).sort((a, b) => a.id.localeCompare(b.id))

      const nextSignature = next.map((m) => `${m.id}:${m.limit.context}:${m.capabilities.tools}`).join("|")
      if (nextSignature === signature) return

      signature = nextSignature
      inventory = next
      inventoryAliases = new Set(next.map((m) => prefix + m.id))
      log(
        `discovered ${next.length} model(s) from ${modelsUrl(baseURL)}: ` +
          next.map((m) => `${m.id} (ctx=${m.limit.context})`).join(", "),
      )

      await ctx.model.reload()
      log(`published ${published} alias(es) as ${host}/${prefix}<model>`)
    }

    try {
      await refresh()
    } catch (error) {
      log(`initial discovery failed: ${error}`)
    }

    // Force one registry read so the transform runs even when nothing changed.
    try {
      await ctx.model.list()
    } catch (error) {
      log(`could not read the model registry: ${error}`)
    }

    const timer = setInterval(
      () => void refresh().catch((error) => log(`discovery failed: ${error}`)),
      refreshMs,
    )

    log(`watching ${baseURL} every ${refreshMs} ms (aliases on "${host}")`)

    return () => {
      clearInterval(timer)
      void registration.dispose()
    }
  },
}
