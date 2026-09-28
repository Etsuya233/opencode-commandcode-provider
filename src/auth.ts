/**
 * API key resolution.
 *
 * Mirrors the credential locations the Command Code CLI and neighbouring
 * agents already use, so an existing login keeps working:
 * `COMMANDCODE_API_KEY`, `~/.commandcode/auth.json`, `~/.pi/agent/auth.json`,
 * `~/.omp/agent/auth.json`.
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface ResolveApiKeyOptions {
  apiKey?: string | undefined
  env?: Record<string, string | undefined> | undefined
  home?: string | undefined
}

export function authFilePaths(home: string = homedir()): readonly string[] {
  return [
    join(home, ".commandcode", "auth.json"),
    join(home, ".pi", "agent", "auth.json"),
    join(home, ".omp", "agent", "auth.json"),
  ]
}

function keyFromAuthFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"))
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined

  const record = parsed as Record<string, unknown>
  if (typeof record.apiKey === "string" && record.apiKey.length > 0) return record.apiKey

  for (const key of ["commandcode", "command-code"]) {
    const value = record[key]
    if (typeof value === "string" && value.length > 0) return value
    if (typeof value === "object" && value !== null) {
      const nested = value as Record<string, unknown>
      if (typeof nested.key === "string" && nested.key.length > 0) return nested.key
      if (typeof nested.access === "string" && nested.access.length > 0) return nested.access
      if (typeof nested.apiKey === "string" && nested.apiKey.length > 0) return nested.apiKey
    }
  }

  return undefined
}

export function resolveApiKey(options: ResolveApiKeyOptions = {}): string | undefined {
  if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey

  const fromEnv = options.env?.COMMANDCODE_API_KEY ?? options.env?.COMMAND_CODE_API_KEY
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  if (options.env === undefined) {
    const processKey = process.env.COMMANDCODE_API_KEY ?? process.env.COMMAND_CODE_API_KEY
    if (processKey !== undefined && processKey.length > 0) return processKey
  }

  for (const path of authFilePaths(options.home)) {
    const key = keyFromAuthFile(path)
    if (key !== undefined) return key
  }

  return undefined
}
