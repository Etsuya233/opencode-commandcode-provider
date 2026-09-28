import { readFileSync } from "node:fs"
import { join } from "node:path"
import assert from "node:assert/strict"
import { test } from "node:test"

import {
  ModelsDocError,
  parseContext,
  parseCost,
  parseEfforts,
  parseModelsDoc,
  parsePlan,
  protocolForSection,
} from "../src/models-md.ts"

const markdown = readFileSync(join(import.meta.dirname, "fixtures", "models.md"), "utf-8")

test("parses every documented row", () => {
  const models = parseModelsDoc(markdown)
  assert.deepEqual(
    models.map((model) => model.id),
    [
      "deepseek/deepseek-v4-flash",
      "moonshotai/Kimi-K2.6",
      "zai-org/GLM-5.1",
      "claude-sonnet-4-6",
      "meta/muse-spark-1.3",
    ],
  )
})

test("maps sections to wire protocols", () => {
  assert.equal(protocolForSection("Anthropic"), "anthropic")
  assert.equal(protocolForSection("Open Source"), "openai")
  assert.equal(protocolForSection("Meta"), "openai")

  const models = parseModelsDoc(markdown)
  assert.equal(models.find((model) => model.id === "claude-sonnet-4-6")?.protocol, "anthropic")
  assert.equal(models.find((model) => model.id === "deepseek/deepseek-v4-flash")?.protocol, "openai")
})

test("parses context windows including fractions and the retired marker", () => {
  assert.equal(parseContext("1M"), 1_000_000)
  assert.equal(parseContext("1.05M"), 1_050_000)
  assert.equal(parseContext("256K"), 256_000)
  assert.equal(parseContext("262K"), 262_000)
  assert.equal(parseContext("—"), null)
  assert.throws(() => parseContext("lots"), ModelsDocError)
})

test("parses prices with and without a cache write rate", () => {
  assert.deepEqual(parseCost("$0.15/$0.6 · cache $0.003"), {
    input: 0.15,
    output: 0.6,
    cacheRead: 0.003,
    cacheWrite: 0,
  })
  assert.deepEqual(parseCost(" $3/$15 · cache $0.3 (write $3.75) "), {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  })
  assert.deepEqual(parseCost("$0/$0 · cache $0"), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  assert.throws(() => parseCost("free"), ModelsDocError)
})

test("treats an em dash as 'the model picks its own depth'", () => {
  assert.deepEqual(parseEfforts("—"), [])
  assert.deepEqual(parseEfforts("low, medium, high, xhigh, max"), [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ])
})

test("parses plan gating", () => {
  assert.equal(parsePlan("Go and above"), "go")
  assert.equal(parsePlan("GOAT and above"), "goat")
  assert.equal(parsePlan("Pro and above"), "pro")
  assert.equal(parsePlan("Max"), "max")
  assert.throws(() => parsePlan("Enterprise"), ModelsDocError)
})

test("rejects duplicate ids and empty documents", () => {
  const row = "| `a/b` | B | 1M | — | $1/$2 · cache $0.1 | Go and above | x |"
  assert.throws(() => parseModelsDoc(`${row}\n${row}`), ModelsDocError)
  assert.throws(() => parseModelsDoc("# nothing here"), ModelsDocError)
})
