/**
 * opencode plugin entry point.
 *
 * The plugin does exactly two things, and neither of them touches the wire
 * protocol:
 *
 * 1. `config` — resolves the model catalog and registers the provider plus its
 *    models. Transport is left to opencode's bundled AI SDK adapters.
 * 2. `auth` — the `/connect` flow that stores an API key.
 *
 * Everything else (SSE parsing, tool-call mapping, reasoning blocks, images) is
 * handled by opencode itself.
 */

import type { AuthHook, Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin"

import { resolveApiKey } from "./src/auth.ts"
import { resolveCatalog, selectCatalog } from "./src/catalog.ts"
import { SNAPSHOT } from "./src/catalog.generated.ts"
import { providerConfigFromPluginOptions, resolveConfig } from "./src/config.ts"
import { PROVIDER_ID, applyProviderConfig, buildProviderRegistrations } from "./src/provider-config.ts"

const LOG_PREFIX = "[commandcode]"

export default async function commandCodePlugin(
  _input: PluginInput,
  options?: PluginOptions,
): Promise<Hooks> {
  const config = resolveConfig(providerConfigFromPluginOptions(options))

  const auth: AuthHook = {
    provider: PROVIDER_ID,
    methods: [
      {
        type: "api",
        label: "API Key",
        async authorize(inputs) {
          const raw = inputs?.key
          if (typeof raw !== "string") return { type: "failed" as const }
          const key = raw.trim()
          if (key.length === 0) return { type: "failed" as const }
          return { type: "success" as const, key }
        },
      },
    ],
    async loader(getAuth) {
      const stored = await getAuth().catch(() => null)
      const key = resolveApiKey({
        apiKey:
          stored !== null && typeof stored === "object" && "key" in stored && typeof stored.key === "string"
            ? stored.key
            : undefined,
      })
      return key === undefined ? {} : { apiKey: key }
    },
  }

  return {
    async config(input) {
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
        return
      }

      applyProviderConfig(
        input as unknown as Record<string, unknown>,
        buildProviderRegistrations(selected, {
          baseURL: config.baseURL,
          planHint: config.planHint,
          splitAnthropic: config.splitAnthropic,
        }),
      )

      const anthropicCount = selected.filter((entry) => entry.protocol === "anthropic").length
      console.warn(
        `${LOG_PREFIX} registered ${selected.length} models (source: ${result.source}, anthropic: ${anthropicCount})`,
      )
    },
    auth,
  }
}
