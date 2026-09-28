/**
 * Parser for `dist/bundled/command-code-knowledge/reference/models.md`, the
 * model catalog that ships inside the `command-code` npm package.
 *
 * This file is a plain Markdown document generated from Command Code's own
 * docs, so parsing it is deterministic and needs no reverse engineering:
 *
 * ```
 * ## Anthropic
 *
 * | Id (use EXACTLY this) | Name | Context | Efforts | $/1M in/out · cache read | Min plan | Best for |
 * |---|---|---|---|---|---|---|
 * | `claude-opus-4-7` | Claude Opus 4.7 | 1M | low, medium, high, xhigh, max | $5/$25 · cache $0.5 (write $6.25) | Max | older Opus, still strong for agents and coding |
 * ```
 *
 * Two documented conventions drive the mapping:
 *
 * - the `Efforts` column is `—` when the model decides its own reasoning depth.
 *   That does *not* mean the model is not a reasoning model; reasoning
 *   capability comes from the CLI bundle instead (see `bundle-literals.ts`).
 * - a `—` in the `Context` column marks a retired model that is still listed by
 *   the API. Those become `status: "deprecated"`.
 */

import type { ModelCost, PlanId, Protocol } from "./types.ts"

export interface MdModel {
  id: string
  name: string
  /** Section heading the row appeared under, e.g. `Anthropic`. */
  section: string
  protocol: Protocol
  /** `null` when the doc reports `—`, i.e. the model is retired. */
  context: number | null
  efforts: readonly string[]
  cost: ModelCost
  minPlan: PlanId
}

/** Anthropic-protocol models are grouped under their own section. */
export const ANTHROPIC_SECTION = "Anthropic"

export function protocolForSection(section: string): Protocol {
  return section === ANTHROPIC_SECTION ? "anthropic" : "openai"
}

const SECTION_RE = /^##\s+(.+?)\s*$/
const ROW_RE = /^\|\s*`([^`]+)`\s*\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|/
const CONTEXT_RE = /^([\d.]+)\s*([MK])?$/
const PRICE_RE = /\$\s*([\d.]+)\s*\/\s*\$\s*([\d.]+)\s*·\s*cache\s*\$\s*([\d.]+)(?:\s*\(write\s*\$\s*([\d.]+)\))?/

const PLAN_BY_PREFIX: Readonly<Record<string, PlanId>> = {
  go: "go",
  goat: "goat",
  pro: "pro",
  max: "max",
}

export class ModelsDocError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ModelsDocError"
  }
}

export function parseContext(raw: string): number | null {
  const value = raw.trim()
  if (value === "—" || value === "-" || value === "") return null
  const match = CONTEXT_RE.exec(value)
  if (!match) throw new ModelsDocError(`Unrecognized context window: ${JSON.stringify(raw)}`)
  const amount = Number(match[1])
  const unit = match[2]
  if (unit === "M") return amount * 1_000_000
  if (unit === "K") return amount * 1_000
  return amount
}

export function parseCost(raw: string): ModelCost {
  const match = PRICE_RE.exec(raw)
  if (!match) throw new ModelsDocError(`Unrecognized price cell: ${JSON.stringify(raw)}`)
  return {
    input: Number(match[1]),
    output: Number(match[2]),
    cacheRead: Number(match[3]),
    cacheWrite: match[4] === undefined ? 0 : Number(match[4]),
  }
}

export function parsePlan(raw: string): PlanId {
  const first = raw.trim().split(/\s+/)[0]?.toLowerCase() ?? ""
  const plan = PLAN_BY_PREFIX[first]
  if (!plan) throw new ModelsDocError(`Unrecognized plan: ${JSON.stringify(raw)}`)
  return plan
}

export function parseEfforts(raw: string): readonly string[] {
  const value = raw.trim()
  if (value === "—" || value === "-" || value === "") return []
  return value.split(",").map((effort) => effort.trim()).filter((effort) => effort.length > 0)
}

/** Parses the whole document. Throws `ModelsDocError` on any row it cannot read. */
export function parseModelsDoc(markdown: string): MdModel[] {
  const models: MdModel[] = []
  const seen = new Set<string>()
  let section = ""

  for (const line of markdown.split(/\r?\n/)) {
    const heading = SECTION_RE.exec(line)
    if (heading) {
      section = heading[1]!.trim()
      continue
    }

    const row = ROW_RE.exec(line)
    if (!row) continue

    const id = row[1]!.trim()
    if (seen.has(id)) throw new ModelsDocError(`Duplicate model id in reference: ${id}`)
    seen.add(id)

    models.push({
      id,
      name: row[2]!.trim(),
      section,
      protocol: protocolForSection(section),
      context: parseContext(row[3]!),
      efforts: parseEfforts(row[4]!),
      cost: parseCost(row[5]!),
      minPlan: parsePlan(row[6]!),
    })
  }

  if (models.length === 0) throw new ModelsDocError("No model rows found in models.md")
  return models
}
