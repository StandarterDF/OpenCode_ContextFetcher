// Evidence artifact for INVESTIGATION.md — attempt #12.
//
// Exposes a llama-swap (llama.cpp) router through the LM Studio REST shape so
// that OpenCode's built-in LM Studio discovery can consume it, and logs every
// inbound request.
//
// Outcome on OpenCode v2.0.24: the shim received ZERO requests, i.e. discovery
// never probed the endpoint. Not a "found nothing" result.
//
// Usage:
//   node evidence/lmstudio-shim.mjs
//   # then point a provider at it:
//   #   "providers": { "lmstudio": { "settings": { "baseURL": "http://127.0.0.1:9933/v1" } } }
//   # and check the trace:
//   Get-Content shim-trace.log

import { createServer } from "node:http"
import { appendFileSync } from "node:fs"

const UPSTREAM = { host: "127.0.0.1", port: 9932 }
const PORT = 9933
const TRACE = process.env.SHIM_TRACE || "shim-trace.log"

function trace(line) {
  try {
    appendFileSync(TRACE, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

function readContext(entry) {
  const args = Array.isArray(entry?.status?.args) ? entry.status.args : []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--ctx-size") {
      const value = Number(args[i + 1])
      if (Number.isFinite(value)) return value
    }
  }
  const preset = entry?.status?.preset
  if (typeof preset === "string") {
    const match = /(?:^|\n)\s*ctx-size\s*=\s*(\d+)/i.exec(preset)
    if (match) return Number(match[1])
  }
  return 0
}

createServer(async (req, res) => {
  trace(`${req.method} ${req.url}`)

  // OpenCode derives the native discovery path from settings.baseURL, which may
  // already end in /v1 — so the models endpoint must answer at /models,
  // /v1/models, /api/v1/models and /v1/api/v1/models alike.
  const path = (req.url ?? "").split("?")[0]
  const isModels = req.method === "GET" && /models\/?$/.test(path)

  if (isModels) {
    try {
      const upstream = await fetch(`http://${UPSTREAM.host}:${UPSTREAM.port}/v1/models`)
      const body = await upstream.json()
      const models = (body.data ?? []).map((m) => ({
        id: m.id,
        object: "model",
        type: "llm",
        owned_by: "organization",
        state: "loaded",
        max_length: readContext(m),
      }))
      const payload = JSON.stringify({ object: "list", data: models })
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      })
      res.end(payload)
    } catch (error) {
      res.writeHead(502, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: String(error) }))
    }
    return
  }

  // Proxy everything else to the upstream router unchanged.
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = chunks.length ? Buffer.concat(chunks) : undefined

  const headers = { ...req.headers }
  delete headers.host
  delete headers["content-length"]

  try {
    const upstream = await fetch(`http://${UPSTREAM.host}:${UPSTREAM.port}${req.url}`, {
      method: req.method,
      headers,
      body,
      duplex: "half",
    })
    const payload = Buffer.from(await upstream.arrayBuffer())
    const out = {}
    upstream.headers.forEach((value, key) => {
      if (key !== "content-encoding" && key !== "transfer-encoding") out[key] = value
    })
    res.writeHead(upstream.status, out)
    res.end(payload)
  } catch (error) {
    res.writeHead(502, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: String(error) }))
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`shim listening on http://127.0.0.1:${PORT} -> ${UPSTREAM.host}:${UPSTREAM.port}`)
})