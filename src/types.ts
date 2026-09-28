/**
 * Shared domain types for the Command Code catalog.
 *
 * The catalog is assembled from two sources with different trust levels:
 *
 * - the live Provider API (`/provider/v1/models`) owns the *list* and the exact
 *   context window;
 * - the CLI documentation snapshot (`models.md` + `cli.mjs` literals, generated
 *   into `catalog.generated.ts`) owns pricing, reasoning capability, effort
 *   levels, input modalities, plan gating and deprecation status.
 *
 * Nothing here is plan-aware: Command Code documents that a plan must never be
 * probed, so plan gating stays a server-side decision (HTTP 403
 * `MODEL_NOT_IN_PLAN`) and `minPlan` is only ever a display hint.
 */

/** Individual plans, cheapest first. Order matters: `PLAN_RANK` depends on it. */
export const PLAN_IDS = ["go", "goat", "pro", "max"] as const

export type PlanId = (typeof PLAN_IDS)[number]

export const PLAN_RANK: Readonly<Record<PlanId, number>> = {
  go: 0,
  goat: 1,
  pro: 2,
  max: 3,
}

export const PLAN_LABELS: Readonly<Record<PlanId, string>> = {
  go: "Go",
  goat: "GOAT",
  pro: "Pro",
  max: "Max",
}

/** Wire protocol the model is served over. Drives adapter selection. */
export type Protocol = "openai" | "anthropic"

export type ModelStatus = "active" | "deprecated"

/** Where a model's context window came from. */
export type ContextSource = "live" | "documented"

export interface ModelCost {
  /** USD per 1M input tokens. */
  input: number
  /** USD per 1M output tokens. */
  output: number
  /** USD per 1M cache-read tokens. */
  cacheRead: number
  /** USD per 1M cache-write tokens. 0 means the provider does not bill writes. */
  cacheWrite: number
}

export interface CatalogEntry {
  /** Exact model id used on the wire, e.g. `deepseek/deepseek-v4-flash`. */
  id: string
  name: string
  protocol: Protocol
  /** Context window in tokens. */
  context: number
  contextSource: ContextSource
  /** Maximum output tokens. Command Code documents this for a handful of models only. */
  maxOutput: number
  reasoning: boolean
  /** Selectable reasoning efforts. Empty means the model picks its own depth. */
  efforts: readonly string[]
  image: boolean
  cost: ModelCost
  minPlan: PlanId
  status: ModelStatus
}

/**
 * One row of the generated snapshot.
 *
 * `context` is nullable on purpose: the documentation reports `—` for retired
 * models, and the snapshot records that faithfully instead of inventing a
 * number. Resolution happens in `catalog.ts`, where the live API can fill it in.
 */
export interface SnapshotEntry {
  id: string
  name: string
  protocol: Protocol
  context: number | null
  maxOutput: number
  reasoning: boolean
  efforts: readonly string[]
  image: boolean
  cost: ModelCost
  minPlan: PlanId
  status: ModelStatus
}

/** Default when the snapshot has no documented output limit for a model. */
export const DEFAULT_MAX_OUTPUT = 65_536

/** Last-resort context window for a retired model when the API is unreachable. */
export const FALLBACK_CONTEXT = 200_000

export const ZERO_COST: ModelCost = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
}
