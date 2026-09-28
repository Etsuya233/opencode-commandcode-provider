# Contributing

## Development

No bun, no test framework, no bundler — Node 22.18+ strips types and runs the tests straight from the sources. The one build step exists for the published artifact only: Node refuses to strip types under `node_modules`, so npm gets compiled `dist/` while the checkout keeps running `index.ts` untouched.

```bash
npm run build      # tsc -p tsconfig.build.json → dist/ (what npm publishes)
npm test           # node --test
npm run typecheck  # tsc --noEmit
npm run smoke      # end-to-end test against a real opencode + a local mock API
npm run sync       # regenerate src/catalog.generated.ts from command-code@latest
npm run sync:check # fail when the snapshot drifts (CI)
npm run models     # regenerate docs/models.md
```

## Why there is a smoke test

opencode's plugin API is undocumented, and the published `@opencode-ai/plugin` typings do **not** describe the runtime that opencode 2.0.18 actually loads: the runtime hands a plugin `provider`, `model` and `integration` drafts, registers models through `draft.models.update`, and takes the wire model id from `ModelInfo.modelID`. The unit tests therefore cover the pure logic, and `npm run smoke` covers the contract: it starts a mock Provider API, asks a real opencode to run this plugin against it, and asserts the URL, the wire model id, the forwarded credential and the reasoning payload for both protocols. It also invokes `/commandcode-refresh` through opencode's HTTP API — `opencode run` does not parse slash commands — and checks that a fresh cache was refetched, which is what proves the reload path works. The toast itself is not asserted there: the RPC event goes to connected terminals, and the smoke harness is headless.

Two harness details are worth knowing if you extend it:

- the child process must inherit stdin. An open pipe makes `opencode run` wait forever, and a closed one makes it skip local plugins entirely;
- opencode resolves its project from the **`PWD` environment variable** rather than the process working directory, so the test points `PWD` at the throwaway project.

## How `sync` reads the CLI package

`npm run sync` downloads the `command-code` package from the npm registry and reads two of its files:

- `dist/bundled/command-code-knowledge/reference/models.md` — the documented catalog (ids, names, context, effort levels, advertised per-1M prices with promotions already applied, minimum plan);
- `dist/cli.mjs` — two literals: the text-only model set and per-model `maxOutputTokens`.

Both are read with string scans and `JSON.parse`. There is no `eval`, no `new Function`, and no deobfuscation pass, and any unexpected shape fails the run instead of producing wrong data. Pass `--from <dir>` to use an already unpacked package.

## Generated files

Do not edit these by hand:

- `src/catalog.generated.ts` — written by `npm run sync`.
- `docs/models.md` — written by `npm run models`, which must be rerun after `sync`.

CI fails if either file drifts from the committed snapshot.
