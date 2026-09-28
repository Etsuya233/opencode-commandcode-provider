import { readFileSync } from "node:fs"
import { join } from "node:path"
import assert from "node:assert/strict"
import { test } from "node:test"

import { SNAPSHOT, COMMAND_CODE_CLI_VERSION } from "../src/catalog.generated.ts"
import { buildSnapshot, renderCatalogModule } from "../src/snapshot.ts"
import { PLAN_IDS } from "../src/types.ts"

const fixtureDirectory = join(import.meta.dirname, "fixtures")
const markdown = readFileSync(join(fixtureDirectory, "models.md"), "utf-8")
const bundle = readFileSync(join(fixtureDirectory, "bundle.mjs"), "utf-8")

test("builds a snapshot from the documented table plus bundle literals", () => {
  const { entries, warnings } = buildSnapshot(markdown, bundle)
  const byId = new Map(entries.map((entry) => [entry.id, entry]))

  const flash = byId.get("deepseek/deepseek-v4-flash")!
  assert.equal(flash.reasoning, true)
  assert.deepEqual(flash.efforts, ["high", "max"])
  assert.equal(flash.maxOutput, 131_072)
  assert.equal(flash.image, true)
  assert.equal(flash.minPlan, "go")
  assert.equal(flash.status, "active")
  assert.equal(flash.context, 1_000_000)

  const kimi = byId.get("moonshotai/Kimi-K2.6")!
  assert.equal(kimi.reasoning, false)
  assert.deepEqual(kimi.efforts, [])
  assert.equal(kimi.image, false)
  assert.equal(kimi.maxOutput, 65_536)

  // The doc says `—` for efforts but the bundle marks it as reasoning.
  const muse = byId.get("meta/muse-spark-1.3")!
  assert.equal(muse.reasoning, true)
  assert.deepEqual(muse.efforts, [])
  assert.equal(muse.minPlan, "max")

  const sonnet = byId.get("claude-sonnet-4-6")!
  assert.equal(sonnet.protocol, "anthropic")
  assert.equal(sonnet.context, 1_050_000)
  assert.equal(sonnet.cost.cacheWrite, 3.75)

  const retired = byId.get("zai-org/GLM-5.1")!
  assert.equal(retired.context, null)
  assert.equal(retired.status, "deprecated")

  assert.deepEqual(warnings, [])
})

test("warns when the doc and the bundle disagree on effort levels", () => {
  const edited = markdown.replace("high, max", "high")
  const { warnings } = buildSnapshot(edited, bundle)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /effort levels differ for deepseek\/deepseek-v4-flash/)
})

test("renders a deterministic module", () => {
  const { entries } = buildSnapshot(markdown, bundle)
  const first = renderCatalogModule(entries, { packageVersion: "9.9.9", syncedAt: "2026-01-01" })
  const second = renderCatalogModule([...entries].reverse(), { packageVersion: "9.9.9", syncedAt: "2026-01-01" })
  assert.notEqual(first, second, "renderer must preserve the caller's ordering")
  assert.match(first, /export const COMMAND_CODE_CLI_VERSION = "9\.9\.9"/)
})

test("the shipped snapshot is internally consistent", () => {
  assert.ok(COMMAND_CODE_CLI_VERSION.length > 0)
  assert.ok(SNAPSHOT.length > 50, `expected a substantial snapshot, got ${SNAPSHOT.length}`)

  const ids = new Set<string>()
  for (const entry of SNAPSHOT) {
    assert.ok(!ids.has(entry.id), `duplicate id ${entry.id}`)
    ids.add(entry.id)

    assert.ok(entry.name.length > 0, `${entry.id} has no name`)
    assert.ok(entry.protocol === "openai" || entry.protocol === "anthropic", `${entry.id} bad protocol`)
    assert.ok((PLAN_IDS as readonly string[]).includes(entry.minPlan), `${entry.id} bad plan`)
    assert.ok(entry.maxOutput > 0, `${entry.id} bad maxOutput`)
    assert.ok(entry.cost.input >= 0 && entry.cost.output >= 0, `${entry.id} negative cost`)
    assert.ok(entry.cost.cacheRead >= 0 && entry.cost.cacheWrite >= 0, `${entry.id} negative cache cost`)

    // A retired model is exactly the one whose documented context is `—`.
    assert.equal(entry.status === "deprecated", entry.context === null, `${entry.id} deprecation mismatch`)
    assert.ok(entry.context === null || entry.context > 0, `${entry.id} bad context`)

    // Selectable levels imply reasoning; the converse is not required.
    if (entry.efforts.length > 0) assert.equal(entry.reasoning, true, `${entry.id} has efforts but no reasoning`)
  }

  const sorted = [...SNAPSHOT].sort((left, right) => left.id.localeCompare(right.id))
  assert.deepEqual(
    SNAPSHOT.map((entry) => entry.id),
    sorted.map((entry) => entry.id),
    "snapshot must stay sorted by id for reviewable diffs",
  )

  // The section-to-protocol mapping is what decides the Claude adapter, so a
  // non-Claude model landing in the Anthropic section must be reviewed.
  for (const entry of SNAPSHOT) {
    if (entry.protocol === "anthropic") {
      assert.ok(entry.id.startsWith("claude-"), `non-Claude model in the Anthropic section: ${entry.id}`)
    } else {
      assert.ok(!entry.id.startsWith("claude-"), `Claude model outside the Anthropic section: ${entry.id}`)
    }
  }
})

test("the shipped snapshot carries the verified landmarks", () => {
  const byId = new Map(SNAPSHOT.map((entry) => [entry.id, entry]))

  const flash = byId.get("deepseek/deepseek-v4-flash")
  assert.ok(flash, "deepseek/deepseek-v4-flash missing from the snapshot")
  assert.deepEqual(flash.cost, { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 })
  assert.equal(flash.minPlan, "go")

  const gpt55 = byId.get("gpt-5.5")
  assert.ok(gpt55, "gpt-5.5 missing from the snapshot")
  assert.equal(gpt55.minPlan, "pro", "gpt-5.5 is gated behind Pro")
  assert.equal(gpt55.context, 400_000)

  const retired = SNAPSHOT.filter((entry) => entry.status === "deprecated").map((entry) => entry.id)
  assert.deepEqual(retired, [
    "MiniMaxAI/MiniMax-M2.7",
    "Qwen/Qwen3.6-Max-Preview",
    "Qwen/Qwen3.6-Plus",
    "zai-org/GLM-5.1",
  ])
})
