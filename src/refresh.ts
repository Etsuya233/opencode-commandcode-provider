/**
 * Manual and background catalog refresh.
 *
 * Kept separate from the plugin entry point so the network call, the cache
 * write and the user-facing summary can be tested without an opencode host.
 */

import { fetchLiveModels, mergeCatalog, writeCatalogCache } from "./catalog.ts"
import type { CatalogEntry } from "./types.ts"
import type { SnapshotEntry } from "./types.ts"

export interface RefreshOptions {
  snapshot: readonly SnapshotEntry[]
  modelsUrl: string
  cachePath: string
  timeoutMs: number
  fetchImpl?: typeof fetch
}

export interface RefreshResult {
  entries: CatalogEntry[]
  /** Listed by the API but unknown to the snapshot. */
  added: readonly string[]
  /** In the snapshot but no longer listed by the API. */
  retired: readonly string[]
  /** One line describing what happened, safe to show to a user. */
  summary: string
}

/**
 * Fetches the live catalog, stores it, and merges it with the snapshot.
 *
 * Throws when the fetch fails: the caller decides whether that is worth
 * reporting (a slash command) or already covered by a fallback (startup).
 */
export async function refreshCatalog(options: RefreshOptions): Promise<RefreshResult> {
  const models = await fetchLiveModels({
    url: options.modelsUrl,
    timeoutMs: options.timeoutMs,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  })
  await writeCatalogCache(options.cachePath, models).catch(() => undefined)

  const merged = mergeCatalog(options.snapshot, models)
  return {
    entries: merged.entries,
    added: merged.added,
    retired: merged.dropped,
    summary: describeRefresh(models.length, merged.added, merged.dropped),
  }
}

export function describeRefresh(
  listed: number,
  added: readonly string[],
  retired: readonly string[],
): string {
  const parts = [`${listed} models listed`]
  if (added.length > 0) parts.push(`${added.length} new (${preview(added)})`)
  if (retired.length > 0) parts.push(`${retired.length} retired (${preview(retired)})`)
  if (added.length === 0 && retired.length === 0) parts.push("no changes")
  return parts.join(", ")
}

const PREVIEW_LIMIT = 3

function preview(ids: readonly string[]): string {
  const shown = ids.slice(0, PREVIEW_LIMIT).join(", ")
  return ids.length > PREVIEW_LIMIT ? `${shown}, …` : shown
}
