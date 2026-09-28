#!/usr/bin/env node
/**
 * End-to-end smoke test against a real opencode installation.
 *
 * The plugin API is undocumented and the published typings do not describe the
 * runtime, so unit tests alone cannot prove that models reach the wire. This
 * script closes that gap:
 *
 *   - it serves a fake Command Code Provider API (`/models`, `/chat/completions`
 *     and `/messages`) on localhost;
 *   - it asks a real opencode to run this plugin against it;
 *   - it asserts what opencode actually sent: the URL (which proves the adapter
 *     was chosen per protocol), the wire model id, and the forwarded credential.
 *
 * Two details matter for the harness to be reliable:
 *
 *   - the child inherits stdin. Observed against opencode 2.0.18: an open
 *     input pipe makes `opencode run` wait for input forever, while a closed
 *     or EOF-terminated stdin makes it silently skip local plugins. Inheriting
 *     the parent's stdin is the only variant that works in both a terminal and
 *     a CI shell.
 *   - arguments are quoted into a single command string, because `spawn` with
 *     `shell: true` only concatenates them and never escapes.
 *
 * `XDG_DATA_HOME` points at a throwaway directory so the credential store of
 * whoever runs the test cannot leak in.
 *
 * Usage: `npm run smoke` (exits 0 with a note when opencode is absent).
 */

import { spawn } from "node:child_process"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), "..")
const API_KEY = "smoke-test-key"
const RUN_TIMEOUT_MS = 90_000

interface RecordedRequest {
  method: string
  path: string
  credential: string | undefined
  model: string | undefined
  /** The reasoning payload, normalised per protocol. */
  reasoning: Record<string, unknown>
  /** Top-level body keys, for diagnosing a missing payload. */
  bodyKeys: string[]
}

const recorded: RecordedRequest[] = []

const MODELS = [
  {
    id: "deepseek/deepseek-v4-flash",
    object: "model",
    name: "DeepSeek V4 Flash (latest)",
    context_length: 1_000_000,
    supported_endpoints: ["/chat/completions"],
  },
  {
    id: "claude-haiku-4-5-20251001",
    object: "model",
    name: "Claude Haiku 4.5",
    context_length: 200_000,
    supported_endpoints: ["/messages"],
  },
  {
    id: "claude-sonnet-5",
    object: "model",
    name: "Claude Sonnet 5",
    context_length: 1_000_000,
    supported_endpoints: ["/messages"],
  },
]

function writeEvents(res: ServerResponse, events: readonly (readonly [string, unknown])[]): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  for (const [event, payload] of events) {
    if (event.length > 0) res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
  }
  res.end()
}

/** Minimal but valid OpenAI chat-completions stream. */
function openAiStream(res: ServerResponse, model: string, text: string): void {
  const chunk = (delta: unknown, finish: string | null): unknown => ({
    id: "chatcmpl-smoke",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  res.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: text }, null))}\n\n`)
  res.write(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`)
  res.write("data: [DONE]\n\n")
  res.end()
}

/** Minimal but valid Anthropic Messages stream. */
function anthropicStream(res: ServerResponse, model: string, text: string): void {
  writeEvents(res, [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_smoke",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
    ],
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ])
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = ""
    request.on("data", (chunk) => (body += chunk))
    request.on("end", () => resolve(body))
  })
}

async function startMockServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    void (async () => {
      const raw = await readBody(request)
      let body: Record<string, unknown> = {}
      try {
        body = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {}
      } catch {
        body = {}
      }

      const path = request.url ?? "/"
      const bearer = request.headers.authorization
      const apiKeyHeader = request.headers["x-api-key"]
      const isMessages = path.endsWith("/messages")
      // Every spelling any provider adapter might use for the reasoning level.
      const reasoning: Record<string, unknown> = {
        thinking: body.thinking,
        output_config: body.output_config,
        reasoningConfig: body.reasoningConfig,
        reasoning: body.reasoning,
        reasoning_effort: body.reasoning_effort,
      }
      recorded.push({
        method: request.method ?? "GET",
        path,
        credential:
          typeof bearer === "string" ? bearer : typeof apiKeyHeader === "string" ? `x-api-key ${apiKeyHeader}` : undefined,
        model: typeof body.model === "string" ? body.model : undefined,
        reasoning,
        bodyKeys: Object.keys(body).sort(),
      })

      if (path.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ object: "list", data: MODELS }))
        return
      }

      const model = typeof body.model === "string" ? body.model : "unknown"
      if (path.endsWith("/messages")) anthropicStream(response, model, "PONG")
      else openAiStream(response, model, "PONG")
    })()
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("mock server did not bind a port")

  return {
    port: address.port,
    close: async () => {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** Windows separators are hostile inside JSON config and env values. */
function toPosixPath(path: string): string {
  return path.replaceAll("\\", "/")
}

interface RunResult {
  code: number | null
  output: string
}

/** Runs a JSON-returning opencode subcommand and parses its stdout. */
async function runOpencodeJson<T>(
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ value: T | undefined; output: string }> {
  const result = await runOpencode(args, options)
  const start = result.output.indexOf("{")
  if (start === -1) return { value: undefined, output: result.output }
  try {
    return { value: JSON.parse(result.output.slice(start)) as T, output: result.output }
  } catch {
    return { value: undefined, output: result.output }
  }
}

/** `spawn` with `shell: true` concatenates arguments, so quoting is up to us. */
function quoteArguments(argv: readonly string[]): string {
  return argv
    .map((argument) => (/\s|"/.test(argument) ? `"${argument.replaceAll('"', '\\"')}"` : argument))
    .join(" ")
}

function runOpencode(args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(`opencode ${quoteArguments(args)}`, {
      cwd: options.cwd,
      env: options.env,
      shell: true,
      // Inherited stdin: an open pipe hangs `opencode run`, and a closed one
      // makes it skip local plugins entirely.
      stdio: ["inherit", "pipe", "pipe"],
    })

    let output = ""
    child.stdout?.on("data", (chunk) => (output += chunk))
    child.stderr?.on("data", (chunk) => (output += chunk))

    const finish = (code: number | null): void => {
      clearTimeout(timer)
      resolve({ code, output })
    }
    const timer = setTimeout(() => {
      // `shell: true` means the child is a shell; kill the whole tree.
      if (process.platform === "win32" && child.pid !== undefined) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
      } else {
        child.kill("SIGKILL")
      }
      finish(null)
    }, RUN_TIMEOUT_MS)

    child.on("error", (error) => finish(-1))
    child.on("close", (code) => finish(code))
  })
}

function opencodeAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("opencode --version", { shell: true, stdio: ["ignore", "pipe", "ignore"] })
    const timer = setTimeout(() => {
      child.kill()
      resolve(false)
    }, 20_000)
    child.on("error", () => {
      clearTimeout(timer)
      resolve(false)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  })
}

interface Expectation {
  label: string
  modelKey: string
  /** Selected reasoning level, passed to opencode as a model variant. */
  variant?: string
  wireModel: string
  pathSuffix: string
  /** Anthropic clients authenticate with `x-api-key`, not a bearer token. */
  credential: string
  /** Keys that must be present in the outgoing body, compared recursively. */
  expectedReasoning?: Record<string, unknown>
}

const EXPECTATIONS: readonly Expectation[] = [
  {
    label: "OpenAI protocol",
    modelKey: "deepseek-v4-flash",
    wireModel: "deepseek/deepseek-v4-flash",
    pathSuffix: "/chat/completions",
    credential: `Bearer ${API_KEY}`,
  },
  {
    label: "OpenAI protocol at reasoning level `high`",
    modelKey: "deepseek-v4-flash",
    variant: "high",
    wireModel: "deepseek/deepseek-v4-flash",
    pathSuffix: "/chat/completions",
    credential: `Bearer ${API_KEY}`,
    expectedReasoning: { reasoning_effort: "high" },
  },
  {
    label: "Anthropic protocol",
    modelKey: "claude-haiku-4-5-20251001",
    wireModel: "claude-haiku-4-5-20251001",
    pathSuffix: "/messages",
    credential: `x-api-key ${API_KEY}`,
  },
  {
    label: "Anthropic protocol at reasoning level `high`",
    modelKey: "claude-sonnet-5",
    variant: "high",
    wireModel: "claude-sonnet-5",
    pathSuffix: "/messages",
    credential: `x-api-key ${API_KEY}`,
    expectedReasoning: {
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
    },
  },
]

/**
 * Reports every key of `expected` that `actual` does not carry.
 *
 * Extra keys in `actual` are ignored on purpose: the request body also holds
 * messages, tools and sampling parameters that this test does not own.
 */
function differences(actual: unknown, expected: unknown, path = "body"): string[] {
  if (expected === null || typeof expected !== "object") {
    return JSON.stringify(actual) === JSON.stringify(expected)
      ? []
      : [`${path} was ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`]
  }
  const record = (typeof actual === "object" && actual !== null ? actual : {}) as Record<string, unknown>
  return Object.entries(expected as Record<string, unknown>).flatMap(([key, value]) =>
    differences(record[key], value, `${path}.${key}`),
  )
}

async function main(): Promise<number> {
  if (!(await opencodeAvailable())) {
    console.log("smoke: opencode is not on PATH, skipping")
    return 0
  }

  const server = await startMockServer()
  const projectDir = mkdtempSync(join(tmpdir(), "commandcode-smoke-"))
  const dataDir = mkdtempSync(join(tmpdir(), "commandcode-smoke-data-"))
  // The plugin must be loaded exactly once. A developer machine usually has a
  // global opencode.json that already points at this plugin, and loading it
  // twice breaks model registration, so the global config is isolated too.
  const configDir = mkdtempSync(join(tmpdir(), "commandcode-smoke-config-"))

  writeFileSync(
    join(projectDir, "opencode.json"),
    `${JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: [REPO_DIR] }, null, 2)}\n`,
  )

  // opencode derives its location from `PWD` when it is present, not from the
  // process working directory. Leaving the inherited value in place makes it
  // look for the project config in the wrong directory, so point it at the
  // throwaway project.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PWD: projectDir,
    COMMANDCODE_API_KEY: API_KEY,
    COMMANDCODE_API_BASE: `http://127.0.0.1:${server.port}`,
    COMMANDCODE_MODELS_CACHE: toPosixPath(join(projectDir, "models-cache.json")),
    // Force a live fetch, and keep a real CLI login from shadowing the test key.
    COMMANDCODE_MODELS_TTL_MS: "1",
    COMMANDCODE_AUTH_FILE: "0",
    // Isolate opencode's credential store and its global config.
    XDG_DATA_HOME: dataDir,
    XDG_CONFIG_HOME: configDir,
  }
  delete env.INIT_CWD

  let failures = 0

  try {
    for (const expectation of EXPECTATIONS) {
      const reference = `commandcode/${expectation.modelKey}${expectation.variant === undefined ? "" : `#${expectation.variant}`}`
      console.log(`→ ${expectation.label}: running opencode with ${reference}`)
      const before = recorded.length
      const result = await runOpencode(
        [
          "run",
          "--standalone",
          "--print-logs",
          "--log-level",
          "info",
          "--model",
          reference,
          "reply with exactly: PONG",
        ],
        { cwd: projectDir, env },
      )

      const seen = recorded.slice(before)
      const request = seen.find((entry) => entry.path.endsWith(expectation.pathSuffix))
      const problems: string[] = []

      if (!result.output.includes("PONG")) {
        problems.push(`opencode did not print the reply (exit ${result.code})`)
      }
      if (!request) {
        problems.push(`no request reached ${expectation.pathSuffix} (saw ${seen.map((e) => e.path).join(", ") || "none"})`)
      } else {
        if (request.model !== expectation.wireModel) {
          problems.push(`wire model was ${JSON.stringify(request.model)}, expected ${expectation.wireModel}`)
        }
        if (request.credential !== expectation.credential) {
          problems.push(`credential was ${JSON.stringify(request.credential)}, expected ${expectation.credential}`)
        }
        if (expectation.expectedReasoning !== undefined) {
          const mismatch = differences(request.reasoning, expectation.expectedReasoning)
          problems.push(...mismatch)
          if (mismatch.length > 0) {
            problems.push(`body keys were ${request.bodyKeys.join(", ")}`)
            problems.push(`reasoning payload was ${JSON.stringify(request.reasoning)}`)
          }
        }
      }

      if (problems.length === 0) {
        const reasoning =
          expectation.expectedReasoning === undefined ? "" : ` + ${JSON.stringify(expectation.expectedReasoning)}`
        console.log(`✔ ${expectation.label}: ${expectation.pathSuffix} ← ${expectation.wireModel}${reasoning}`)
        continue
      }

      failures += 1
      console.error(`✖ ${expectation.label}`)
      for (const problem of problems) console.error(`    ${problem}`)
      if (result.output.length > 0) {
        console.error(`    opencode output:\n${result.output.split("\n").slice(-12).join("\n")}`)
      }
    }

    // The slash command is the only way to refresh the catalog without a
    // restart, so it is worth proving against a real host: the cache is made
    // fresh first, so any fetch during this phase can only come from the
    // command itself. `opencode run` does not parse slash commands, so the
    // command is invoked through the documented HTTP API.
    const warm = { ...env, COMMANDCODE_MODELS_TTL_MS: "3600000" }
    const beforeCommand = recorded.filter((entry) => entry.path.endsWith("/models")).length
    const created = await runOpencodeJson<{ data?: { id?: string } }>(
      ["api", "--standalone", "--data", "{}", "session.create"],
      { cwd: projectDir, env: warm },
    )
    const sessionID = created.value?.data?.id
    if (sessionID === undefined) {
      failures += 1
      console.error(`✖ refresh command: could not create a session
${created.output.slice(-400)}`)
    } else {
      const invoked = await runOpencode(
        [
          "api",
          "--standalone",
          "--data",
          JSON.stringify({ name: "commandcode-refresh", text: "" }),
          "--param",
          `sessionID=${sessionID}`,
          "session.command",
        ],
        { cwd: projectDir, env: warm },
      )
      const refetches = recorded.filter((entry) => entry.path.endsWith("/models")).length - beforeCommand
      if (invoked.code !== 0) {
        failures += 1
        console.error(`✖ refresh command: opencode exited ${invoked.code}
${invoked.output.slice(-400)}`)
      } else if (refetches < 1) {
        failures += 1
        console.error("✖ refresh command: the catalog was not fetched again (a fresh cache should not be reused)")
      } else {
        console.log(`✔ refresh command: re-fetched the catalog ${refetches}× and asked opencode to reload`)
      }
    }

    const catalogFetches = recorded.filter((entry) => entry.path.endsWith("/models"))
    if (catalogFetches.length === 0) {
      failures += 1
      console.error("✖ the live catalog was never fetched")
    } else {
      console.log(`✔ catalog: fetched ${catalogFetches.length}× from the Provider API`)
    }
  } finally {
    await server.close()
    rmSync(projectDir, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(configDir, { recursive: true, force: true })
  }

  if (failures > 0) {
    console.error(`\nsmoke: ${failures} expectation(s) failed`)
    return 1
  }
  console.log("\nsmoke: ok")
  return 0
}

process.exitCode = await main()
