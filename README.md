# commandcode-opencode-provider

[Command Code](https://commandcode.ai) provider for [opencode](https://opencode.ai), built on Command Code's official **Provider API**.

It registers the full model catalog, keeps it fresh from the live API, and delegates all wire protocol work — SSE parsing, tool calls, reasoning blocks, images — to opencode's own AI SDK adapters. There is no request conversion code and no streaming parser in this package, and it has **zero runtime dependencies**.

## Why this exists

The [`command-code`](https://www.npmjs.com/package/command-code) CLI talks to a private `/alpha/generate` endpoint with a private request envelope, and third-party clients can only reach it by impersonating the CLI (spoofing `x-command-code-version`, sending placeholder `memory`/`taste`/`skills` fields). That is not a supported integration: it breaks whenever the CLI changes, and it cannot be validated.

Command Code's Provider API is documented, versioned, and open to plan holders. This provider uses only that:

| Protocol | Endpoint | Adapter | Models |
|---|---|---|---|
| OpenAI | `/provider/v1/chat/completions` | `@ai-sdk/openai-compatible` | 73 |
| Anthropic | `/provider/v1/messages` | `@ai-sdk/anthropic` | 9 |

Every model that speaks OpenAI exposes `/chat/completions`, so `/responses` never needs to be wired up.

**This provider does not support the Go plan.** Go accounts are not offered Provider API access, and this package deliberately does not fall back to the CLI transport.

## Install

```bash
opencode plugin commandcode-opencode-provider
```

or add it to `opencode.json` by hand:

```json
{
  "plugin": ["commandcode-opencode-provider"]
}
```

For a local checkout, point the plugin at the package directory:

```json
{
  "plugin": ["D:/path/to/commandcode-opencode-provider"]
}
```

That is the whole configuration. The plugin declares the `commandcode` provider, its base URL, and every model at startup — you do not need a `provider` block.

## Connect

Either set the environment variable:

```bash
export COMMANDCODE_API_KEY="user_..."
```

or run `/connect` in opencode, search for **Command Code**, and paste a key.

If you already connected with an earlier Command Code plugin, the key opencode stored for the `commandcode` integration is reused as-is — no re-authentication needed.

Existing credentials are also picked up from the CLI's own auth files (`~/.commandcode/auth.json`, `~/.pi/agent/auth.json`, `~/.omp/agent/auth.json`) when no environment variable is set. Set `COMMANDCODE_AUTH_FILE=0` to disable that fallback.

## Model catalog

Three sources, in decreasing order of freshness:

1. **live** — `GET /provider/v1/models`. Public (no auth needed) and plan-independent: it always returns the whole catalog. It owns the model *list* and the exact context window.
2. **cache** — `~/.cache/opencode/commandcode-models.json`. A cache younger than 6 hours short-circuits the network entirely, so starting opencode never waits on a request. A stale cache is refreshed at startup; if the refresh fails it is used anyway.
3. **snapshot** — `src/catalog.generated.ts`, regenerated from the CLI package's own documentation. It owns pricing, reasoning capability, selectable effort levels, vision support and plan gating, none of which the API exposes.

A model is never dropped for lacking metadata. When the API lists a model the snapshot has not seen yet, it is registered with honest defaults (cost 0, text-only) and reported by `commandcode-models refresh`.

Refresh the cache without waiting for a restart:

```bash
commandcode-models refresh        # fetch the live catalog into the cache
commandcode-models status         # cache path, age, model counts
commandcode-models list           # print the merged catalog
commandcode-models print-catalog  # emit the catalog that gets registered, as JSON
```

The CLI ships with the package. Until it is installed from a registry, link the checkout once and the command is on your `PATH` everywhere:

```bash
npm link            # inside the checkout, run once
```

Deleting the cache file has the same effect as `refresh` — the next start refetches it — and a cache younger than six hours is never refetched, so most of the time there is nothing to do.

## Plans

Command Code gates models per plan, and the gate is enforced **per model by the server**: asking for a model above your plan returns

```
403 MODEL_NOT_IN_PLAN: GPT-5.5 available in Pro and above plans or extra on demand usage
```

Command Code documents that a plan must never be inferred from local files, tokens or API probing, and the models endpoint does not filter by plan either. So this provider:

- registers the whole catalog by default,
- appends the required tier to gated model names, e.g. `GPT-5.5 (Pro+)`,
- passes the server's message through unchanged when a request is rejected.

If you know your plan, declare it and the gated models are filtered out instead:

```json
{
  "plugin": [["commandcode-opencode-provider", { "plan": "goat" }]]
}
```

That filters by the documented minimum plan. It is a convenience, not a security boundary — the server is still the authority.

## Reasoning

`reasoning` and the selectable effort levels come from different places, and both are needed:

- the **CLI bundle** knows which models are reasoning models;
- the **documented table** knows which effort levels you can pick.

Command Code's own documentation is explicit that a `—` in its effort column means *"the model decides its own reasoning depth"*, not "not a reasoning model" — 16 models are in that state today. Models with selectable levels are registered as opencode variants (`low`, `medium`, `high`, `xhigh`, `max`), selected as `provider/model#level` on the command line or from the variant picker.

Variant settings are merged into the outgoing request, and the two protocols spell "think harder" differently:

- **OpenAI-compatible** models get `reasoning_effort`.
- **Anthropic** models get adaptive thinking — `thinking: {type: "adaptive", display: "summarized"}` plus `output_config: {effort}`. Adaptive means the model picks its own token budget, so no per-level budget has to be invented. This is the same mechanism the Pi provider uses, and opencode's Anthropic adapter accepts it as `settings: {thinking, effort}` (a `reasoningConfig` object is silently dropped by its settings schema).

## Options

Plugin options are the second element of the plugin tuple; every one of them also has an environment variable.

| Option | Env | Default | Meaning |
|---|---|---|---|
| `baseURL` | `COMMANDCODE_API_BASE` | `https://api.commandcode.ai/provider/v1` | Provider API base |
| `modelsUrl` | `COMMANDCODE_MODELS_URL` | `<baseURL>/models` | Catalog endpoint |
| `cachePath` | `COMMANDCODE_MODELS_CACHE` | `~/.cache/opencode/commandcode-models.json` | Cache location |
| `timeoutMs` | `COMMANDCODE_MODELS_TIMEOUT_MS` | `5000` | Catalog request timeout |
| `ttlMs` | `COMMANDCODE_MODELS_TTL_MS` | `21600000` (6h) | Cache freshness window |
| `offline` | `COMMANDCODE_MODELS_OFFLINE` | `false` | Never touch the network |
| `plan` | `COMMANDCODE_PLAN` | unset | Filter models above this plan |
| `planHint` | `COMMANDCODE_PLAN_HINT` | `true` without a plan | Append `(Pro+)` style suffixes |
| `includeDeprecated` | `COMMANDCODE_INCLUDE_DEPRECATED` | `false` | Keep retired models in the picker |
| `authFileFallback` | `COMMANDCODE_AUTH_FILE` | `true` | Read a key from the CLI auth files when no env var is set |

## Development

No bun, no test framework, no bundler — Node 22.18+ strips types and runs the tests itself.

```bash
npm test           # node --test
npm run typecheck  # tsc --noEmit
npm run smoke      # end-to-end test against a real opencode + a local mock API
npm run sync       # regenerate src/catalog.generated.ts from command-code@latest
npm run sync:check # fail when the snapshot drifts (CI)
npm run readme     # regenerate the table below
```

### Why there is a smoke test

opencode's plugin API is undocumented, and the published `@opencode-ai/plugin` typings do **not** describe the runtime that opencode 2.0.18 actually loads: the runtime hands a plugin `provider`, `model` and `integration` drafts, registers models through `draft.models.update`, and takes the wire model id from `ModelInfo.modelID`. The unit tests therefore cover the pure logic, and `npm run smoke` covers the contract: it starts a mock Provider API, asks a real opencode to run this plugin against it, and asserts the URL, the wire model id and the forwarded credential for both protocols.

Two harness details are worth knowing if you extend it:

- the child process must inherit stdin. An open pipe makes `opencode run` wait forever, and a closed one makes it skip local plugins entirely;
- opencode resolves its project from the **`PWD` environment variable** rather than the process working directory, so the test points `PWD` at the throwaway project.

`npm run sync` downloads the `command-code` package from the npm registry and reads two of its files:

- `dist/bundled/command-code-knowledge/reference/models.md` — the documented catalog (ids, names, context, effort levels, advertised per-1M prices with promotions already applied, minimum plan);
- `dist/cli.mjs` — two literals: the text-only model set and per-model `maxOutputTokens`.

Both are read with string scans and `JSON.parse`. There is no `eval`, no `new Function`, and no deobfuscation pass, and any unexpected shape fails the run instead of producing wrong data. Pass `--from <dir>` to use an already unpacked package.

## Models

<!-- MODELS:BEGIN -->
Catalog synced from `command-code@1.66.0`: **82 models** (78 active, 4 retired, 69 reasoning, 62 vision).

Models reachable per plan: Go (48) · GOAT (56) · Pro (70) · Max (78).

| Model | Name | Min plan | Context | Reasoning | Vision | $/1M in/out |
|---|---|---|---|---|---|---|
| `deepseek/deepseek-v4-flash` | DeepSeek V4 Flash (latest) | Go | 1M | high, max | no | $0.15/$0.6 |
| `deepseek/deepseek-v4-flash-fast` | DeepSeek V4 Flash Fast | Go | 1M | low, high, max | no | $0.28/$0.56 |
| `deepseek/deepseek-v4-flash-vision-exp` | DeepSeek V4 Flash Vision (exp) | Go | 1M | high, max | yes | $0.15/$0.6 |
| `deepseek/deepseek-v4-pro` | DeepSeek V4 Pro (latest) | Go | 1M | high, max | no | $0.66/$1.98 |
| `deepseek/deepseek-v4.1-flash` | DeepSeek V4.1 Flash | Go | 1M | low, high, max | yes | $0.15/$0.6 |
| `gpt-5.6-luna` | GPT-5.6 Luna | Go | 1.05M | low, medium, high, xhigh, max | yes | $0.2/$1.2 |
| `gpt-6-luna` | GPT-6 Luna | Go | 1.05M | low, medium, high, xhigh, max | yes | $0.1/$0.5 |
| `inclusionai/ling-3.0-flash-sante:free` | Ling 3.0 Flash Sante | Go | 262K | auto | no | $0/$0 |
| `meituan/LongCat-2.0` | LongCat 2.0 | Go | 1.05M | auto | no | $0.3/$1.2 |
| `meta/muse-spark-1.2-contributor` | Muse Spark 1.2 Contributor | Go | 1.05M | low, medium, high, xhigh | yes | $0.1/$0.2 |
| `meta/muse-spark-1.3-contributor` | Muse Spark 1.3 Contributor | Go | 1.05M | low, medium, high, xhigh | yes | $0.1/$0.2 |
| `MiniMaxAI/MiniMax-M2.5` | MiniMax M2.5 | Go | 200K | no | no | $0.3/$1.2 |
| `MiniMaxAI/MiniMax-M2.7` | MiniMax M2.7 _(retired)_ | Go | — | no | no | $0.3/$1.2 |
| `MiniMaxAI/MiniMax-M3` | MiniMax M3 | Go | 1M | low, medium, high | yes | $0.3/$1.2 |
| `moonshotai/Kimi-K2.5` | Kimi K2.5 | Go | 256K | no | yes | $0.6/$3 |
| `moonshotai/Kimi-K2.6` | Kimi K2.6 | Go | 256K | no | yes | $0.95/$4 |
| `moonshotai/Kimi-K2.7-Code` | Kimi K2.7 Code | Go | 256K | auto | yes | $0.95/$4 |
| `moonshotai/Kimi-K2.7-Code-Highspeed` | Kimi K2.7 Code HighSpeed | Go | 262K | auto | yes | $1.9/$8 |
| `moonshotai/Kimi-K3` | Kimi K3 | Go | 1M | low, high, max | yes | $3/$15 |
| `nvidia/nemotron-3-ultra-550b-a55b` | Nemotron 3 Ultra | Go | 1M | auto | no | $0.6/$2.4 |
| `poolside/laguna-s-2.1-free` | Laguna S 2.1 | Go | 256K | auto | no | $0/$0 |
| `Qwen/Qwen3.6-Max-Preview` | Qwen 3.6 Max Preview _(retired)_ | Go | — | auto | no | $1.3/$7.8 |
| `Qwen/Qwen3.6-Plus` | Qwen 3.6 Plus _(retired)_ | Go | — | auto | yes | $0.5/$3 |
| `Qwen/Qwen3.7-Flash` | Qwen 3.7 Flash | Go | 1M | auto | yes | $0.03/$0.13 |
| `Qwen/Qwen3.7-Max` | Qwen 3.7 Max | Go | 1M | auto | no | $2.5/$7.5 |
| `Qwen/Qwen3.7-Plus` | Qwen 3.7 Plus | Go | 1M | auto | yes | $0.4/$1.6 |
| `Qwen/Qwen3.8-27B` | Qwen 3.8 27B | Go | 262K | low, medium, xhigh | yes | $0.4/$3 |
| `Qwen/Qwen3.8-Flash` | Qwen 3.8 Flash | Go | 1M | low, medium, xhigh | yes | $0.16/$0.47 |
| `Qwen/Qwen3.8-Max` | Qwen 3.8 Max | Go | 1M | low, medium, xhigh | yes | $2/$6 |
| `Qwen/Qwen3.8-Max-0902` | Qwen 3.8 Max 0902 | Go | 1M | low, medium, xhigh | yes | $2/$6 |
| `Qwen/Qwen3.8-Omni-Flash` | Qwen 3.8 Omni Flash | Go | 1M | low, medium, xhigh | yes | $0.15/$0.47 |
| `stealth/pixel-canary` | Pixel Canary | Go | 262K | low, medium, xhigh | yes | $0/$0 |
| `stealth/space-bunny-alpha` | Space Bunny Alpha | Go | 1M | low, medium, high | yes | $0/$0 |
| `stepfun/Step-3.5-Flash` | Step 3.5 Flash | Go | 262K | auto | no | $0.09/$0.3 |
| `stepfun/Step-3.7-Flash` | Step 3.7 Flash | Go | 256K | auto | yes | $0.2/$1.15 |
| `stepfun/Step-5-Preview` | Step 5 Preview | Go | 1M | low, medium, high | yes | $1/$2.7 |
| `tencent/hy3-paid` | Tencent Hy3 | Go | 262K | auto | no | $0.14/$0.58 |
| `tencent/hy4-preview` | Tencent Hy4 Preview | Go | 1.05M | low, medium, high | no | $0.834/$2.501 |
| `thinkingmachines/inkling` | Inkling | Go | 256K | auto | yes | $1/$4.05 |
| `thinkingmachines/inkling-small` | Inkling Small | Go | 1M | auto | yes | $0.5/$1.2 |
| `xai/grok-4.5` | Grok 4.5 | Go | 500K | low, medium, high | yes | $2/$6 |
| `xiaomi/mimo-v2.5` | MiMo V2.5 | Go | 1M | no | yes | $0.14/$0.28 |
| `xiaomi/mimo-v2.5-pro` | MiMo V2.5 Pro | Go | 1M | no | no | $0.435/$0.87 |
| `xiaomi/mimo-v2.6-flash` | MiMo V2.6 Flash | Go | 1.05M | no | yes | $0.14/$0.28 |
| `xiaomi/mimo-v2.6-pro` | MiMo V2.6 Pro | Go | 1.05M | no | yes | $0.435/$0.87 |
| `z-ai/glm-5.3-flash` | GLM-5.3 Flash | Go | 1.05M | low, high, max | yes | $0.15/$0.5 |
| `z-ai/glm-5.3-flashx` | GLM-5.3 FlashX | Go | 1M | low, high, max | yes | $0.37/$1.25 |
| `zai-org/GLM-5` | GLM-5 | Go | 200K | no | no | $1/$3.2 |
| `zai-org/GLM-5.1` | GLM-5.1 _(retired)_ | Go | — | no | no | $1.4/$4.4 |
| `zai-org/GLM-5.2` | GLM-5.2 | Go | 1M | high, max | no | $1.4/$4.4 |
| `zai-org/GLM-5.2-Fast` | GLM-5.2 Fast | Go | 1M | no | no | $3/$10.25 |
| `zai-org/GLM-5.3` | GLM-5.3 | Go | 1M | low, high, max | no | $1.4/$4.4 |
| `google/gemini-3.7-flash` | Gemini 3.7 Flash | GOAT | 1.05M | low, medium, high | yes | $1.5/$7.5 |
| `google/gemini-3.8-flash` | Gemini 3.8 Flash | GOAT | 1M | low, medium, high | yes | $1.5/$7.5 |
| `gpt-5.6-sol` | GPT-5.6 Sol | GOAT | 1.05M | low, medium, high, xhigh, max | yes | $5/$30 |
| `meta/muse-spark-1.2` | Muse Spark 1.2 | GOAT | 1.05M | low, medium, high, xhigh | yes | $1.25/$4.25 |
| `meta/muse-spark-1.3` | Muse Spark 1.3 | GOAT | 1.05M | low, medium, high, xhigh, max | yes | $1.25/$4.25 |
| `xai/grok-4.6` | Grok 4.6 | GOAT | 500K | low, medium, high, xhigh | yes | $2/$6 |
| `xai/grok-4.7` | Grok 4.7 | GOAT | 500K | low, medium, high, xhigh | yes | $1.2/$3.6 |
| `xiaomi/mimo-v2.6-pro-ultraspeed` | MiMo V2.6 Pro UltraSpeed | GOAT | 1.05M | no | yes | $4.35/$8.7 |
| `claude-haiku-4-5-20251001` | Claude Haiku 4.5 | Pro | 200K | no | yes | $1/$5 |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | Pro | 1M | low, medium, high, xhigh, max | yes | $3/$15 |
| `claude-sonnet-5` | Claude Sonnet 5 | Pro | 1M | low, medium, high, xhigh, max | yes | $2/$10 |
| `google/gemini-3.1-flash-lite` | Gemini 3.1 Flash Lite | Pro | 1M | low, medium, high | yes | $0.25/$1.5 |
| `google/gemini-3.5-flash` | Gemini 3.5 Flash | Pro | 1M | low, medium, high | yes | $1.5/$9 |
| `google/gemini-3.5-flash-lite` | Gemini 3.5 Flash Lite | Pro | 1M | low, medium, high | yes | $0.3/$2.5 |
| `google/gemini-3.6-flash` | Gemini 3.6 Flash | Pro | 1M | low, medium, high | yes | $1.5/$7.5 |
| `gpt-5.3-codex` | GPT-5.3 Codex | Pro | 400K | low, medium, high, xhigh | yes | $2/$8 |
| `gpt-5.4` | GPT-5.4 | Pro | 400K | low, medium, high, xhigh | yes | $2.5/$15 |
| `gpt-5.4-mini` | GPT-5.4 Mini | Pro | 400K | low, medium, high | yes | $0.75/$4.5 |
| `gpt-5.5` | GPT-5.5 | Pro | 400K | low, medium, high, xhigh | yes | $5/$30 |
| `gpt-5.6-terra` | GPT-5.6 Terra | Pro | 1.05M | low, medium, high, xhigh, max | yes | $2/$12 |
| `gpt-6-sol` | GPT-6 Sol | Pro | 1.05M | low, medium, high, xhigh, max | yes | $2/$10 |
| `meta/muse-spark-1.1` | Muse Spark 1.1 | Pro | 1.05M | low, medium, high, xhigh | yes | $1.25/$4.25 |
| `claude-fable-5` | Claude Fable 5 | Max | 1M | low, medium, high, xhigh, max | yes | $10/$50 |
| `claude-fable-5-1` | Claude Fable 5.1 | Max | 1M | low, medium, high, xhigh, max | yes | $10/$50 |
| `claude-opus-4-7` | Claude Opus 4.7 | Max | 1M | low, medium, high, xhigh, max | yes | $5/$25 |
| `claude-opus-4-8` | Claude Opus 4.8 | Max | 1M | low, medium, high, xhigh, max | yes | $5/$25 |
| `claude-opus-5` | Claude Opus 5 | Max | 1M | low, medium, high, xhigh, max | yes | $5/$25 |
| `claude-opus-5-5` | Claude Opus 5.5 | Max | 1M | low, medium, high, xhigh, max | yes | $4/$20 |
| `gpt-6-astra` | GPT-6 Astra | Max | 1.05M | low, medium, high, xhigh, max | yes | $10/$50 |
| `sakana/fugu-ultra` | Fugu Ultra | Max | 1M | high, xhigh | yes | $5/$30 |
<!-- MODELS:END -->

Pricing shown is the advertised per-1M-token rate from Command Code's own model reference. The [Usage page](https://commandcode.ai/studio) remains authoritative for what a request actually costs.

## License

MIT
