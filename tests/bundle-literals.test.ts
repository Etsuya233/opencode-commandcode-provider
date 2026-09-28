import { readFileSync } from "node:fs"
import { join } from "node:path"
import assert from "node:assert/strict"
import { test } from "node:test"

import {
  BundleLiteralsError,
  collectBundleLiterals,
  findModelObject,
  parseEffortsFromObject,
  parseMaxOutputTokensFromObject,
  parseReasoning,
  parseTextOnlyModelIds,
} from "../src/bundle-literals.ts"
import { parseModelsDoc } from "../src/models-md.ts"

const bundle = readFileSync(join(import.meta.dirname, "fixtures", "bundle.mjs"), "utf-8")
const markdown = readFileSync(join(import.meta.dirname, "fixtures", "models.md"), "utf-8")

test("reads the text-only set via JSON.parse, not eval", () => {
  assert.deepEqual(parseTextOnlyModelIds(bundle), ["moonshotai/Kimi-K2.6", "zai-org/GLM-5.1"])
})

test("throws when the text-only marker is gone instead of guessing", () => {
  assert.throws(() => parseTextOnlyModelIds("var x = 1"), BundleLiteralsError)
})

test("extracts a model object across nested structures and quotes", () => {
  const object = findModelObject(bundle, "deepseek/deepseek-v4-flash")
  assert.ok(object !== null)
  assert.ok(object.startsWith('{id:"deepseek/deepseek-v4-flash"'))
  assert.ok(object.endsWith("}"))
  assert.ok(object.includes("maxOutputTokens:131072"))

  assert.equal(findModelObject(bundle, "does/not-exist"), null)
})

test("detects reasoning from minified booleans and effort lists", () => {
  assert.equal(parseReasoning("reasoning:!0,maxOutputTokens:1"), true)
  assert.equal(parseReasoning("reasoning:true"), true)
  assert.equal(parseReasoning('reasoningEfforts:["high"]'), true)
  assert.equal(parseReasoning("reasoning:!1"), false)
  assert.equal(parseReasoning("contextWindow:1e6"), false)
  assert.equal(parseEffortsFromObject("reasoning:!0"), null)
  assert.deepEqual(parseEffortsFromObject('reasoningEfforts:["high","max"],x:1'), ["high", "max"])
})

test("reads maxOutputTokens only when present", () => {
  assert.equal(parseMaxOutputTokensFromObject("maxOutputTokens:131072,x:1"), 131_072)
  assert.equal(parseMaxOutputTokensFromObject("contextWindow:1e6"), null)
  assert.throws(() => parseMaxOutputTokensFromObject("maxOutputTokens:0"), BundleLiteralsError)
})

test("collects literals for every documented model", () => {
  const ids = parseModelsDoc(markdown).map((model) => model.id)
  const literals = collectBundleLiterals(bundle, ids)

  assert.equal(literals.size, ids.length)
  assert.deepEqual(literals.get("deepseek/deepseek-v4-flash"), {
    reasoning: true,
    efforts: ["high", "max"],
    maxOutput: 131_072,
  })
  assert.deepEqual(literals.get("moonshotai/Kimi-K2.6"), {
    reasoning: false,
    efforts: null,
    maxOutput: null,
  })
  // Reasoning without selectable levels: the doc says `—`, meaning the model
  // picks its own depth, while the bundle still reports a reasoning model.
  assert.deepEqual(literals.get("meta/muse-spark-1.3"), {
    reasoning: true,
    efforts: null,
    maxOutput: null,
  })
})

test("fails loudly when the doc lists a model the bundle does not have", () => {
  assert.throws(() => collectBundleLiterals(bundle, ["ghost/model"]), BundleLiteralsError)
})
