import assert from "node:assert/strict"
import { test } from "node:test"

import {
  ANTHROPIC_API,
  ANTHROPIC_NPM,
  ANTHROPIC_PROVIDER_ID,
  ConfigKeyError,
  OPENAI_NPM,
  PROVIDER_ID,
  applyProviderConfig,
  buildProviderRegistrations,
  configKeys,
  displayName,
  modelConfig,
} from "../src/provider-config.ts"
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
  // `p/x` and `q/x` collide on the short form, so both expand to a sanitized
  // full id - and `p/x` expands onto the same key a real `p-x` model wants.
  assert.throws(
    () => configKeys([entry({ id: "p/x" }), entry({ id: "q/x" }), entry({ id: "p-x" })]),
    ConfigKeyError,
  )
})

test("displayName only advertises gating when hints are on", () => {
  const gated = entry({ id: "gpt-5.5", name: "GPT-5.5", minPlan: "pro" })
  const open = entry({ id: "deepseek/x", name: "DeepSeek X", minPlan: "go" })
  const top = entry({ id: "claude-fable-5", name: "Claude Fable 5", minPlan: "max" })

  assert.equal(displayName(gated, true), "GPT-5.5 (Pro+)")
  assert.equal(displayName(top, true), "Claude Fable 5 (Max)")
  assert.equal(displayName(open, true), "DeepSeek X")
  assert.equal(displayName(gated, false), "GPT-5.5")
})

test("modelConfig maps a catalog entry onto opencode's model shape", () => {
  const config = modelConfig(entry({ id: "deepseek/x", name: "DeepSeek X" }), {
    planHint: false,
    overridePackage: false,
  })

  assert.equal(config.id, "deepseek/x")
  assert.equal(config.reasoning, true)
  assert.equal(config.tool_call, true)
  assert.equal(config.attachment, true)
  assert.deepEqual(config.modalities, { input: ["text", "image"], output: ["text"] })
  assert.deepEqual(config.cost, { input: 1, output: 2, cache_read: 0.1, cache_write: 0 })
  assert.deepEqual(config.limit, { context: 200_000, output: 65_536 })
  assert.deepEqual(config.variants, { high: { reasoningEffort: "high" }, max: { reasoningEffort: "max" } })
  assert.equal(config.status, "active")
  assert.equal(config.provider, undefined)
})

test("modelConfig clamps the output limit to the context window", () => {
  const config = modelConfig(entry({ id: "small", context: 4_096, maxOutput: 65_536 }), {
    planHint: false,
    overridePackage: false,
  })
  assert.deepEqual(config.limit, { context: 4_096, output: 4_096 })
})

test("modelConfig omits variants when the model picks its own depth", () => {
  const config = modelConfig(entry({ id: "auto", efforts: [] }), { planHint: false, overridePackage: false })
  assert.equal(config.variants, undefined)
})

test("anthropic models switch adapter per model, or via a split provider", () => {
  const claude = entry({ id: "claude-sonnet-4-6", protocol: "anthropic", name: "Claude Sonnet 4.6" })

  const single = buildProviderRegistrations([claude, entry({ id: "deepseek/x" })], {
    baseURL: "https://example.test/provider/v1",
  })
  assert.equal(single.length, 1)
  assert.equal(single[0]?.id, PROVIDER_ID)
  assert.equal(single[0]?.npm, OPENAI_NPM)
  assert.deepEqual(single[0]?.options, { baseURL: "https://example.test/provider/v1" })
  const claudeModel = single[0]?.models["claude-sonnet-4-6"] as Record<string, unknown>
  assert.deepEqual(claudeModel.provider, { npm: ANTHROPIC_NPM, api: ANTHROPIC_API })

  const split = buildProviderRegistrations([claude, entry({ id: "deepseek/x" })], {
    baseURL: "https://example.test/provider/v1",
    splitAnthropic: true,
  })
  assert.equal(split.length, 2)
  assert.equal(split[0]?.models["claude-sonnet-4-6"], undefined)
  assert.equal(split[1]?.id, ANTHROPIC_PROVIDER_ID)
  assert.equal(split[1]?.npm, ANTHROPIC_NPM)
  assert.ok(split[1]?.models["claude-sonnet-4-6"])
})

test("applyProviderConfig creates the provider block even when none exists", () => {
  const config: Record<string, unknown> = {}
  applyProviderConfig(
    config,
    buildProviderRegistrations([entry({ id: "deepseek/x" })], { baseURL: "https://example.test/provider/v1" }),
  )

  const providers = config.provider as Record<string, Record<string, unknown>>
  assert.ok(providers[PROVIDER_ID], "provider block must be created, not skipped")
  assert.equal(providers[PROVIDER_ID]?.npm, OPENAI_NPM)
  assert.deepEqual(providers[PROVIDER_ID]?.env, ["COMMANDCODE_API_KEY"])
  assert.ok((providers[PROVIDER_ID]?.models as Record<string, unknown>)["x"])
})

test("applyProviderConfig never overwrites explicit user configuration", () => {
  const config: Record<string, unknown> = {
    provider: {
      [PROVIDER_ID]: {
        name: "My Command Code",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "https://mirror.test/provider/v1", timeout: 30_000 },
        models: { x: { id: "deepseek/x", name: "Hand tuned" } },
      },
    },
  }

  applyProviderConfig(
    config,
    buildProviderRegistrations([entry({ id: "deepseek/x" }), entry({ id: "other/y" })], {
      baseURL: "https://generated.test/provider/v1",
    }),
  )

  const target = (config.provider as Record<string, Record<string, unknown>>)[PROVIDER_ID]!
  assert.equal(target.name, "My Command Code")
  assert.deepEqual(target.options, {
    baseURL: "https://mirror.test/provider/v1",
    timeout: 30_000,
  })
  const models = target.models as Record<string, unknown>
  assert.deepEqual(models.x, { id: "deepseek/x", name: "Hand tuned" })
  assert.ok(models.y, "models the user did not define are still registered")
})

test("applyProviderConfig is idempotent", () => {
  const registrations = buildProviderRegistrations([entry({ id: "deepseek/x" })], {
    baseURL: "https://example.test/provider/v1",
  })
  const config: Record<string, unknown> = {}
  applyProviderConfig(config, registrations)
  const once = JSON.stringify(config)
  applyProviderConfig(config, registrations)
  assert.equal(JSON.stringify(config), once)
})
