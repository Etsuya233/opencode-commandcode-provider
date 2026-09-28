/**
 * Turns catalog entries into opencode provider/model registrations.
 *
 * Every field here was verified against a running opencode 2.0.18 (see
 * `scripts/smoke-opencode.ts`), because the published plugin typings do not
 * describe this API:
 *
 * - the picker key is `ModelInfo.id`, while `ModelInfo.modelID` is what goes on
 *   the wire — so models keep their real Command Code ids (`deepseek/…`) while
 *   the picker stays short;
 * - `ModelInfo.package` overrides the provider package per model, which is how
 *   the 9 Claude models reach `/messages` through `@ai-sdk/anthropic` while
 *   everything else uses `@ai-sdk/openai-compatible`;
 * - the credential comes from the *integration*, not from `settings.apiKey`.
 *   Registering an `env` method plus a `key` method makes both
 *   `COMMANDCODE_API_KEY` and opencode's `/connect` work.
 */

import { PLAN_LABELS, PLAN_RANK, type CatalogEntry } from "./types.ts"
import type {
  IntegrationDraft,
  IntegrationMethod,
  ModelInfo,
  ProviderDraft,
  ProviderInfo,
} from "./opencode-api.ts"

export const PROVIDER_ID = "commandcode"
export const PROVIDER_NAME = "Command Code"
export const INTEGRATION_ID = "commandcode"
export const OPENAI_PACKAGE = "aisdk:@ai-sdk/openai-compatible"
export const ANTHROPIC_PACKAGE = "aisdk:@ai-sdk/anthropic"

/** Env vars opencode reads for the credential, in priority order. */
export const API_KEY_ENV_NAMES = ["COMMANDCODE_API_KEY", "COMMAND_CODE_API_KEY"] as const

export class ConfigKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConfigKeyError"
  }
}

export function applyIntegrationRegistration(
  draft: IntegrationDraft,
  registration: CatalogRegistration,
): void {
  const { integration } = registration
  draft.update(integration.integrationID, (reference) => {
    reference.id = integration.integrationID
    reference.name = integration.name
  })
  for (const method of integration.methods) {
    draft.method.update({ integrationID: integration.integrationID, method })
  }
}

/**
 * Registers the provider and all of its models.
 *
 * Models first: `models.update` is what materialises the provider record, and
 * the provider metadata then fills in its name, package and settings.
 */
export function applyProviderRegistration(
  draft: ProviderDraft,
  registration: CatalogRegistration,
): void {
  const { provider, models } = registration

  for (const [key, model] of models) {
    draft.models.update(provider.id, key, (target) => {
      Object.assign(target, model)
    })
  }

  draft.update(provider.id, (target) => {
    target.name = provider.name
    target.activation = provider.activation
    target.package = provider.package
    target.integrationID = provider.integrationID
    // Values already on the record win, so a user override is never clobbered.
    target.settings = { ...provider.settings, ...target.settings }
  })
}

/** Convenience wrapper used by tests and tooling that hold both drafts. */
export function applyCatalogRegistration(
  drafts: { provider: ProviderDraft; integration: IntegrationDraft },
  registration: CatalogRegistration,
): void {
  applyIntegrationRegistration(drafts.integration, registration)
  applyProviderRegistration(drafts.provider, registration)
}

/**
 * Derives the picker key for every entry.
 *
 * `deepseek/deepseek-v4-flash` becomes `deepseek-v4-flash`. When a short form
 * would be ambiguous, both models fall back to a sanitized full id; a residual
 * collision is a hard error rather than a silent overwrite.
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
    if (used.has(key)) throw new ConfigKeyError(`Duplicate model key ${key} (from ${entry.id})`)
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

export interface RegistrationOptions {
  /** Provider API base including the version segment. */
  baseURL: string
  /** Append `(Pro+)` style suffixes so gated models are obvious up front. */
  planHint?: boolean
}

export function buildModelInfo(
  entry: CatalogEntry,
  key: string,
  options: RegistrationOptions,
): ModelInfo {
  return {
    id: key,
    // The picker key and the wire id differ on purpose.
    modelID: entry.id,
    providerID: PROVIDER_ID,
    name: displayName(entry, options.planHint ?? false),
    ...(entry.protocol === "anthropic" ? { package: ANTHROPIC_PACKAGE } : {}),
    capabilities: {
      tools: true,
      input: entry.image ? ["text", "image"] : ["text"],
      output: ["text"],
    },
    variants: buildVariants(entry),
    time: { released: 0 },
    cost: [
      {
        input: entry.cost.input,
        output: entry.cost.output,
        cache: { read: entry.cost.cacheRead, write: entry.cost.cacheWrite },
      },
    ],
    status: entry.status,
    enabled: true,
    limit: {
      context: entry.context,
      output: Math.min(entry.context, entry.maxOutput),
    },
  }
}

/**
 * Reasoning levels become model variants.
 *
 * Variant settings are merged into the request, but the two protocols spell
 * "think harder" differently:
 *
 *  - OpenAI-compatible models take a `reasoning_effort` string.
 *  - Anthropic models take adaptive thinking: a `thinking` block plus an
 *    `output_config.effort`. Adaptive means the model selects its own token
 *    budget, so no per-level budget has to be invented here. This is the same
 *    mechanism the Pi provider uses (`forceAdaptiveThinking`).
 */
function buildVariants(entry: CatalogEntry): ModelInfo["variants"] {
  if (entry.efforts.length === 0) return []
  return entry.efforts.map((effort) =>
    entry.protocol === "anthropic"
      ? // `thinking` plus `effort`: opencode's Anthropic adapter turns this into
        // `thinking: {type: "adaptive"}` and `output_config: {effort}`. A
        // `reasoningConfig` object is silently dropped by its settings schema.
        { id: effort, settings: { thinking: { type: "adaptive", display: "summarized" }, effort } }
      : { id: effort, settings: { reasoningEffort: effort } },
  )
}

export interface IntegrationRegistration {
  integrationID: string
  name: string
  methods: readonly IntegrationMethod[]
}

export interface CatalogRegistration {
  integration: IntegrationRegistration
  provider: ProviderInfo
  /** Picker key to model info, in a stable order. */
  models: Map<string, ModelInfo>
}

export function buildCatalogRegistration(
  entries: readonly CatalogEntry[],
  options: RegistrationOptions,
): CatalogRegistration {
  const keys = configKeys(entries)
  const models = new Map<string, ModelInfo>()

  for (const entry of entries) {
    const key = keys.get(entry.id)!
    models.set(key, buildModelInfo(entry, key, options))
  }

  return {
    integration: {
      integrationID: INTEGRATION_ID,
      name: PROVIDER_NAME,
      methods: [
        { type: "env", names: [...API_KEY_ENV_NAMES] },
        { type: "key", label: "API Key" },
      ],
    },
    provider: {
      id: PROVIDER_ID,
      name: PROVIDER_NAME,
      activation: "auto",
      package: OPENAI_PACKAGE,
      integrationID: INTEGRATION_ID,
      settings: { baseURL: options.baseURL },
    },
    models,
  }
}
