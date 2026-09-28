import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import assert from "node:assert/strict"
import { test } from "node:test"

import {
  CatalogError,
  mergeCatalog,
  parseLiveModels,
  readCatalogCache,
  resolveCatalog,
  selectCatalog,
  writeCatalogCache,
  type LiveModel,
} from "../src/catalog.ts"
import { ZERO_COST, type SnapshotEntry } from "../src/types.ts"

function snapshotEntry(overrides: Partial<SnapshotEntry> & { id: string }): SnapshotEntry {
  return {
    name: overrides.id,
    protocol: "openai",
    context: 128_000,
    maxOutput: 8_192,
    reasoning: false,
    efforts: [],
    image: false,
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
    minPlan: "go",
    status: "active",
    ...overrides,
  }
}

const snapshot: readonly SnapshotEntry[] = [
  snapshotEntry({ id: "alpha/model", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 } }),
  snapshotEntry({ id: "beta/model", protocol: "anthropic", minPlan: "pro", context: 256_000 }),
  snapshotEntry({ id: "gamma/retired", context: null, status: "deprecated" }),
]

const live: readonly LiveModel[] = [
  { id: "alpha/model", name: "Alpha", context: 200_000, endpoints: ["/chat/completions"] },
  { id: "beta/model", name: "Beta", context: 1_048_576, endpoints: ["/messages"] },
  { id: "delta/new", name: "Delta", context: 400_000, endpoints: ["/chat/completions", "/responses"] },
]

function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "cc-catalog-test-"))
  return run(directory).finally(() => rmSync(directory, { recursive: true, force: true }))
}

test("parseLiveModels validates the documented envelope", () => {
  const models = parseLiveModels({
    object: "list",
    data: [
      { id: "a/b", name: "A B", context_length: 1000, supported_endpoints: ["/messages"] },
      { id: "c/d" },
    ],
  })
  assert.deepEqual(models[0], { id: "a/b", name: "A B", context: 1000, endpoints: ["/messages"] })
  // A missing context window degrades to the documented fallback instead of dropping the model.
  assert.equal(models[1]?.context, 200_000)
  assert.equal(models[1]?.name, "c/d")

  assert.throws(() => parseLiveModels({ object: "list" }), CatalogError)
  assert.throws(() => parseLiveModels({ object: "nope", data: [] }), CatalogError)
  assert.throws(() => parseLiveModels({ object: "list", data: [{ name: "no id" }] }), CatalogError)
})

test("mergeCatalog uses the snapshot alone when no live data exists", () => {
  const { entries, added, dropped } = mergeCatalog(snapshot, null)
  assert.equal(entries.length, 3)
  assert.deepEqual(added, [])
  assert.deepEqual(dropped, [])
  assert.equal(entries[0]?.context, 128_000)
  assert.equal(entries[0]?.contextSource, "documented")
  assert.equal(entries[2]?.context, 200_000, "a retired model still needs a usable context window")
})

test("mergeCatalog lets live data own membership and context windows", () => {
  const { entries, added, dropped } = mergeCatalog(snapshot, live)
  const byId = new Map(entries.map((entry) => [entry.id, entry]))

  assert.deepEqual(added, ["delta/new"])
  assert.deepEqual(dropped, ["gamma/retired"])

  const alpha = byId.get("alpha/model")!
  assert.equal(alpha.context, 200_000)
  assert.equal(alpha.contextSource, "live")
  assert.deepEqual(alpha.cost, { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 })
  assert.equal(alpha.maxOutput, 8_192)

  // A live-only model is surfaced with degraded but honest metadata.
  const delta = byId.get("delta/new")!
  assert.deepEqual(delta.cost, ZERO_COST)
  assert.equal(delta.reasoning, false)
  assert.equal(delta.image, false)
  assert.equal(delta.context, 400_000)
})

test("mergeCatalog treats an empty live list as no data", () => {
  const { entries, dropped } = mergeCatalog(snapshot, [])
  assert.equal(entries.length, 3)
  assert.deepEqual(dropped, [])
})

test("selectCatalog filters by declared plan and deprecation", () => {
  const entries = mergeCatalog(snapshot, live).entries
  assert.deepEqual(
    selectCatalog(entries).map((entry) => entry.id),
    ["alpha/model", "beta/model", "delta/new"],
  )
  assert.deepEqual(
    selectCatalog(entries, { plan: "go" }).map((entry) => entry.id),
    ["alpha/model", "delta/new"],
  )
  assert.deepEqual(
    selectCatalog(mergeCatalog(snapshot, null).entries, { includeDeprecated: true }).map((entry) => entry.id),
    ["alpha/model", "beta/model", "gamma/retired"],
  )
})

test("cache round-trips and rejects foreign versions", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "nested", "catalog.json")
    assert.equal(await readCatalogCache(path), null)

    await writeCatalogCache(path, live)
    const cached = await readCatalogCache(path)
    assert.equal(cached?.models.length, 3)
    assert.equal(cached?.version, 1)

    writeFileSync(path, JSON.stringify({ version: 99, fetchedAt: "x", models: live }))
    assert.equal(await readCatalogCache(path), null)

    writeFileSync(path, "{ not json")
    assert.equal(await readCatalogCache(path), null)
  })
})

const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const liveBody = { object: "list", data: live.map((model) => ({ ...model, context_length: model.context })) }

test("resolveCatalog prefers a fresh cache and never touches the network", async () => {
  await withTempDir(async (directory) => {
    const cachePath = join(directory, "catalog.json")
    await writeCatalogCache(cachePath, live)

    let called = 0
    const result = await resolveCatalog({
      snapshot,
      modelsUrl: "https://example.invalid/models",
      cachePath,
      timeoutMs: 1_000,
      ttlMs: 60_000,
      fetchImpl: async () => {
        called += 1
        return response(liveBody)
      },
    })

    assert.equal(called, 0)
    assert.equal(result.source, "cache")
    assert.equal(result.entries.length, 3)
  })
})

test("resolveCatalog refreshes a stale cache and stores the result", async () => {
  await withTempDir(async (directory) => {
    const cachePath = join(directory, "catalog.json")
    await writeCatalogCache(cachePath, live)
    writeFileSync(
      cachePath,
      JSON.stringify({ version: 1, fetchedAt: new Date(Date.now() - 10_000_000).toISOString(), models: [] }),
    )

    const result = await resolveCatalog({
      snapshot,
      modelsUrl: "https://example.invalid/models",
      cachePath,
      timeoutMs: 1_000,
      ttlMs: 1_000,
      fetchImpl: async () => response(liveBody),
    })

    assert.equal(result.source, "live")
    assert.equal(result.warning, undefined)
    assert.equal((await readCatalogCache(cachePath))?.models.length, 3)
  })
})

test("resolveCatalog falls back to cache, then to the snapshot, on failure", async () => {
  const failing = async (): Promise<Response> => response({ error: "nope" }, 503)

  await withTempDir(async (directory) => {
    const cachePath = join(directory, "catalog.json")

    const noCache = await resolveCatalog({
      snapshot,
      modelsUrl: "https://example.invalid/models",
      cachePath,
      timeoutMs: 1_000,
      ttlMs: 0,
      fetchImpl: failing,
    })
    assert.equal(noCache.source, "snapshot")
    assert.equal(noCache.entries.length, 3)
    assert.match(noCache.warning ?? "", /Could not refresh/)

    await writeCatalogCache(cachePath, live)
    const withCache = await resolveCatalog({
      snapshot,
      modelsUrl: "https://example.invalid/models",
      cachePath,
      timeoutMs: 1_000,
      ttlMs: 0,
      fetchImpl: failing,
    })
    assert.equal(withCache.source, "cache")
    assert.equal(withCache.entries.length, 3)
    assert.ok(withCache.warning !== undefined)
  })
})

test("resolveCatalog honours offline mode", async () => {
  await withTempDir(async (directory) => {
    const cachePath = join(directory, "catalog.json")
    const offline = {
      snapshot,
      modelsUrl: "https://example.invalid/models",
      cachePath,
      timeoutMs: 1_000,
      ttlMs: 0,
      offline: true,
      fetchImpl: async (): Promise<Response> => {
        throw new Error("offline mode must not fetch")
      },
    }

    assert.equal((await resolveCatalog(offline)).source, "snapshot")
    await writeCatalogCache(cachePath, live)
    assert.equal((await resolveCatalog(offline)).source, "cache")
  })
})
