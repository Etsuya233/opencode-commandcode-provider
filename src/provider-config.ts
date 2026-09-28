/**
 * Maps catalog entries onto opencode's provider configuration.
 *
 * Transport is delegated entirely to opencode's bundled AI SDK adapters: this
 * package ships no request conversion and no SSE parser.
 *
 * - OpenAI-protocol models (73 of 82) ride `@ai-sdk/openai-compatible` against
 *   `/provider/v1/chat/completions`. Every model that speaks OpenAI exposes that
 *   endpoint, so `/responses` never has to be wired up.
 * - Anthropic-protocol models (9 Claude models) need `@ai-sdk/anthropic`
 *   against `/provider/v1/messages`. opencode v2 supports overriding the
 *   package per model, so the default is a single provider id with a per-model
 *   override; `splitAnthropic` switches to a second provider id instead.
 */

import { PLAN_LABELS, PLAN_RANK, type CatalogEntry } from "./types.ts"

export const PROVIDER_ID = "commandcode"
export const ANTHROPIC_PROVIDER_ID = "commandcode-anthropic"

export const OPENAI_NPM = "@ai-sdk/openai-compatible"
export const ANTHROPIC_NPM = "@ai-sdk/anthropic"
export const ANTHROPIC_API = "anthropic-messages"

export interface ProviderConfigOptions {
  baseURL: string
  /** Append `(Pro+)` style suffixes so gated models are obvious up front. */
  planHint?: boolean
  /** Register Claude models under a second provider id. */
  splitAnthropic?: boolean
}

export class ConfigKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConfigKeyError"
  }
}

/**
 * Derives the short model key used in `provider/model` references.
 *
 * `deepseek/deepseek-v4-flash` becomes `deepseek-v4-flash`. If that short form
 * would collide with another model, both fall back to a sanitized full id. A
 * residual collision is a hard error rather than a silent overwrite.
 */
export function configKeys(entries: readonly CatalogEntry[]): Map<string, string> {
  const shortCounts = new Map<string, number>()
  for (const entry of entries) {
    const short = shortKey(entry.id)
    shortCounts.set(short, (shortCounts.get(short) ?? 0) + 1)
  }

  const keys = new Map<string, string>()
  const used = new Set<string>()
  for (const entry of entries) {
    const short = shortKey(entry.id)
    const key = (shortCounts.get(short) ?? 0) > 1 ? sanitize(entry.id) : short
    if (used.has(key)) {
      throw new ConfigKeyError(`Duplicate model key ${key} (from ${entry.id})`)
    }
    used.add(key)
    keys.set(entry.id, key)
  }
  return keys
}

function shortKey(id: string): string {
  const slash = id.lastIndexOf("/")
  return (slash >= 0 ? id.slice(slash + 1) : id).toLowerCase()
}

function sanitize(id: string): string {
  return id.toLowerCase().replace(/[/:]/g, "-")
}

export function displayName(entry: CatalogEntry, planHint: boolean): string {
  if (!planHint || PLAN_RANK[entry.minPlan] === 0) return entry.name
  const label = PLAN_LABELS[entry.minPlan]
  return `${entry.name} (${entry.minPlan === "max" ? label : `${label}+`})`
}

export interface ProviderRegistration {
  id: string
  name: string
  npm: string
  /** Provider-level options, merged underneath anything the user already set. */
  options: Record<string, unknown>
  models: Record<string, unknown>
}

/**
 * Builds the `provider` entries to merge into the opencode config.
 *
 * Returns one registration by default and two when `splitAnthropic` is set.
 */
export function buildProviderRegistrations(
  entries: readonly CatalogEntry[],
  options: ProviderConfigOptions,
): ProviderRegistration[] {
  const keys = configKeys(entries)
  const planHint = options.planHint ?? false
  const split = options.splitAnthropic ?? false

  const openaiModels: Record<string, unknown> = {}
  const anthropicModels: Record<string, unknown> = {}

  for (const entry of entries) {
    const key = keys.get(entry.id)!
    const model = modelConfig(entry, {
      planHint,
      // With a dedicated anthropic provider the per-model override is redundant.
      overridePackage: entry.protocol === "anthropic" && !split,
    })
    if (entry.protocol === "anthropic" && split) anthropicModels[key] = model
    else openaiModels[key] = model
  }

  const registrations: ProviderRegistration[] = [
    {
      id: PROVIDER_ID,
      name: "Command Code",
      npm: OPENAI_NPM,
      options: { baseURL: options.baseURL },
      models: openaiModels,
    },
  ]

  if (split) {
    registrations.push({
      id: ANTHROPIC_PROVIDER_ID,
      name: "Command Code (Anthropic)",
      npm: ANTHROPIC_NPM,
      options: { baseURL: options.baseURL },
      models: anthropicModels,
    })
  }

  return registrations
}

interface ModelConfigOptions {
  planHint: boolean
  overridePackage: boolean
}

export function modelConfig(entry: CatalogEntry, options: ModelConfigOptions): Record<string, unknown> {
  const config: Record<string, unknown> = {
    id: entry.id,
    name: displayName(entry, options.planHint),
    reasoning: entry.reasoning,
    tool_call: true,
    attachment: entry.image,
    modalities: {
      input: entry.image ? ["text", "image"] : ["text"],
      output: ["text"],
    },
    cost: {
      input: entry.cost.input,
      output: entry.cost.output,
      cache_read: entry.cost.cacheRead,
      cache_write: entry.cost.cacheWrite,
    },
    limit: {
      context: entry.context,
      output: Math.min(entry.context, entry.maxOutput),
    },
    status: entry.status,
  }

  if (entry.efforts.length > 0) {
    config.variants = Object.fromEntries(
      entry.efforts.map((effort) => [effort, { reasoningEffort: effort }]),
    )
  }

  if (entry.protocol === "anthropic") {
    config.provider = options.overridePackage
      ? { npm: ANTHROPIC_NPM, api: ANTHROPIC_API }
      : { api: ANTHROPIC_API }
  }

  return config
}

/**
 * Merges generated registrations into an existing opencode config object.
 *
 * The provider block is filled in even when the user never declared it, and
 * anything the user set explicitly wins.
 */
export function applyProviderConfig(
  config: Record<string, unknown>,
  registrations: readonly ProviderRegistration[],
): void {
  const existing = config.provider
  const providers: Record<string, Record<string, unknown>> =
    existing !== null && typeof existing === "object" ? (existing as Record<string, Record<string, unknown>>) : {}
  config.provider = providers

  for (const registration of registrations) {
    const target: Record<string, unknown> = providers[registration.id] ?? {}
    providers[registration.id] = target

    target.npm ??= registration.npm
    target.name ??= registration.name
    target.env ??= ["COMMANDCODE_API_KEY"]

    // User-provided options win; generated ones only fill the gaps.
    const userOptions = target.options
    target.options = {
      ...registration.options,
      ...(userOptions !== null && typeof userOptions === "object" ? userOptions : {}),
    }

    const existingModels = target.models
    const models: Record<string, unknown> =
      existingModels !== null && typeof existingModels === "object"
        ? (existingModels as Record<string, unknown>)
        : {}
    target.models = models

    for (const [key, model] of Object.entries(registration.models)) {
      models[key] ??= model
    }
  }
}
