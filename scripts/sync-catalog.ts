#!/usr/bin/env node
/**
 * Regenerates `src/catalog.generated.ts` from a published `command-code`
 * package.
 *
 * The package is fetched straight from the npm registry and unpacked with
 * `tar`; no `bun`, no dev dependency on the CLI, and no `eval` of the minified
 * bundle. Pass `--from <dir>` to use an already unpacked package directory
 * (useful offline and in tests).
 *
 * Usage:
 *   node scripts/sync-catalog.ts                     # write from command-code@latest
 *   node scripts/sync-catalog.ts --check             # exit 1 when drifted (CI)
 *   node scripts/sync-catalog.ts --from /tmp/pkg     # write from a local package
 */

import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { buildSnapshot, renderCatalogModule } from "../src/snapshot.ts"
import { PLAN_IDS, PLAN_LABELS, type SnapshotEntry } from "../src/types.ts"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const OUTPUT_PATH = join(ROOT, "src", "catalog.generated.ts")
const PACKAGE_NAME = "command-code"
const MODELS_DOC_PATH = "dist/bundled/command-code-knowledge/reference/models.md"
const CLI_BUNDLE_PATH = "dist/cli.mjs"

interface Args {
  check: boolean
  from: string | undefined
  spec: string
}

function parseArgs(argv: readonly string[]): Args {
  let check = false
  let from: string | undefined
  let spec = `${PACKAGE_NAME}@latest`

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--check") check = true
    else if (arg === "--from") {
      from = argv[index + 1]
      index += 1
    } else if (arg?.startsWith(`${PACKAGE_NAME}@`)) spec = arg
  }

  return { check, from, spec }
}

interface ResolvedPackage {
  directory: string
  version: string
  cleanup: () => void
}

async function downloadPackage(spec: string): Promise<ResolvedPackage> {
  const versionSpec = spec === `${PACKAGE_NAME}@latest` ? "latest" : spec.slice(PACKAGE_NAME.length + 1)
  const registryUrl = `https://registry.npmjs.org/${PACKAGE_NAME}/${versionSpec}`

  console.log(`Fetching ${spec} metadata from npm...`)
  const metadataResponse = await fetch(registryUrl)
  if (!metadataResponse.ok) {
    throw new Error(`npm registry returned ${metadataResponse.status} for ${registryUrl}`)
  }
  const metadata = (await metadataResponse.json()) as { version?: unknown; dist?: { tarball?: unknown } }
  const version = metadata.version
  const tarball = metadata.dist?.tarball
  if (typeof version !== "string" || typeof tarball !== "string") {
    throw new Error("npm registry response did not contain a version and tarball")
  }

  const directory = mkdtempSync(join(tmpdir(), "commandcode-snapshot-"))
  const cleanup = (): void => rmSync(directory, { recursive: true, force: true })

  console.log(`  version ${version}`)
  console.log(`  downloading ${tarball}`)
  const tarballResponse = await fetch(tarball)
  if (!tarballResponse.ok) throw new Error(`tarball download returned ${tarballResponse.status}`)
  const archivePath = join(directory, "package.tgz")
  writeFileSync(archivePath, Buffer.from(await tarballResponse.arrayBuffer()))

  execFileSync("tar", ["-xzf", archivePath, "-C", directory], { stdio: "pipe" })
  rmSync(archivePath, { force: true })

  return { directory: join(directory, "package"), version, cleanup }
}

function localPackage(directory: string): ResolvedPackage {
  const packageJsonPath = join(directory, "package.json")
  if (!existsSync(packageJsonPath)) throw new Error(`No package.json in ${directory}`)
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { version?: unknown }
  if (typeof parsed.version !== "string") throw new Error(`No version in ${packageJsonPath}`)
  return { directory, version: parsed.version, cleanup: () => undefined }
}

function summarize(entries: readonly SnapshotEntry[]): string {
  const active = entries.filter((entry) => entry.status === "active")
  const lines = [
    `  models:     ${entries.length} (${active.length} active, ${entries.length - active.length} deprecated)`,
    `  protocol:   openai=${entries.filter((e) => e.protocol === "openai").length} anthropic=${entries.filter((e) => e.protocol === "anthropic").length}`,
    `  reasoning:  ${entries.filter((e) => e.reasoning).length}`,
    `  effort set: ${entries.filter((e) => e.efforts.length > 0).length}`,
    `  vision:     ${entries.filter((e) => e.image).length}`,
    `  priced:     ${entries.filter((e) => e.cost.input > 0 || e.cost.output > 0).length}`,
  ]

  const cumulative = PLAN_IDS.map((plan, index) => {
    const plans = PLAN_IDS.slice(0, index + 1)
    const count = active.filter((entry) => plans.includes(entry.minPlan)).length
    return `${PLAN_LABELS[plan]}>=${count}`
  })
  lines.push(`  reachable:  ${cumulative.join("  ")}`)

  const deprecated = entries.filter((entry) => entry.status === "deprecated").map((entry) => entry.id)
  if (deprecated.length > 0) lines.push(`  retired:    ${deprecated.join(", ")}`)

  return lines.join("\n")
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const resolved = args.from !== undefined ? localPackage(args.from) : await downloadPackage(args.spec)

  try {
    const markdown = readFileSync(join(resolved.directory, MODELS_DOC_PATH), "utf-8")
    const bundle = readFileSync(join(resolved.directory, CLI_BUNDLE_PATH), "utf-8")
    const { entries, warnings } = buildSnapshot(markdown, bundle)

    console.log(`\nParsed command-code@${resolved.version}:`)
    console.log(summarize(entries))
    for (const warning of warnings) console.log(`  WARN ${warning}`)

    const rendered = renderCatalogModule(entries, { packageVersion: resolved.version })
    const current = existsSync(OUTPUT_PATH) ? readFileSync(OUTPUT_PATH, "utf-8") : ""

    if (current === rendered) {
      console.log("\nSnapshot is up to date.")
      return
    }

    if (args.check) {
      console.error(
        `\n::error::src/catalog.generated.ts is out of date with ${PACKAGE_NAME}@${resolved.version}. Run \`npm run sync\` and commit the result.`,
      )
      process.exitCode = 1
      return
    }

    writeFileSync(OUTPUT_PATH, rendered, "utf-8")
    console.log(`\nWrote ${OUTPUT_PATH}`)
  } finally {
    resolved.cleanup()
  }
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
