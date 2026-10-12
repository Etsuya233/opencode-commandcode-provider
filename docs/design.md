# Design notes

Why this provider is built the way it is. For installation and usage, see the [README](../README.md).

## Why this exists

The [`command-code`](https://www.npmjs.com/package/command-code) CLI talks to a private `/alpha/generate` endpoint with a private request envelope, and third-party clients can only reach it by impersonating the CLI (spoofing `x-command-code-version`, sending placeholder `memory`/`taste`/`skills` fields). That is not a supported integration: it breaks whenever the CLI changes, and it cannot be validated.

Command Code's Provider API is documented, versioned, and open to plan holders. This provider uses only that:

| Protocol | Endpoint | Adapter | Models |
|---|---|---|---|
| OpenAI chat | `/provider/v1/chat/completions` | `@opencode/ai/providers/openai-compatible` | 76 |
| OpenAI Responses | `/provider/v1/responses` | `@opencode/ai/providers/openai-compatible/responses` | 68 |
| Anthropic | `/provider/v1/messages` | `@opencode/ai/providers/anthropic` | 11 |

(Counts are the live catalog: 87 models, 68 of which serve both OpenAI transports.)

Most OpenAI-protocol models serve **both** `/chat/completions` and `/responses`; a handful serve only the former. The live catalog's `supported_endpoints` is the authority for which, so the provider never guesses. A model that advertises both is registered **twice** — once per transport — because they are genuinely different adapters with different wire formats:

- the two registrations share the upstream id (`modelID`) but carry different picker keys (`foo` and `foo-responses`), which opencode permits because only the picker key must be unique within a provider;
- the Responses registration's display name gets an `(R)` suffix, so the picker tells you which transport you are about to use;
- reasoning is expressed identically on both — `reasoningEffort`, which opencode maps to `reasoning_effort` on chat and to `reasoning: { effort }` on Responses — so variants (`#high`, `#max`, …) work on either.

The `(R)` form is the one to prefer when a model offers it: the Responses API carries server-side state and is the transport Command Code's own GPT-5.x models are tuned for.

The snapshot has no endpoint data (neither `models.md` nor the CLI bundle records it), so the fallback catalog registers no Responses entries and shows no `(R)`. This is deliberate: a missing cache is not evidence that a model lacks Responses, and inventing the flag would be a guess. Refresh the catalog (`/commandcode-refresh`) and the live `supported_endpoints` fill it in.

The adapters are opencode's **native** providers, which ship inside the CLI binary, not the `aisdk:@ai-sdk/...` route. That distinction matters for image input: the `aisdk:` route installs the AI SDK adapter at `@latest` at runtime, and AI SDK v4 changed a file part's `data` from `string | URL` to a tagged `{ type, data }` object. opencode 2.0.18 still emits the v3 shape, so the adapter's converter returns `undefined`, `JSON.stringify` writes `null` into the message content, and the request fails with HTTP 400 on every replay. The native route has no such indirection. See opencode issue #50960 and PR #51482.

**This provider does not support the Go plan.** Go accounts are not offered Provider API access, and this package deliberately does not fall back to the CLI transport.

## Reasoning

`reasoning` and the selectable effort levels come from different places, and both are needed:

- the **CLI bundle** knows which models are reasoning models;
- the **documented table** knows which effort levels you can pick.

Command Code's own documentation is explicit that a `—` in its effort column means *"the model decides its own reasoning depth"*, not "not a reasoning model" — 16 models are in that state today. Models with selectable levels are registered as opencode variants (`low`, `medium`, `high`, `xhigh`, `max`), selected as `provider/model#level` on the command line or from the variant picker.

Variant settings are merged into the outgoing request, and the two protocols spell "think harder" differently:

- **OpenAI-compatible** models get `reasoning_effort`.
- **Anthropic** models get adaptive thinking — `thinking: {type: "adaptive", display: "summarized"}` plus `output_config: {effort}`. Adaptive means the model picks its own token budget, so no per-level budget has to be invented. This is the same mechanism the Pi provider uses, and opencode's Anthropic adapter accepts it as `settings: {thinking, effort}` (a `reasoningConfig` object is silently dropped by its settings schema).

## Terminal notices

The refresh result is broadcast over the plugin's RPC event and shown as a toast by the bundled terminal companion (`tui.ts`, exported as `./tui`).

The notice is terminal-only on purpose. opencode's only session-native text channel is a synthetic message, which is a model-visible user turn that also starts a provider reply; the web UI renders sessions rather than plugin notifications, so it has no equivalent channel.
