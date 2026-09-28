/**
 * Drives the plugin's `setup` through a fake opencode host.
 *
 * This is the closest thing to the real contract that runs without an install:
 * it proves what the plugin registers (provider, models, credential methods,
 * slash command) and that the refresh command republishes through
 * `provider.reload()` and reports back into the session.
 *
 * The fake drafts are deliberately strict — `add` throws when the provider is
 * already there — so a non-idempotent registration fails the test rather than
 * quietly duplicating the catalog.
 */

import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import plugin from "../plugin.ts"
import type {
  CommandDefinition,
  CommandDraft,
  IntegrationDraft,
  IntegrationMethod,
  IntegrationRef,
  ModelInfo,
  PluginContext,
  ProviderDraft,
  ProviderInfo,
  ProviderRecord,
  Registration,
} from "../src/opencode-api.ts"

const MODELS_URL = "http://catalog.test/provider/v1/models"

class FakeProviderDraft implements ProviderDraft {
  records = new Map<string, ProviderRecord>()
  reloads = 0
  /** Registered transform callbacks, replayed on reload like the real host. */
  readonly callbacks: ((draft: ProviderDraft) => void)[] = []

  list(): readonly ProviderRecord[] {
    return [...this.records.values()]
  }

  get(providerID: string): ProviderRecord | undefined {
    return this.records.get(providerID)
  }

  add(input: { info: ProviderInfo; models: readonly ModelInfo[] }): void {
    if (this.records.has(input.info.id)) {
      throw new Error(`provider ${input.info.id} is already registered`)
    }
    this.records.set(input.info.id, {
      provider: input.info,
      models: new Map(input.models.map((model) => [model.id, model])),
    })
  }

  update(providerID: string, update: (provider: ProviderInfo) => void): void {
    const record = this.records.get(providerID)
    if (!record) throw new Error(`unknown provider ${providerID}`)
    update(record.provider)
  }

  remove(providerID: string): void {
    this.records.delete(providerID)
  }

  readonly models = {
    set: (providerID: string, models: readonly ModelInfo[]): void => {
      const record = this.records.get(providerID)
      if (!record) throw new Error(`unknown provider ${providerID}`)
      record.models = new Map(models.map((model) => [model.id, model]))
    },
    update: (providerID: string, modelID: string, update: (model: ModelInfo) => void): void => {
      const record = this.records.get(providerID)
      if (!record) throw new Error(`unknown provider ${providerID}`)
      const model = record.models.get(modelID)
      if (!model) throw new Error(`unknown model ${modelID}`)
      update(model)
    },
    remove: (providerID: string, modelID: string): void => {
      this.records.get(providerID)?.models.delete(modelID)
    },
  }
}

class FakeIntegrationDraft implements IntegrationDraft {
  readonly refs = new Map<string, IntegrationRef>()
  readonly methods = new Map<string, IntegrationMethod[]>()

  list(): readonly IntegrationRef[] {
    return [...this.refs.values()]
  }

  get(integrationID: string): IntegrationRef | undefined {
    return this.refs.get(integrationID)
  }

  update(integrationID: string, update: (integration: IntegrationRef) => void): void {
    const existing = this.refs.get(integrationID) ?? { id: integrationID, name: integrationID }
    update(existing)
    this.refs.set(integrationID, existing)
  }

  remove(integrationID: string): void {
    this.refs.delete(integrationID)
  }

  readonly method = {
    list: (integrationID: string): readonly IntegrationMethod[] => this.methods.get(integrationID) ?? [],
    update: (input: { integrationID: string; method: IntegrationMethod }): void => {
      const existing = this.methods.get(input.integrationID) ?? []
      existing.push(input.method)
      this.methods.set(input.integrationID, existing)
    },
    remove: (integrationID: string, method: IntegrationMethod): void => {
      const existing = this.methods.get(integrationID) ?? []
      this.methods.set(
        integrationID,
        existing.filter((entry) => entry !== method),
      )
    },
  }
}

interface FakeHost {
  context: PluginContext
  providerDraft: FakeProviderDraft
  integrationDraft: FakeIntegrationDraft
  commands: CommandDefinition[]
  notices: string[]
  /** Catalog URLs the plugin requested, in order. */
  requests: string[]
}

function createHost(cachePath: string): FakeHost {
  const providerDraft = new FakeProviderDraft()
  const integrationDraft = new FakeIntegrationDraft()
  const commands: CommandDefinition[] = []
  const notices: string[] = []
  const requests: string[] = []
  const registration: Registration = { dispose: async () => undefined }
  const commandDraft: CommandDraft = { add: (definition) => commands.push(definition) }

  const context: PluginContext = {
    options: { modelsUrl: MODELS_URL, cachePath, ttlMs: 1, authFileFallback: false },
    provider: {
      transform: async (callback) => {
        callback(providerDraft)
        providerDraft.callbacks.push(callback)
        return registration
      },
      reload: async () => {
        providerDraft.reloads += 1
        // opencode rebuilds the registry by replaying every active transform
        // onto a fresh value, so the fake must do the same.
        providerDraft.records = new Map()
        for (const callback of providerDraft.callbacks) callback(providerDraft)
      },
    },
    integration: {
      transform: async (callback) => {
        callback(integrationDraft)
        return registration
      },
    },
    command: {
      transform: async (callback) => {
        callback(commandDraft)
        return registration
      },
    },
    session: {
      synthetic: async (input) => {
        notices.push(input.text)
      },
    },
    model: {
      // Reads back what the draft published, like the real host does.
      list: async () => ({ data: [...providerDraft.records.values()].flatMap((r) => [...r.models.values()]) }),
    },
  }

  return { context, providerDraft, integrationDraft, commands, notices, requests }
}

/** Installs a stub fetch and returns a restore function. */
function stubFetch(
  handler: (url: string) => unknown,
  requests: string[],
): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests.push(String(input))
    return new Response(JSON.stringify(handler(String(input))), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

function catalog(ids: readonly string[]): unknown {
  return {
    object: "list",
    data: ids.map((id) => ({
      id,
      object: "model",
      name: id,
      context_length: 128_000,
      supported_endpoints: ["/chat/completions"],
    })),
  }
}

test("setup registers the provider, its models, the credential methods and the refresh command", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "commandcode-plugin-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const host = createHost(join(dir, "cache.json"))
  t.after(stubFetch(() => catalog(["deepseek/deepseek-v4-flash"]), host.requests))

  await plugin.setup(host.context)

  const record = host.providerDraft.records.get("commandcode")
  assert.ok(record, "the provider must be registered")
  assert.equal(record.provider.name, "Command Code")
  assert.equal(record.provider.package, "aisdk:@ai-sdk/openai-compatible")
  assert.equal(record.provider.integrationID, "commandcode")
  assert.deepEqual(record.provider.settings, { baseURL: "https://api.commandcode.ai/provider/v1" })
  assert.equal(record.models.size, 1)
  assert.equal(record.models.get("deepseek-v4-flash")?.modelID, "deepseek/deepseek-v4-flash")

  assert.deepEqual(
    host.integrationDraft.refs.get("commandcode"),
    { id: "commandcode", name: "Command Code" },
  )
  assert.deepEqual(host.integrationDraft.methods.get("commandcode"), [
    { type: "env", names: ["COMMANDCODE_API_KEY", "COMMAND_CODE_API_KEY"] },
    { type: "key", label: "API Key" },
  ])

  assert.deepEqual(host.commands.map((command) => command.name), ["commandcode-refresh"])
  assert.match(host.commands[0]!.description ?? "", /catalog/i)
  assert.equal(host.requests.length, 1)
})

test("the refresh command fetches again, reloads the provider and reports into the session", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "commandcode-plugin-refresh-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const host = createHost(join(dir, "cache.json"))
  let listed = ["deepseek/deepseek-v4-flash"]
  t.after(stubFetch(() => catalog(listed), host.requests))

  await plugin.setup(host.context)
  assert.equal(host.providerDraft.reloads, 0)

  listed = ["deepseek/deepseek-v4-flash", "brand/new-model"]
  await host.commands[0]!.execute({ sessionID: "ses_test", prompt: { text: "" }, delivery: "steer" })

  assert.equal(host.requests.length, 2, "the command must fetch again")
  assert.equal(host.providerDraft.reloads, 1, "the command must ask opencode to replay the transforms")
  assert.equal(host.providerDraft.records.get("commandcode")?.models.size, 2, "the new model is published")
  const published = [...(host.providerDraft.records.get("commandcode")?.models.values() ?? [])]
  assert.ok(
    published.some((model) => model.modelID === "brand/new-model"),
    `the new model must reach the wire as its Command Code id, got ${published.map((m) => m.modelID).join(", ")}`,
  )
  assert.equal(host.notices.length, 1)
  assert.match(host.notices[0]!, /2 models listed/)
  assert.match(host.notices[0]!, /1 new \(brand\/new-model\)/)
})

test("a failing refresh is reported into the session instead of thrown", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "commandcode-plugin-fail-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const host = createHost(join(dir, "cache.json"))
  let fail = false
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => {
    host.requests.push(String(input))
    if (fail) throw new Error("network is down")
    return new Response(JSON.stringify(catalog(["deepseek/deepseek-v4-flash"])), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = original
  })

  await plugin.setup(host.context)
  fail = true
  await host.commands[0]!.execute({ sessionID: "ses_test", prompt: { text: "" }, delivery: "steer" })

  assert.equal(host.notices.length, 1)
  assert.match(host.notices[0]!, /refresh failed \(network is down\)/)
})

test("setup survives an unreachable catalog by falling back to the snapshot", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "commandcode-plugin-offline-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const host = createHost(join(dir, "cache.json"))
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new Error("offline")
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = original
  })

  await plugin.setup(host.context)

  const record = host.providerDraft.records.get("commandcode")
  assert.ok(record, "the bundled snapshot must still register the provider")
  assert.ok(record.models.size > 50, `expected the snapshot catalog, got ${record.models.size}`)
  assert.equal(host.commands.length, 1, "the refresh command works even when startup failed")
})
