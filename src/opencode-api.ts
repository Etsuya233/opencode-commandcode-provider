/**
 * Structural types for the opencode plugin runtime.
 *
 * These are declared locally rather than imported from `@opencode-ai/plugin`,
 * because the published type package and the runtime disagree: the published
 * declarations expose a single `catalog` domain, while opencode 2.0.18 hands
 * the plugin `provider`, `model` and `integration` domains with different field
 * names (`package`/`settings` instead of `api`, `modelID` for the wire id).
 *
 * The shapes below were read off the live runtime and are exercised end to end
 * by `npm run smoke`. Keep them minimal: only what this provider actually uses.
 */

export interface ProviderInfo {
  id: string
  name: string
  /** `auto` lets opencode decide when the provider is active. */
  activation: string
  /** `aisdk:<npm package>` for a third-party AI SDK provider. */
  package: string
  settings?: Record<string, unknown>
  headers?: Record<string, string>
  /** Links the provider to the integration that supplies its credential. */
  integrationID?: string
}

export interface ModelVariantInfo {
  id: string
  settings: Record<string, unknown>
}

export interface ModelCostInfo {
  tier?: { type: "context"; size: number }
  input: number
  output: number
  cache: { read: number; write: number }
}

export interface ModelInfo {
  /** Picker key: what follows `provider/` when selecting a model. */
  id: string
  /** Model id sent on the wire. */
  modelID: string
  providerID: string
  name: string
  /** Per-model override of the provider package, e.g. the Anthropic adapter. */
  package?: string
  capabilities: {
    tools: boolean
    input: string[]
    output: string[]
  }
  variants: ModelVariantInfo[]
  time: { released: number }
  cost: ModelCostInfo[]
  status: "alpha" | "beta" | "deprecated" | "active"
  enabled: boolean
  limit: { context: number; input?: number; output: number }
}

export interface ProviderRecord {
  provider: ProviderInfo
  models: Map<string, ModelInfo>
}

export interface ProviderDraft {
  list(): readonly ProviderRecord[]
  get(providerID: string): ProviderRecord | undefined
  /** Contributes a provider together with its models. */
  add(input: { info: ProviderInfo; models: readonly ModelInfo[] }): void
  update(providerID: string, update: (provider: ProviderInfo) => void): void
  remove(providerID: string): void
  models: {
    /** Replaces a provider's inventory. */
    set(providerID: string, models: readonly ModelInfo[]): void
    update(providerID: string, modelID: string, update: (model: ModelInfo) => void): void
    remove(providerID: string, modelID: string): void
  }
}

export type IntegrationMethod = { type: "key"; label?: string } | { type: "env"; names: string[] }

export interface IntegrationRef {
  id: string
  name: string
}

export interface IntegrationDraft {
  list(): readonly IntegrationRef[]
  get(integrationID: string): IntegrationRef | undefined
  update(integrationID: string, update: (integration: IntegrationRef) => void): void
  remove(integrationID: string): void
  method: {
    list(integrationID: string): readonly IntegrationMethod[]
    update(input: { integrationID: string; method: IntegrationMethod }): void
    remove(integrationID: string, method: IntegrationMethod): void
  }
}

export interface Registration {
  dispose(): Promise<void>
}

/** A slash command. The executor runs when the user submits `/name`. */
export interface CommandDefinition {
  name: string
  description?: string
  execute(input: { sessionID: string; prompt: { text: string }; delivery: "steer" | "queue" }): Promise<void>
}

export interface CommandDraft {
  add(definition: CommandDefinition): void
}

export interface PluginContext {
  options: Record<string, unknown>
  provider: {
    transform(callback: (draft: ProviderDraft) => void): Promise<Registration>
    /** Replays the active transforms after captured data changes. */
    reload(): Promise<void>
  }
  integration: { transform(callback: (draft: IntegrationDraft) => void): Promise<Registration> }
  command: { transform(callback: (draft: CommandDraft) => void): Promise<Registration> }
  session: {
    synthetic(input: { sessionID: string; text: string; description?: string; resume?: boolean }): Promise<unknown>
  }
  /** Reads every registered model, including the ones registered above. */
  model: { list(): Promise<{ data: readonly ModelInfo[] }> }
}

export interface OpencodePlugin {
  id: string
  setup(context: PluginContext): Promise<void> | void
}
