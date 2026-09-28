import assert from "node:assert/strict"
import { test } from "node:test"

import {
  DEFAULT_API_BASE,
  DEFAULT_PROVIDER_PATH,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TTL_MS,
  defaultCachePath,
  providerConfigFromPluginOptions,
  resolveConfig,
} from "../src/config.ts"

const MANAGED = [
  "COMMANDCODE_API_BASE",
  "COMMANDCODE_MODELS_URL",
  "COMMANDCODE_MODELS_CACHE",
  "COMMANDCODE_MODELS_TIMEOUT_MS",
  "COMMANDCODE_MODELS_TTL_MS",
  "COMMANDCODE_MODELS_OFFLINE",
  "COMMANDCODE_PLAN",
  "COMMANDCODE_PLAN_HINT",
  "COMMANDCODE_SPLIT_ANTHROPIC",
  "COMMANDCODE_INCLUDE_DEPRECATED",
] as const

function withEnv(values: Record<string, string | undefined>, run: () => void): void {
  const saved = new Map<string, string | undefined>()
  for (const name of MANAGED) {
    saved.set(name, process.env[name])
    delete process.env[name]
  }
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) process.env[name] = value
  }
  try {
    run()
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

test("defaults point at the documented Provider API", () => {
  withEnv({}, () => {
    const config = resolveConfig()
    assert.equal(config.baseURL, `${DEFAULT_API_BASE}${DEFAULT_PROVIDER_PATH}`)
    assert.equal(config.modelsUrl, `${DEFAULT_API_BASE}${DEFAULT_PROVIDER_PATH}/models`)
    assert.equal(config.cachePath, defaultCachePath())
    assert.equal(config.timeoutMs, DEFAULT_TIMEOUT_MS)
    assert.equal(config.ttlMs, DEFAULT_TTL_MS)
    assert.equal(config.offline, false)
    assert.equal(config.plan, undefined)
    assert.equal(config.planHint, true)
    assert.equal(config.splitAnthropic, false)
    assert.equal(config.includeDeprecated, false)
  })
})

test("environment variables override every knob", () => {
  withEnv(
    {
      COMMANDCODE_API_BASE: "https://mirror.test/",
      COMMANDCODE_MODELS_URL: "https://mirror.test/provider/v1/models",
      COMMANDCODE_MODELS_CACHE: "/tmp/cc.json",
      COMMANDCODE_MODELS_TIMEOUT_MS: "250",
      COMMANDCODE_MODELS_TTL_MS: "1000",
      COMMANDCODE_MODELS_OFFLINE: "1",
      COMMANDCODE_PLAN: "GOAT",
      COMMANDCODE_SPLIT_ANTHROPIC: "true",
      COMMANDCODE_INCLUDE_DEPRECATED: "1",
    },
    () => {
      const config = resolveConfig()
      assert.equal(config.baseURL, "https://mirror.test/provider/v1")
      assert.equal(config.modelsUrl, "https://mirror.test/provider/v1/models")
      assert.equal(config.cachePath, "/tmp/cc.json")
      assert.equal(config.timeoutMs, 250)
      assert.equal(config.ttlMs, 1000)
      assert.equal(config.offline, true)
      assert.equal(config.plan, "goat")
      assert.equal(config.splitAnthropic, true)
      assert.equal(config.includeDeprecated, true)
    },
  )
})

test("a declared plan turns the advisory name hints off", () => {
  withEnv({ COMMANDCODE_PLAN: "goat" }, () => {
    assert.equal(resolveConfig().planHint, false)
    assert.equal(resolveConfig({ planHint: true }).planHint, true)
  })
  withEnv({}, () => {
    assert.equal(resolveConfig({ plan: "pro" }).planHint, false)
    assert.equal(resolveConfig().planHint, true)
  })
})

test("explicit options win over the environment", () => {
  withEnv({ COMMANDCODE_API_BASE: "https://env.test" }, () => {
    assert.equal(resolveConfig({ baseURL: "https://option.test/v1/" }).baseURL, "https://option.test/v1")
  })
})

test("malformed values fall back to defaults instead of throwing", () => {
  withEnv(
    {
      COMMANDCODE_MODELS_TIMEOUT_MS: "-5",
      COMMANDCODE_MODELS_TTL_MS: "abc",
      COMMANDCODE_MODELS_OFFLINE: "false",
      COMMANDCODE_PLAN: "enterprise",
    },
    () => {
      const config = resolveConfig()
      assert.equal(config.timeoutMs, DEFAULT_TIMEOUT_MS)
      assert.equal(config.ttlMs, DEFAULT_TTL_MS)
      assert.equal(config.offline, false)
      assert.equal(config.plan, undefined)
    },
  )
})

test("plugin options are coerced defensively", () => {
  assert.deepEqual(providerConfigFromPluginOptions(undefined), {})
  assert.deepEqual(providerConfigFromPluginOptions({ plan: "MAX", timeoutMs: 100, offline: true }), {
    plan: "max",
    timeoutMs: 100,
    offline: true,
  })
  assert.deepEqual(
    providerConfigFromPluginOptions({
      plan: "nope",
      timeoutMs: -1,
      ttlMs: "soon",
      baseURL: "",
      extra: "ignored",
    }),
    {},
  )
})
