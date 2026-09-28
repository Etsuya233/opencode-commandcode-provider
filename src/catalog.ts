/**
 * Runtime catalog assembly.
 *
 * Three sources, in decreasing order of freshness:
 *
 * 1. **live** — `GET /provider/v1/models` (public, no auth, returns every model
 *    regardless of plan). Owns the model *list* and the exact context window.
 * 2. **cache** — the last successful live response, kept on disk so startup
 *    never waits on the network and the catalog survives being offline.
 * 3. **snapshot** — the generated documentation snapshot shipped in the package.
 *    Owns pricing, reasoning, effort levels, modalities and plan gating.
 *
 * A model is only ever *listed* because the live API or the snapshot says so;
 * a model is never dropped for lacking metadata. Unknown metadata degrades to
 * "free, text-only, no selectable effort" instead of hiding the model.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import {
  FALLBACK_CONTEXT,
  PLAN_RANK,
  ZERO_COST,
  DEFAULT_MAX_OUTPUT,
  type CatalogEntry,
  type PlanId,
  type SnapshotEntry,
} from "./types.ts"

export const CACHE_VERSION = 1

export interface LiveModel {
  id: string
  name: string
  context: number
  /** Documented `supported_endpoints` for the model, e.g. `["/chat/completions"]`. */
  endpoints: readonly string[]
}

export interface CatalogCache {
  version: number
  fetchedAt: string
  models: readonly LiveModel[]
}

export class CatalogError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CatalogError"
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Validates the documented OpenAI-style `{ object: "list", data: [...] }` body. */
export function parseLiveModels(value: unknown): readonly LiveModel[] {
  if (!isRecord(value)) throw new CatalogError("Expected the models response to be an object")
  if (value.object !== "list") throw new CatalogError("Expected the models response object to be 'list'")

  const data = value.data
  if (!Array.isArray(data)) throw new CatalogError("Expected the models response data to be an array")

  return data.map((entry): LiveModel => {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) {
      throw new CatalogError("Expected every model entry to carry a string id")
    }
    const context = entry.context_length
    const endpoints = entry.supported_endpoints
    return {
      id: entry.id,
      name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : entry.id,
      context: typeof context === "number" && context > 0 ? context : FALLBACK_CONTEXT,
      endpoints: Array.isArray(endpoints) ? endpoints.filter((item): item is string => typeof item === "string") : [],
    }
  })
}

export interface FetchLiveOptions {
  url: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

export async function fetchLiveModels(options: FetchLiveOptions): Promise<readonly LiveModel[]> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 5_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)

  const external = options.signal
  const onAbort = (): void => controller.abort(external?.reason)
  external?.addEventListener("abort", onAbort, { once: true })

  try {
    const response = await fetchImpl(options.url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new CatalogError(`models endpoint returned ${response.status} ${response.statusText}`)
    }
    return parseLiveModels(await response.json())
  } finally {
    clearTimeout(timer)
    external?.removeEventListener("abort", onAbort)
  }
}

export async function readCatalogCache(path: string): Promise<CatalogCache | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf-8"))
    if (!isRecord(parsed) || parsed.version !== CACHE_VERSION) return null
    if (typeof parsed.fetchedAt !== "string" || !Array.isArray(parsed.models)) return null
    const models = parsed.models.filter(
      (model): model is LiveModel =>
        isRecord(model) && typeof model.id === "string" && typeof model.context === "number",
    )
    if (models.length === 0) return null
    return { version: CACHE_VERSION, fetchedAt: parsed.fetchedAt, models }
  } catch {
    // A missing, unreadable or malformed cache just means "no cache".
    return null
  }
}

export async function writeCatalogCache(path: string, models: readonly LiveModel[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.tmp`
  const payload: CatalogCache = {
    version: CACHE_VERSION,
    fetchedAt: new Date().toISOString(),
    models,
  }
  try {
    await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 })
    await rename(temporaryPath, path)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

export interface MergeResult {
  entries: CatalogEntry[]
  /** Listed by the live API but absent from the snapshot (metadata unknown). */
  added: readonly string[]
  /** In the snapshot but no longer listed by the live API. */
  dropped: readonly string[]
}

/**
 * Combines the snapshot with the live listing.
 *
 * `live === null` means "no live data available" and yields the snapshot as-is.
 * A non-empty `live` list is authoritative for *membership*: models it stops
 * listing are dropped, models it adds are surfaced with degraded metadata.
 */
export function mergeCatalog(
  snapshot: readonly SnapshotEntry[],
  live: readonly LiveModel[] | null,
): MergeResult {
  if (live === null || live.length === 0) {
    return {
      entries: snapshot.map((entry) => resolveSnapshotEntry(entry, null)),
      added: [],
      dropped: [],
    }
  }

  const snapshotById = new Map(snapshot.map((entry) => [entry.id, entry]))
  const liveIds = new Set(live.map((model) => model.id))
  const added: string[] = []

  const entries = live.map((model): CatalogEntry => {
    const documented = snapshotById.get(model.id)
    if (documented) return resolveSnapshotEntry(documented, model)
    added.push(model.id)
    return {
      id: model.id,
      name: model.name,
      protocol: model.endpoints.length > 0 && !model.endpoints.includes("/chat/completions") && model.endpoints.includes("/messages")
        ? "anthropic"
        : "openai",
      context: model.context,
      contextSource: "live",
      maxOutput: DEFAULT_MAX_OUTPUT,
      reasoning: false,
      efforts: [],
      image: false,
      cost: ZERO_COST,
      minPlan: "go",
      status: "active",
    }
  })

  const dropped = snapshot.filter((entry) => !liveIds.has(entry.id)).map((entry) => entry.id)
  entries.sort((left, right) => left.id.localeCompare(right.id))
  return { entries, added, dropped }
}

function resolveSnapshotEntry(entry: SnapshotEntry, live: LiveModel | null): CatalogEntry {
  return {
    id: entry.id,
    name: entry.name,
    protocol: entry.protocol,
    context: live?.context ?? entry.context ?? FALLBACK_CONTEXT,
    contextSource: live ? "live" : "documented",
    maxOutput: entry.maxOutput,
    reasoning: entry.reasoning,
    efforts: entry.efforts,
    image: entry.image,
    cost: entry.cost,
    minPlan: entry.minPlan,
    status: entry.status,
  }
}

export interface SelectOptions {
  /** Declared by the user. Models above this plan are filtered out. */
  plan?: PlanId | undefined
  /** Keep retired models in the picker. */
  includeDeprecated?: boolean
}

export function selectCatalog(
  entries: readonly CatalogEntry[],
  options: SelectOptions = {},
): CatalogEntry[] {
  const plan = options.plan
  return entries.filter((entry) => {
    if (!options.includeDeprecated && entry.status === "deprecated") return false
    if (plan !== undefined && PLAN_RANK[entry.minPlan] > PLAN_RANK[plan]) return false
    return true
  })
}

export type CatalogSource = "live" | "cache" | "snapshot"

export interface ResolveCatalogOptions {
  snapshot: readonly SnapshotEntry[]
  modelsUrl: string
  cachePath: string
  timeoutMs: number
  ttlMs: number
  offline?: boolean
  fetchImpl?: typeof fetch
  now?: () => number
}

export interface ResolveCatalogResult {
  entries: CatalogEntry[]
  source: CatalogSource
  fetchedAt: string | null
  warning?: string
}

/**
 * Resolves the catalog for a session.
 *
 * A fresh cache short-circuits the network entirely, so the common startup path
 * costs no latency. A stale cache is refreshed, and any failure falls back to
 * the cached list and then to the bundled snapshot — a network problem must
 * never leave the provider with zero models.
 */
export async function resolveCatalog(options: ResolveCatalogOptions): Promise<ResolveCatalogResult> {
  const cache = await readCatalogCache(options.cachePath)
  const now = options.now ?? Date.now

  const fallback = (warning: string): ResolveCatalogResult => ({
    entries: mergeCatalog(options.snapshot, cache?.models ?? null).entries,
    source: cache ? "cache" : "snapshot",
    fetchedAt: cache?.fetchedAt ?? null,
    warning,
  })

  if (options.offline) {
    return cache
      ? { entries: mergeCatalog(options.snapshot, cache.models).entries, source: "cache", fetchedAt: cache.fetchedAt }
      : { entries: mergeCatalog(options.snapshot, null).entries, source: "snapshot", fetchedAt: null }
  }

  if (cache && now() - Date.parse(cache.fetchedAt) < options.ttlMs) {
    return { entries: mergeCatalog(options.snapshot, cache.models).entries, source: "cache", fetchedAt: cache.fetchedAt }
  }

  try {
    const models = await fetchLiveModels({
      url: options.modelsUrl,
      timeoutMs: options.timeoutMs,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    })
    await writeCatalogCache(options.cachePath, models).catch(() => undefined)
    return {
      entries: mergeCatalog(options.snapshot, models).entries,
      source: "live",
      fetchedAt: new Date().toISOString(),
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return fallback(`Could not refresh the Command Code model catalog (${reason}).`)
  }
}
