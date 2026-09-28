import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "commandcode-models.ts")

function run(args: readonly string[], env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  })
  return { status: result.status, stdout: result.stdout }
}

test("status prints the catalog state without touching the network", () => {
  const result = run(["status", "--offline"], { COMMANDCODE_MODELS_CACHE: join(tmpdir(), "commandcode-absent.json") })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /command-code snapshot:\s+1\./)
  assert.match(result.stdout, /cache state:/)
})

test("the entry point is detected through a launcher symlink", (t) => {
  // `npm install -g` and `npm link` run the CLI through a symlink in
  // `node_modules/.bin`, so `argv[1]` and `import.meta.url` disagree. Comparing
  // them as plain strings silently turned the CLI into a no-op.
  const dir = mkdtempSync(join(tmpdir(), "commandcode-cli-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const link = join(dir, "commandcode-models.ts")
  try {
    symlinkSync(CLI, link, "file")
  } catch {
    t.skip("this system does not allow the test to create symlinks")
    return
  }

  const result = spawnSync(process.execPath, [link, "status", "--offline"], {
    encoding: "utf8",
    env: { ...process.env, COMMANDCODE_MODELS_CACHE: join(dir, "absent.json") },
  })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /command-code snapshot:/)
})

test("an unknown command is reported on stderr", () => {
  const result = spawnSync(process.execPath, [CLI, "nonsense"], { encoding: "utf8" })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Unknown command: nonsense/)
})
