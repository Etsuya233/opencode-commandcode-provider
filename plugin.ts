/**
 * opencode plugin entry point (v2 plugin API).
 *
 * Responsibilities, none of which touch the wire protocol:
 *
 * 1. register the Command Code integration (so `COMMANDCODE_API_KEY` and
 *    opencode's `/connect` both supply the credential), the provider and its
 *    models, resolved from the live catalog;
 * 2. register a slash command that refreshes that catalog in place;
 * 3. nothing else — SSE parsing, tool calls, reasoning blocks and images are
 *    handled by opencode's own AI SDK adapters.
 *
 * opencode replays transforms onto freshly built state and hands the plugin
 * `provider` / `integration` / `command` drafts separately, so the (async)
 * catalog fetch happens up front and each hook application is a synchronous
 * write over the currently selected catalog.
 */

import { appendFileSync } from "node:fs"

import { resolveApiKeyFromFiles } from "./src/auth.ts"
import { resolveCatalog, selectCatalog } from "./src/catalog.ts"
import { COMMAND_CODE_CLI_VERSION, SNAPSHOT } from "./src/catalog.generated.ts"
import { providerConfigFromPluginOptions, resolveConfig, type ResolvedConfig } from "./src/config.ts"
import type { OpencodePlugin, PluginContext } from "./src/opencode-api.ts"
import {
  PROVIDER_ID,
  REFRESH_COMMAND,
  applyIntegrationRegistration,
  applyProviderRegistration,
  buildCatalogRegistration,
  type CatalogRegistration,
} from "./src/opencode.ts"
import { refreshCatalog } from "./src/refresh.ts"
import { COMMANDCODE_RPC, REFRESH_EVENT, type RefreshNotice } from "./src/rpc.ts"

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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A key that only exists in the Command Code CLI's auth file has no integration
 * method, so it is injected into the provider settings instead - and only when
 * no environment variable is set, so an explicit environment always wins.
 */
function fileFallbackKey(config: ResolvedConfig): string | undefined {
  if (!config.authFileFallback || process.env.COMMANDCODE_API_KEY !== undefined) return undefined
  return resolveApiKeyFromFiles()
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

    // Everything the transforms publish is derived from this one value, so a
    // refresh only has to replace it and ask opencode to replay.
    let selected = selectCatalog(result.entries, {
      plan: config.plan,
      includeDeprecated: config.includeDeprecated,
    })

    const buildRegistration = (): CatalogRegistration => {
      const registration = buildCatalogRegistration(selected, {
        baseURL: config.baseURL,
        planHint: config.planHint,
      })
      const fileKey = fileFallbackKey(config)
      if (fileKey !== undefined) {
        registration.provider.settings = { ...registration.provider.settings, apiKey: fileKey }
        debugLog("auth.file-fallback", { source: "auth file" })
      }
      return registration
    }

    await context.integration.transform((draft) => {
      applyIntegrationRegistration(draft, buildRegistration())
    })

    await context.provider.transform((draft) => {
      if (selected.length === 0) return
      applyProviderRegistration(draft, buildRegistration())
    })

    // A refresh can be triggered from any client, but only a terminal can draw
    // a toast, so the result is broadcast and the TUI companion renders it.
    const refreshed = await context.rpc.register(COMMANDCODE_RPC, {})

    /** Fetches the live catalog, republishes it, and reports what changed. */
    const refresh = async (): Promise<string> => {
      const outcome = await refreshCatalog({
        snapshot: SNAPSHOT,
        modelsUrl: config.modelsUrl,
        cachePath: config.cachePath,
        timeoutMs: config.timeoutMs,
      })
      selected = selectCatalog(outcome.entries, {
        plan: config.plan,
        includeDeprecated: config.includeDeprecated,
      })
      // Replays the transforms registered above, so the new catalog is live
      // without restarting opencode.
      await context.provider.reload()
      debugLog("refreshed", { models: selected.length, added: outcome.added.length, retired: outcome.retired.length })
      return `${LOG_PREFIX} ${outcome.summary}; ${selected.length} models registered.`
    }

    await context.command.transform((draft) => {
      draft.add({
        ...REFRESH_COMMAND,
        execute: async ({ sessionID }) => {
          let notice: RefreshNotice
          try {
            notice = { message: await refresh(), variant: "success" }
          } catch (error) {
            notice = { message: `${LOG_PREFIX} refresh failed (${describeError(error)}).`, variant: "error" }
          }
          // Terminal-only by design: a session message would be a model-visible
          // user turn, and the web UI has no plugin notification channel.
          await refreshed.events.emit(REFRESH_EVENT, { ...notice, sessionID }).catch(() => undefined)
        },
      })
    })

    const anthropicCount = selected.filter((entry) => entry.protocol === "anthropic").length
    console.warn(
      `${LOG_PREFIX} registered ${selected.length} models (source: ${result.source}, snapshot: command-code@${COMMAND_CODE_CLI_VERSION}, anthropic: ${anthropicCount})`,
    )

    // Reading back through the host proves the registration landed, and is the
    // cheapest way to notice that a future opencode changed the transform API.
    const registered = await context.model
      .list()
      .then((list) => list.data.filter((model) => model.providerID === PROVIDER_ID).length)
      .catch(() => undefined)
    if (registered !== undefined && registered !== selected.length) {
      console.warn(
        `${LOG_PREFIX} opencode holds ${registered} of the ${selected.length} models this plugin registered`,
      )
    }

    debugLog("registered", {
      models: selected.length,
      hostModelCount: registered ?? null,
      snapshotVersion: COMMAND_CODE_CLI_VERSION,
      anthropic: anthropicCount,
      source: result.source,
      firstKeys: [...buildRegistration().models.keys()].slice(0, 5),
    })
  },
}

export default plugin

/** Re-exported for tooling that wants the registration without a live host. */
export type { CatalogRegistration }
