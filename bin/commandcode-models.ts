#!/usr/bin/env node
/**
 * Manual catalog maintenance.
 *
 * opencode registers models when it starts and the plugin refreshes a stale
 * cache by itself, so this CLI covers the cases where waiting for a restart is
 * inconvenient or the network is unavailable:
 *
 *   commandcode-models refresh        # fetch the live catalog into the cache
 *   commandcode-models status         # cache path, age, counts, source
 *   commandcode-models list           # print the merged catalog
 *   commandcode-models print-catalog  # dump what will be registered with opencode
 */

import { fileURLToPath } from "node:url"

import {
  fetchLiveModels,
  mergeCatalog,
  readCatalogCache,
  resolveCatalog,
  selectCatalog,
  writeCatalogCache,
} from "../src/catalog.ts"
import { COMMAND_CODE_CLI_VERSION, SNAPSHOT } from "../src/catalog.generated.ts"
import { providerConfigFromPluginOptions, resolveConfig } from "../src/config.ts"
import { buildCatalogRegistration } from "../src/opencode.ts"
import { PLAN_IDS, type CatalogEntry, type PlanId } from "../src/types.ts"

const USAGE = `Usage: commandcode-models <command> [options]

Commands:
  refresh         Fetch the live model catalog and store it in the cache
  status          Report cache location, age and content
  list            Print the merged catalog as a table
  print-catalog   Print the resolved catalog as JSON (what gets registered)

Options:
  --offline       Never touch the network
  --plan <plan>   Declare your plan (${PLAN_IDS.join("|")}) to filter gated models
  --all           Include retired models
  --json          Machine readable output (status, list)
  --help          Show this message
`

export interface CliOptions {
  command: string
  offline: boolean
  plan: PlanId | undefined
  includeDeprecated: boolean
  json: boolean
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    command: "status",
    offline: false,
    plan: undefined,
    includeDeprecated: false,
    json: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--offline") options.offline = true
    else if (arg === "--all") options.includeDeprecated = true
    else if (arg === "--json") options.json = true
    else if (arg === "--plan") {
      const value = argv[index + 1]?.toLowerCase()
      index += 1
      if (value !== undefined && (PLAN_IDS as readonly string[]).includes(value)) options.plan = value as PlanId
    } else if (arg !== undefined && !arg.startsWith("-")) options.command = arg
  }

  return options
}

function configFor(options: CliOptions): ReturnType<typeof resolveConfig> {
  return resolveConfig(providerConfigFromPluginOptions(options.plan === undefined ? {} : { plan: options.plan }))
}

function selectedEntries(entries: readonly CatalogEntry[], options: CliOptions): CatalogEntry[] {
  return selectCatalog(entries, {
    plan: options.plan,
    includeDeprecated: options.includeDeprecated,
  })
}

async function commandRefresh(options: CliOptions): Promise<number> {
  if (options.offline) {
    console.error("refresh cannot run with --offline")
    return 1
  }

  const config = configFor(options)
  try {
    const models = await fetchLiveModels({ url: config.modelsUrl, timeoutMs: config.timeoutMs })
    await writeCatalogCache(config.cachePath, models)
    const merged = mergeCatalog(SNAPSHOT, models)
    console.log(`Fetched ${models.length} models into ${config.cachePath}`)
    console.log(
      `Merged with the command-code@${COMMAND_CODE_CLI_VERSION} snapshot: ${merged.entries.length} models` +
        ` (new: ${merged.added.length}, no longer listed: ${merged.dropped.length})`,
    )
    for (const id of merged.added) console.log(`  new, metadata unknown: ${id}`)
    for (const id of merged.dropped) console.log(`  no longer listed upstream: ${id}`)
    return 0
  } catch (error) {
    console.error(`Refresh failed: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

async function resolveOfflineCacheOnly(config: ReturnType<typeof resolveConfig>): Promise<{
  entries: CatalogEntry[]
  warning: string | undefined
}> {
  const result = await resolveCatalog({
    snapshot: SNAPSHOT,
    modelsUrl: config.modelsUrl,
    cachePath: config.cachePath,
    timeoutMs: config.timeoutMs,
    ttlMs: 0,
    offline: true,
  })
  return { entries: result.entries, warning: result.warning }
}

async function commandStatus(options: CliOptions): Promise<number> {
  const config = configFor(options)
  const cache = await readCatalogCache(config.cachePath)
  const age = cache === null ? null : Date.now() - Date.parse(cache.fetchedAt)
  const stale = age === null || age > config.ttlMs
  const { entries, warning } = await resolveOfflineCacheOnly(config)
  const selected = selectedEntries(entries, options)

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          snapshotVersion: COMMAND_CODE_CLI_VERSION,
          cachePath: config.cachePath,
          modelsUrl: config.modelsUrl,
          ttlMs: config.ttlMs,
          cache:
            cache === null
              ? null
              : { fetchedAt: cache.fetchedAt, models: cache.models.length, ageMs: age, stale },
          mergedModels: entries.length,
          registeredModels: selected.length,
          warning: warning ?? null,
        },
        null,
        2,
      ),
    )
    return 0
  }

  console.log(`command-code snapshot:   ${COMMAND_CODE_CLI_VERSION}`)
  console.log(`models endpoint:         ${config.modelsUrl}`)
  console.log(`cache:                   ${config.cachePath}`)
  if (cache === null) {
    console.log("cache state:             empty (the bundled snapshot is used until a refresh succeeds)")
  } else {
    const hours = ((age ?? 0) / 3_600_000).toFixed(1)
    console.log(
      `cache state:             ${cache.models.length} models, fetched ${hours}h ago${stale ? " (stale)" : " (fresh)"}`,
    )
  }
  console.log(`models registered:       ${selected.length}`)
  return 0
}

async function commandList(options: CliOptions): Promise<number> {
  const config = configFor(options)
  const result = await resolveCatalog({
    snapshot: SNAPSHOT,
    modelsUrl: config.modelsUrl,
    cachePath: config.cachePath,
    timeoutMs: config.timeoutMs,
    ttlMs: 0,
    offline: options.offline,
  })
  const entries = selectedEntries(result.entries, options)

  if (options.json) {
    console.log(JSON.stringify(entries, null, 2))
    return 0
  }

  console.log(`source: ${result.source}   models: ${entries.length}\n`)
  const header = `${"model".padEnd(38)}${"min plan".padEnd(10)}${"protocol".padEnd(11)}${"context".padEnd(10)}${"$/1M in/out".padEnd(15)}reasoning`
  console.log(header)
  console.log("-".repeat(header.length))
  for (const entry of entries) {
    const reasoning = entry.reasoning
      ? `yes${entry.efforts.length > 0 ? ` (${entry.efforts.join("/")})` : " (auto)"}`
      : "no"
    console.log(
      entry.id.padEnd(38) +
        entry.minPlan.padEnd(10) +
        entry.protocol.padEnd(11) +
        String(entry.context).padEnd(10) +
        `$${entry.cost.input}/$${entry.cost.output}`.padEnd(15) +
        reasoning,
    )
  }
  return 0
}

async function commandPrintCatalog(options: CliOptions): Promise<number> {
  const config = configFor(options)
  const result = await resolveCatalog({
    snapshot: SNAPSHOT,
    modelsUrl: config.modelsUrl,
    cachePath: config.cachePath,
    timeoutMs: config.timeoutMs,
    ttlMs: 0,
    offline: options.offline,
  })

  const registration = buildCatalogRegistration(selectedEntries(result.entries, options), {
    baseURL: config.baseURL,
    planHint: config.planHint,
  })

  console.log(
    JSON.stringify(
      {
        integration: registration.integration,
        provider: registration.provider,
        modelCount: registration.models.size,
        models: Object.fromEntries(registration.models),
      },
      null,
      2,
    ),
  )
  return 0
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--help") || argv[0] === "help") {
    process.stdout.write(USAGE)
    return 0
  }

  const options = parseArgs(argv)
  switch (options.command) {
    case "refresh":
      return await commandRefresh(options)
    case "status":
      return await commandStatus(options)
    case "list":
      return await commandList(options)
    case "print-catalog":
      return await commandPrintCatalog(options)
    default:
      process.stderr.write(`Unknown command: ${options.command}\n\n${USAGE}`)
      return 1
  }
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && fileURLToPath(import.meta.url) === entrypoint) {
  process.exitCode = await main()
}
