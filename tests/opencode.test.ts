import assert from "node:assert/strict"
import { test } from "node:test"

import {
  ANTHROPIC_PACKAGE,
  API_KEY_ENV_NAMES,
  ConfigKeyError,
  INTEGRATION_ID,
  OPENAI_PACKAGE,
  PROVIDER_ID,
  applyCatalogRegistration,
  applyIntegrationRegistration,
  applyProviderRegistration,
  buildCatalogRegistration,
  buildModelInfo,
  configKeys,
  displayName,
} from "../src/opencode.ts"
import type {
  IntegrationDraft,
  IntegrationMethod,
  IntegrationRef,
  ModelInfo,
  ProviderDraft,
  ProviderInfo,
  ProviderRecord,
} from "../src/opencode-api.ts"
import type { CatalogEntry } from "../src/types.ts"

function entry(overrides: Partial<CatalogEntry> & { id: string }): CatalogEntry {
  return {
    name: overrides.id,
    protocol: "openai",
    context: 200_000,
    contextSource: "live",
    maxOutput: 65_536,
    reasoning: true,
    efforts: ["high", "max"],
    image: true,
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
    minPlan: "go",
    status: "active",
    ...overrides,
  }
}

/**
 * Stand-in for the runtime drafts, mirroring the semantics observed in
 * opencode 2.0.18: `models.update` materialises the provider record, and
 * `integration.update` materialises the integration.
 */
class FakeProviderDraft implements ProviderDraft {
  readonly records = new Map<string, ProviderRecord>()

  list(): readonly ProviderRecord[] {
    return [...this.records.values()]
  }

  get(providerID: string): ProviderRecord | undefined {
    return this.records.get(providerID)
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
    update: (providerID: string, modelID: string, update: (model: ModelInfo) => void): void => {
      let record = this.records.get(providerID)
      if (!record) {
        record = {
          provider: { id: providerID, name: providerID, activation: "auto", package: "" },
          models: new Map(),
        }
        this.records.set(providerID, record)
      }
      const existing =
        record.models.get(modelID) ?? defaultModelInfo(providerID, modelID)
      update(existing)
      record.models.set(modelID, existing)
    },
    remove: (providerID: string, modelID: string): void => {
      this.records.get(providerID)?.models.delete(modelID)
    },
  }
}

function defaultModelInfo(providerID: string, modelID: string): ModelInfo {
  return {
    id: modelID,
    modelID,
    providerID,
    name: modelID,
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 200_000, output: 32_000 },
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
    const reference = this.refs.get(integrationID) ?? { id: integrationID, name: integrationID }
    update(reference)
    this.refs.set(integrationID, reference)
  }

  remove(integrationID: string): void {
    this.refs.delete(integrationID)
  }

  readonly method = {
    list: (integrationID: string): readonly IntegrationMethod[] => this.methods.get(integrationID) ?? [],
    update: (input: { integrationID: string; method: IntegrationMethod }): void => {
      const existing = this.methods.get(input.integrationID) ?? []
      const serialized = JSON.stringify(input.method)
      if (!existing.some((method) => JSON.stringify(method) === serialized)) existing.push(input.method)
      this.methods.set(input.integrationID, existing)
    },
    remove: (integrationID: string, method: IntegrationMethod): void => {
      const serialized = JSON.stringify(method)
      this.methods.set(
        integrationID,
        (this.methods.get(integrationID) ?? []).filter((item) => JSON.stringify(item) !== serialized),
      )
    },
  }
}

const options = { baseURL: "https://api.commandcode.ai/provider/v1" }

test("configKeys strips the provider prefix and lowercases", () => {
  const keys = configKeys([
    entry({ id: "deepseek/deepseek-v4-flash" }),
    entry({ id: "claude-sonnet-4-6" }),
    entry({ id: "inclusionai/ling-3.0-flash-sante:free" }),
  ])
  assert.equal(keys.get("deepseek/deepseek-v4-flash"), "deepseek-v4-flash")
  assert.equal(keys.get("claude-sonnet-4-6"), "claude-sonnet-4-6")
  assert.equal(keys.get("inclusionai/ling-3.0-flash-sante:free"), "ling-3.0-flash-sante:free")
})

test("configKeys falls back to the full id when short forms collide", () => {
  const keys = configKeys([entry({ id: "a/model" }), entry({ id: "b/model" })])
  assert.equal(keys.get("a/model"), "a-model")
  assert.equal(keys.get("b/model"), "b-model")
})

test("configKeys refuses to silently overwrite a model", () => {
  assert.throws(
    () => configKeys([entry({ id: "p/x" }), entry({ id: "q/x" }), entry({ id: "p-x" })]),
    ConfigKeyError,
  )
})

test("displayName only advertises gating when hints are on", () => {
  assert.equal(displayName(entry({ id: "gpt-5.5", name: "GPT-5.5", minPlan: "pro" }), true), "GPT-5.5 (Pro+)")
  assert.equal(displayName(entry({ id: "f", name: "Fable", minPlan: "max" }), true), "Fable (Max)")
  assert.equal(displayName(entry({ id: "d", name: "DeepSeek" }), true), "DeepSeek")
  assert.equal(displayName(entry({ id: "g", name: "GPT", minPlan: "pro" }), false), "GPT")
})

test("buildModelInfo separates the picker key from the wire id", () => {
  const model = buildModelInfo(
    entry({ id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash" }),
    "deepseek-v4-flash",
    options,
  )

  assert.equal(model.id, "deepseek-v4-flash")
  assert.equal(model.modelID, "deepseek/deepseek-v4-flash")
  assert.equal(model.providerID, PROVIDER_ID)
  assert.equal(model.package, undefined, "openai-protocol models inherit the provider package")
  assert.deepEqual(model.capabilities, { tools: true, input: ["text", "image"], output: ["text"] })
  assert.deepEqual(model.cost, [{ input: 1, output: 2, cache: { read: 0.1, write: 0 } }])
  assert.deepEqual(model.limit, { context: 200_000, output: 65_536 })
  assert.equal(model.status, "active")
  assert.equal(model.enabled, true)
})

test("buildModelInfo clamps the output limit to the context window", () => {
  const model = buildModelInfo(entry({ id: "small", context: 4_096, maxOutput: 65_536 }), "small", options)
  assert.equal(model.limit.output, 4_096)
})

test("effort levels become openai reasoning variants only", () => {
  const openai = buildModelInfo(entry({ id: "o/x" }), "x", options)
  assert.deepEqual(openai.variants, [
    { id: "high", settings: { reasoningEffort: "high" } },
    { id: "max", settings: { reasoningEffort: "max" } },
  ])

  const anthropic = buildModelInfo(entry({ id: "claude-x", protocol: "anthropic" }), "claude-x", options)
  assert.deepEqual(anthropic.variants, [])
  assert.equal(anthropic.package, ANTHROPIC_PACKAGE)
})

test("buildModelInfo marks text-only models honestly", () => {
  const model = buildModelInfo(entry({ id: "o/text", image: false }), "text", options)
  assert.deepEqual(model.capabilities.input, ["text"])
})

test("buildCatalogRegistration wires the provider to its integration", () => {
  const registration = buildCatalogRegistration(
    [entry({ id: "deepseek/x" }), entry({ id: "claude-y", protocol: "anthropic" })],
    options,
  )

  assert.equal(registration.provider.id, PROVIDER_ID)
  assert.equal(registration.provider.package, OPENAI_PACKAGE)
  assert.equal(registration.provider.integrationID, INTEGRATION_ID)
  assert.deepEqual(registration.provider.settings, { baseURL: options.baseURL })
  assert.equal(registration.integration.integrationID, INTEGRATION_ID)
  assert.deepEqual(registration.integration.methods, [
    { type: "env", names: [...API_KEY_ENV_NAMES] },
    { type: "key", label: "API Key" },
  ])
  assert.deepEqual([...registration.models.keys()], ["x", "claude-y"])
})

test("applyProviderRegistration materialises the provider and its models", () => {
  const draft = new FakeProviderDraft()
  const registration = buildCatalogRegistration([entry({ id: "deepseek/x" })], options)

  applyProviderRegistration(draft, registration)

  const record = draft.get(PROVIDER_ID)
  assert.ok(record, "the provider record must exist after applying the registration")
  assert.equal(record.provider.name, "Command Code")
  assert.equal(record.provider.package, OPENAI_PACKAGE)
  assert.equal(record.provider.integrationID, INTEGRATION_ID)
  assert.equal(record.provider.settings?.baseURL, options.baseURL)
  assert.deepEqual([...record.models.keys()], ["x"])
})

test("applyIntegrationRegistration registers the credential methods once", () => {
  const draft = new FakeIntegrationDraft()
  const registration = buildCatalogRegistration([entry({ id: "deepseek/x" })], options)

  applyIntegrationRegistration(draft, registration)
  applyIntegrationRegistration(draft, registration)

  assert.equal(draft.get(INTEGRATION_ID)?.name, "Command Code")
  assert.equal(draft.method.list(INTEGRATION_ID).length, 2)
})

test("reapplying a registration refreshes models but keeps user settings", () => {
  const providerDraft = new FakeProviderDraft()
  const integrationDraft = new FakeIntegrationDraft()

  applyCatalogRegistration(
    { provider: providerDraft, integration: integrationDraft },
    buildCatalogRegistration([entry({ id: "deepseek/x", name: "First" })], options),
  )
  providerDraft.get(PROVIDER_ID)!.provider.settings = { custom: true }

  applyCatalogRegistration(
    { provider: providerDraft, integration: integrationDraft },
    buildCatalogRegistration([entry({ id: "deepseek/x", name: "Second" })], options),
  )

  const record = providerDraft.get(PROVIDER_ID)!
  assert.equal(record.provider.settings?.custom, true, "an existing setting must win")
  assert.equal(record.provider.settings?.baseURL, options.baseURL)
  assert.equal(record.models.size, 1)
  assert.equal(record.models.get("x")?.name, "Second", "a re-run must refresh model metadata")
})
