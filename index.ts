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
  ANTHROPIC_API,
  ANTHROPIC_NPM,
  ANTHROPIC_PROVIDER_ID,
  ConfigKeyError,
  OPENAI_NPM,
  PROVIDER_ID,
  applyProviderConfig,
  buildProviderRegistrations,
  configKeys,
  displayName,
  modelConfig,
  type ProviderConfigOptions,
  type ProviderRegistration,
} from "./src/provider-config.ts"

export { authFilePaths, resolveApiKey, type ResolveApiKeyOptions } from "./src/auth.ts"

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
