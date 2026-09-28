/**
 * Configuration resolution: plugin options (`opencode.json` tuple form) with
 * environment overrides on top.
 *
 * Every knob is settable both ways so that tests, local mocks and compatible
 * endpoints can be pointed at different URLs without patching the package.
 */

import { homedir } from "node:os"
import { join } from "node:path"

import { PLAN_IDS, type PlanId } from "./types.ts"

export const DEFAULT_API_BASE = "https://api.commandcode.ai"
export const DEFAULT_PROVIDER_PATH = "/provider/v1"
export const DEFAULT_TIMEOUT_MS = 5_000
/** How long a cached live catalog stays authoritative before a refetch. */
export const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000

export interface ProviderConfigInput {
  /** Provider API base including the version segment. */
  baseURL?: string
  modelsUrl?: string
  cachePath?: string
  timeoutMs?: number
  ttlMs?: number
  offline?: boolean
  /** Declared by the user, never probed. Filters models above this plan. */
  plan?: PlanId
  /** Append `(Pro+)`-style suffixes to model names. */
  planHint?: boolean
  /** Register Claude models under a second provider id instead of per-model npm. */
  splitAnthropic?: boolean
  /** Keep retired models in the model picker. */
  includeDeprecated?: boolean
  /**
   * Read a key from the Command Code CLI's auth files when no env var is set.
   * There is no integration method for a file, so this is opt-out, not opt-in.
   */
  authFileFallback?: boolean
}

export interface ResolvedConfig {
  baseURL: string
  modelsUrl: string
  cachePath: string
  timeoutMs: number
  ttlMs: number
  offline: boolean
  plan: PlanId | undefined
  planHint: boolean
  splitAnthropic: boolean
  includeDeprecated: boolean
  authFileFallback: boolean
}

export function defaultCachePath(): string {
  return join(homedir(), ".cache", "opencode", "commandcode-models.json")
}

/**
 * Coerces the loose `Record<string, unknown>` opencode passes as plugin options
 * into a typed config input. Unknown or malformed values are ignored rather than
 * failing the whole provider.
 */
export function providerConfigFromPluginOptions(
  options: Record<string, unknown> | undefined,
): ProviderConfigInput {
  if (!options) return {}

  const result: ProviderConfigInput = {}
  const string = (value: unknown): string | undefined =>
    typeof value === "string" && value.length > 0 ? value : undefined
  const positive = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined

  const baseURL = string(options.baseURL)
  if (baseURL !== undefined) result.baseURL = baseURL
  const modelsUrl = string(options.modelsUrl)
  if (modelsUrl !== undefined) result.modelsUrl = modelsUrl
  const cachePath = string(options.cachePath)
  if (cachePath !== undefined) result.cachePath = cachePath
  const timeoutMs = positive(options.timeoutMs)
  if (timeoutMs !== undefined) result.timeoutMs = timeoutMs
  const ttlMs = positive(options.ttlMs)
  if (ttlMs !== undefined) result.ttlMs = ttlMs

  const plan = string(options.plan)?.toLowerCase()
  if (plan !== undefined && (PLAN_IDS as readonly string[]).includes(plan)) result.plan = plan as PlanId

  if (typeof options.planHint === "boolean") result.planHint = options.planHint
  if (typeof options.splitAnthropic === "boolean") result.splitAnthropic = options.splitAnthropic
  if (typeof options.includeDeprecated === "boolean") result.includeDeprecated = options.includeDeprecated
  if (typeof options.authFileFallback === "boolean") result.authFileFallback = options.authFileFallback
  if (typeof options.offline === "boolean") result.offline = options.offline

  return result
}

function env(name: string): string | undefined {
  const value = process.env[name]
  return value === undefined || value === "" ? undefined : value
}

function envBoolean(name: string): boolean | undefined {
  const value = env(name)
  if (value === undefined) return undefined
  return value !== "0" && value.toLowerCase() !== "false"
}

function envNumber(name: string): number | undefined {
  const value = env(name)
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function envPlan(name: string): PlanId | undefined {
  const value = env(name)?.toLowerCase()
  if (value === undefined) return undefined
  return (PLAN_IDS as readonly string[]).includes(value) ? (value as PlanId) : undefined
}

export function resolveConfig(options: ProviderConfigInput = {}): ResolvedConfig {
  const apiBase = (env("COMMANDCODE_API_BASE") ?? DEFAULT_API_BASE).replace(/\/+$/, "")
  const baseURL = (options.baseURL ?? `${apiBase}${DEFAULT_PROVIDER_PATH}`).replace(/\/+$/, "")
  const plan = options.plan ?? envPlan("COMMANDCODE_PLAN")

  return {
    baseURL,
    modelsUrl: options.modelsUrl ?? env("COMMANDCODE_MODELS_URL") ?? `${apiBase}${DEFAULT_PROVIDER_PATH}/models`,
    cachePath: options.cachePath ?? env("COMMANDCODE_MODELS_CACHE") ?? defaultCachePath(),
    timeoutMs: options.timeoutMs ?? envNumber("COMMANDCODE_MODELS_TIMEOUT_MS") ?? DEFAULT_TIMEOUT_MS,
    ttlMs: options.ttlMs ?? envNumber("COMMANDCODE_MODELS_TTL_MS") ?? DEFAULT_TTL_MS,
    offline: options.offline ?? envBoolean("COMMANDCODE_MODELS_OFFLINE") ?? false,
    plan,
    // A declared plan makes the hint redundant: gated models are filtered out.
    planHint: options.planHint ?? (plan === undefined && !(envBoolean("COMMANDCODE_PLAN_HINT") === false)),
    splitAnthropic: options.splitAnthropic ?? envBoolean("COMMANDCODE_SPLIT_ANTHROPIC") ?? false,
    includeDeprecated: options.includeDeprecated ?? envBoolean("COMMANDCODE_INCLUDE_DEPRECATED") ?? false,
    authFileFallback: options.authFileFallback ?? envBoolean("COMMANDCODE_AUTH_FILE") ?? true,
  }
}
