import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { authFilePaths, resolveApiKey } from "../src/auth.ts"

function withHome(run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "cc-auth-test-"))
  try {
    run(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

function writeAuth(home: string, relative: string, value: unknown): void {
  const path = join(home, relative)
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}

test("an explicit key wins, then the environment", () => {
  withHome((home) => {
    assert.equal(resolveApiKey({ apiKey: "explicit", env: { COMMANDCODE_API_KEY: "env" }, home }), "explicit")
    assert.equal(resolveApiKey({ env: { COMMANDCODE_API_KEY: "env" }, home }), "env")
    assert.equal(resolveApiKey({ env: { COMMAND_CODE_API_KEY: "legacy" }, home }), "legacy")
    assert.equal(resolveApiKey({ env: {}, home }), undefined)
  })
})

test("reads the credential shapes the CLI and neighbouring agents use", () => {
  withHome((home) => {
    writeAuth(home, ".commandcode/auth.json", { apiKey: "user_plain" })
    assert.equal(resolveApiKey({ env: {}, home }), "user_plain")
  })

  withHome((home) => {
    writeAuth(home, ".commandcode/auth.json", { commandcode: "user_string" })
    assert.equal(resolveApiKey({ env: {}, home }), "user_string")
  })

  withHome((home) => {
    writeAuth(home, ".pi/agent/auth.json", { commandcode: { type: "api", key: "user_nested" } })
    assert.equal(resolveApiKey({ env: {}, home }), "user_nested")
  })

  withHome((home) => {
    writeAuth(home, ".omp/agent/auth.json", { "command-code": { type: "oauth", access: "user_oauth" } })
    assert.equal(resolveApiKey({ env: {}, home }), "user_oauth")
  })
})

test("searches the documented locations in order", () => {
  assert.deepEqual(authFilePaths("/home/example"), [
    join("/home/example", ".commandcode", "auth.json"),
    join("/home/example", ".pi", "agent", "auth.json"),
    join("/home/example", ".omp", "agent", "auth.json"),
  ])
})

test("malformed auth files are skipped, not fatal", () => {
  withHome((home) => {
    writeAuth(home, ".commandcode/auth.json", { nothing: "useful" })
    mkdirSync(join(home, ".pi", "agent"), { recursive: true })
    writeFileSync(join(home, ".pi", "agent", "auth.json"), "{ not json")
    writeAuth(home, ".omp/agent/auth.json", { commandcode: "user_later" })
    assert.equal(resolveApiKey({ env: {}, home }), "user_later")
  })
})
