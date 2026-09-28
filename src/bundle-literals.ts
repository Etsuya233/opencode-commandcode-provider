/**
 * Extract model metadata from `dist/cli.mjs` of the `command-code` package.
 *
 * The bundle is minified, so the only reliable anchors are the identifiers the
 * bundler kept via `__name(...)` and the model ids themselves. Everything here
 * is a string scan followed by `JSON.parse` on literals — **no `eval`, no
 * `new Function`, no deobfuscation pass**. That keeps this file auditable and
 * makes it fail loudly (rather than silently producing wrong data) when the
 * upstream bundle shape changes.
 *
 * What the bundle knows that `models.md` does not:
 *
 * - which models are reasoning models (`reasoning:!0` / `reasoningEfforts:[`);
 *   the doc's `Efforts` column being `—` only means "the model picks its own
 *   depth", not "not a reasoning model";
 * - a text-only model set, used to derive image input support;
 * - a per-model `maxOutputTokens`, documented for a handful of models only.
 */

export const TEXT_ONLY_MARKER = ',__name(isKnownTextOnlyModel,"isKnownTextOnlyModel")'
export const TEXT_ONLY_SET_PREFIX = "new Set(["

export interface BundleModelLiterals {
  reasoning: boolean
  /** `null` when the object has no `reasoningEfforts` array. */
  efforts: readonly string[] | null
  /** `null` when the object has no `maxOutputTokens`. */
  maxOutput: number | null
}

export class BundleLiteralsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BundleLiteralsError"
  }
}

/**
 * The set of models Command Code deliberately keeps text-only. Membership is
 * checked by identity, so it must never be treated as "all other models are
 * vision capable and this list is exhaustive".
 */
export function parseTextOnlyModelIds(bundle: string): readonly string[] {
  const markerIndex = bundle.indexOf(TEXT_ONLY_MARKER)
  if (markerIndex < 0) {
    throw new BundleLiteralsError("Could not find Command Code's isKnownTextOnlyModel catalog")
  }

  const setStart = bundle.lastIndexOf(TEXT_ONLY_SET_PREFIX, markerIndex)
  if (setStart < 0) throw new BundleLiteralsError("Could not find the text-only model set")

  const arrayStart = setStart + "new Set(".length
  const literal = bundle.slice(arrayStart, markerIndex - 1)
  const parsed: unknown = JSON.parse(literal)
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new BundleLiteralsError("Expected the text-only model catalog to be an array of strings")
  }
  return parsed as string[]
}

/**
 * Returns the full object literal for a model, brace balanced and quote aware.
 *
 * Minified object literals interleave nested objects, escaped strings and
 * template literals, so a plain `indexOf("}")` would truncate at the first
 * nested close. Returns `null` when the model is not present in the bundle.
 */
export function findModelObject(bundle: string, id: string): string | null {
  const start = bundle.indexOf(`{id:${JSON.stringify(id)}`)
  if (start < 0) return null

  let depth = 0
  let quote = ""
  let escaped = false

  for (let index = start; index < bundle.length; index += 1) {
    const character = bundle[index]!
    if (quote) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === quote) quote = ""
      continue
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character
      continue
    }
    if (character === "{") depth += 1
    else if (character === "}" && --depth === 0) return bundle.slice(start, index + 1)
  }

  return null
}

/** Minified booleans appear as `!0` / `!1`, unminified builds as `true`. */
export function parseReasoning(objectText: string): boolean {
  return (
    objectText.includes("reasoning:!0") ||
    objectText.includes("reasoning:true") ||
    objectText.includes("reasoningEfforts:[")
  )
}

export function parseEffortsFromObject(objectText: string): readonly string[] | null {
  const match = /reasoningEfforts:(\[[^\]]*\])/.exec(objectText)
  if (!match) return null
  const parsed: unknown = JSON.parse(match[1]!)
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new BundleLiteralsError("Expected reasoningEfforts to be an array of strings")
  }
  return parsed as string[]
}

export function parseMaxOutputTokensFromObject(objectText: string): number | null {
  const match = /maxOutputTokens:([^,}]+)/.exec(objectText)
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) {
    throw new BundleLiteralsError(`Unexpected maxOutputTokens value: ${match[1]}`)
  }
  return value
}

/**
 * Collects literals for every requested id. Throws when an id is missing from
 * the bundle, because that means the md/bundle pair is inconsistent and the
 * generated snapshot would be silently incomplete.
 */
export function collectBundleLiterals(
  bundle: string,
  ids: readonly string[],
): Map<string, BundleModelLiterals> {
  const result = new Map<string, BundleModelLiterals>()
  const missing: string[] = []

  for (const id of ids) {
    const objectText = findModelObject(bundle, id)
    if (objectText === null) {
      missing.push(id)
      continue
    }
    result.set(id, {
      reasoning: parseReasoning(objectText),
      efforts: parseEffortsFromObject(objectText),
      maxOutput: parseMaxOutputTokensFromObject(objectText),
    })
  }

  if (missing.length > 0) {
    throw new BundleLiteralsError(
      `${missing.length} model(s) from models.md are missing from the CLI bundle: ${missing.join(", ")}`,
    )
  }

  return result
}
