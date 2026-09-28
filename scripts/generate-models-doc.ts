#!/usr/bin/env node
/**
 * Renders the model table in docs/models.md from the generated snapshot, so the
 * documentation cannot drift away from the catalog. Run after `npm run sync`.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { COMMAND_CODE_CLI_VERSION, SNAPSHOT } from "../src/catalog.generated.ts"
import { PLAN_IDS, PLAN_LABELS, PLAN_RANK, type SnapshotEntry } from "../src/types.ts"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const MODELS_PATH = join(ROOT, "docs", "models.md")
const BEGIN = "<!-- MODELS:BEGIN -->"
const END = "<!-- MODELS:END -->"

function formatContext(context: number | null): string {
  if (context === null) return "—"
  if (context >= 1_000_000) return `${(context / 1_000_000).toFixed(context % 1_000_000 === 0 ? 0 : 2)}M`
  return `${Math.round(context / 1000)}K`
}

function formatCost(entry: SnapshotEntry): string {
  return `$${entry.cost.input}/$${entry.cost.output}`
}

function formatReasoning(entry: SnapshotEntry): string {
  if (!entry.reasoning) return "no"
  return entry.efforts.length > 0 ? entry.efforts.join(", ") : "auto"
}

function planHeader(plan: (typeof PLAN_IDS)[number]): string {
  const rank = PLAN_RANK[plan]
  const reachable = SNAPSHOT.filter(
    (entry) => entry.status === "active" && PLAN_RANK[entry.minPlan] <= rank,
  ).length
  return `${PLAN_LABELS[plan]} (${reachable})`
}

function renderModelsSection(): string {
  const active = SNAPSHOT.filter((entry) => entry.status === "active")
  const rows = [...SNAPSHOT]
    .sort((left, right) => {
      // Cheapest gate first, then name, so the table reads like a price list.
      const byPlan = PLAN_RANK[left.minPlan] - PLAN_RANK[right.minPlan]
      return byPlan !== 0 ? byPlan : left.id.localeCompare(right.id)
    })
    .map((entry) => {
      const name = entry.status === "deprecated" ? `${entry.name} _(retired)_` : entry.name
      return `| \`${entry.id}\` | ${name} | ${PLAN_LABELS[entry.minPlan]} | ${formatContext(entry.context)} | ${formatReasoning(entry)} | ${entry.image ? "yes" : "no"} | ${formatCost(entry)} |`
    })

  const plans = PLAN_IDS.map((plan) => planHeader(plan)).join(" · ")

  return [
    BEGIN,
    `Catalog synced from \`command-code@${COMMAND_CODE_CLI_VERSION}\`: **${SNAPSHOT.length} models** (${active.length} active, ${SNAPSHOT.length - active.length} retired, ${SNAPSHOT.filter((entry) => entry.reasoning).length} reasoning, ${SNAPSHOT.filter((entry) => entry.image).length} vision).`,
    "",
    `Models reachable per plan: ${plans}.`,
    "",
    "| Model | Name | Min plan | Context | Reasoning | Vision | $/1M in/out |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    END,
  ].join("\n")
}

function main(): void {
  const doc = readFileSync(MODELS_PATH, "utf-8")
  const start = doc.indexOf(BEGIN)
  const end = doc.indexOf(END)
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`docs/models.md must contain ${BEGIN} and ${END} markers`)
  }

  const updated = `${doc.slice(0, start)}${renderModelsSection()}${doc.slice(end + END.length)}`
  if (updated === doc) {
    console.log("docs/models.md is up to date.")
    return
  }
  writeFileSync(MODELS_PATH, updated, "utf-8")
  console.log(`Updated ${MODELS_PATH}`)
}

main()
