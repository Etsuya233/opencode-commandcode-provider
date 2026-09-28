/**
 * opencode plugin entry point (v2 plugin API).
 *
 * Two responsibilities, and neither touches the wire protocol:
 *
 * 1. register the Command Code integration (so `COMMANDCODE_API_KEY` and
 *    opencode's `/connect` both supply the credential) and the provider plus
 *    its models, resolved from the live catalog;
 * 2. nothing else — SSE parsing, tool calls, reasoning blocks and images are
 *    handled by opencode's own AI SDK adapters.
 *
 * opencode calls the transform hooks more than once and hands the plugin
 * `provider` / `integration` drafts separately, so the (async) catalog fetch
 * happens up front and each hook application is a synchronous, idempotent write.
 */

import { appendFileSync } from "node:fs"

import { resolveApiKeyFromFiles } from "./src/auth.ts"
import { resolveCatalog, selectCatalog } from "./src/catalog.ts"
import { COMMAND_CODE_CLI_VERSION, SNAPSHOT } from "./src/catalog.generated.ts"
import { providerConfigFromPluginOptions, resolveConfig } from "./src/config.ts"
import type { OpencodePlugin, PluginContext } from "./src/opencode-api.ts"
import {
  PROVIDER_ID,
  applyIntegrationRegistration,
  applyProviderRegistration,
  buildCatalogRegistration,
  type CatalogRegistration,
} from "./src/opencode.ts"

const LOG_PREFIX = "[commandcode]"

/**
 * Opt-in diagnostics: `COMMANDCODE_DEBUG_LOG=/path/to/file` appends one JSON
 * line per catalog decision. Hosts routinely swallow plugin `console` output,
 * so this is the only reliable way to see what the plugin decided.
 */
function debugLog(event: string, details: Record<string, unknown>): void {
  const path = process.env.COMMANDCODE_DEBUG_LOG
  if (path === undefined || path.length === 0) return
  try {
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`)
  } catch {
    // Diagnostics must never break the provider.
  }
}

const plugin: OpencodePlugin = {
  id: PROVIDER_ID,

  async setup(context: PluginContext): Promise<void> {
    const config = resolveConfig(providerConfigFromPluginOptions(context.options))
    debugLog("setup", { modelsUrl: config.modelsUrl, cachePath: config.cachePath, plan: config.plan ?? null })

    const result = await resolveCatalog({
      snapshot: SNAPSHOT,
      modelsUrl: config.modelsUrl,
      cachePath: config.cachePath,
      timeoutMs: config.timeoutMs,
      ttlMs: config.ttlMs,
      offline: config.offline,
    })

    if (result.warning !== undefined) console.warn(`${LOG_PREFIX} ${result.warning}`)

    const selected = selectCatalog(result.entries, {
      plan: config.plan,
      includeDeprecated: config.includeDeprecated,
    })

    if (selected.length === 0) {
      console.warn(
        `${LOG_PREFIX} no models to register (catalog source: ${result.source}, entries: ${result.entries.length})`,
      )
      debugLog("skip", { reason: "no models selected", source: result.source })
      return
    }

    const registration = buildCatalogRegistration(selected, {
      baseURL: config.baseURL,
      planHint: config.planHint,
    })

    // The integration covers the env var and `/connect`. A key that only exists
    // in the Command Code CLI's auth file has no integration method, so it is
    // injected into the provider settings instead - and only when no env var is
    // set, so an explicit environment always wins.
    if (config.authFileFallback && process.env.COMMANDCODE_API_KEY === undefined) {
      const fileKey = resolveApiKeyFromFiles()
      if (fileKey !== undefined) {
        registration.provider.settings = { ...registration.provider.settings, apiKey: fileKey }
        debugLog("auth.file-fallback", { source: "auth file" })
      }
    }

    await context.integration.transform((draft) => {
      applyIntegrationRegistration(draft, registration)
    })
    await context.provider.transform((draft) => {
      applyProviderRegistration(draft, registration)
    })

    const anthropicCount = selected.filter((entry) => entry.protocol === "anthropic").length
    console.warn(
      `${LOG_PREFIX} registered ${selected.length} models (source: ${result.source}, snapshot: command-code@${COMMAND_CODE_CLI_VERSION}, anthropic: ${anthropicCount})`,
    )
    debugLog("registered", {
      models: selected.length,
      snapshotVersion: COMMAND_CODE_CLI_VERSION,
      anthropic: anthropicCount,
      source: result.source,
      providerSettings: Object.keys(registration.provider.settings ?? {}),
      firstKeys: [...registration.models.keys()].slice(0, 5),
    })
  },
}

export default plugin

/** Re-exported for tooling that wants the registration without a live host. */
export type { CatalogRegistration }
