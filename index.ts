export { default } from "./plugin.ts"

export {
  COMMAND_CODE_CLI_VERSION,
  SNAPSHOT,
} from "./src/catalog.generated.ts"

export {
  CACHE_VERSION,
  CatalogError,
  fetchLiveModels,
  mergeCatalog,
  parseLiveModels,
  readCatalogCache,
  resolveCatalog,
  selectCatalog,
  writeCatalogCache,
  type CatalogCache,
  type CatalogSource,
  type LiveModel,
  type MergeResult,
  type ResolveCatalogOptions,
  type ResolveCatalogResult,
  type SelectOptions,
} from "./src/catalog.ts"

export {
  BundleLiteralsError,
  collectBundleLiterals,
  findModelObject,
  parseEffortsFromObject,
  parseMaxOutputTokensFromObject,
  parseReasoning,
  parseTextOnlyModelIds,
  type BundleModelLiterals,
} from "./src/bundle-literals.ts"

export {
  DEFAULT_API_BASE,
  DEFAULT_PROVIDER_PATH,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TTL_MS,
  defaultCachePath,
  providerConfigFromPluginOptions,
  resolveConfig,
  type ProviderConfigInput,
  type ResolvedConfig,
} from "./src/config.ts"

export {
  ModelsDocError,
  parseContext,
  parseCost,
  parseEfforts,
  parseModelsDoc,
  parsePlan,
  protocolForSection,
  type MdModel,
} from "./src/models-md.ts"

export {
  ANTHROPIC_PACKAGE,
  API_KEY_ENV_NAMES,
  ConfigKeyError,
  INTEGRATION_ID,
  OPENAI_PACKAGE,
  PROVIDER_ID,
  PROVIDER_NAME,
  applyCatalogRegistration,
  applyIntegrationRegistration,
  applyProviderRegistration,
  buildCatalogRegistration,
  buildModelInfo,
  configKeys,
  displayName,
  type CatalogRegistration,
  type IntegrationRegistration,
  type RegistrationOptions,
} from "./src/opencode.ts"

export type {
  IntegrationDraft,
  IntegrationMethod,
  ModelInfo,
  OpencodePlugin,
  PluginContext,
  ProviderDraft,
  ProviderInfo,
} from "./src/opencode-api.ts"

export {
  authFilePaths,
  resolveApiKey,
  resolveApiKeyFromFiles,
  type ResolveApiKeyOptions,
} from "./src/auth.ts"

export { buildSnapshot, renderCatalogModule, type SnapshotResult } from "./src/snapshot.ts"

export {
  DEFAULT_MAX_OUTPUT,
  FALLBACK_CONTEXT,
  PLAN_IDS,
  PLAN_LABELS,
  PLAN_RANK,
  ZERO_COST,
  type CatalogEntry,
  type ContextSource,
  type ModelCost,
  type ModelStatus,
  type PlanId,
  type Protocol,
  type SnapshotEntry,
} from "./src/types.ts"
