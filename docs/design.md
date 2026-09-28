# Design notes

Why this provider is built the way it is. For installation and usage, see the [README](../README.md).

## Why this exists

The [`command-code`](https://www.npmjs.com/package/command-code) CLI talks to a private `/alpha/generate` endpoint with a private request envelope, and third-party clients can only reach it by impersonating the CLI (spoofing `x-command-code-version`, sending placeholder `memory`/`taste`/`skills` fields). That is not a supported integration: it breaks whenever the CLI changes, and it cannot be validated.

Command Code's Provider API is documented, versioned, and open to plan holders. This provider uses only that:

| Protocol | Endpoint | Adapter | Models |
|---|---|---|---|
| OpenAI | `/provider/v1/chat/completions` | `@ai-sdk/openai-compatible` | 73 |
| Anthropic | `/provider/v1/messages` | `@ai-sdk/anthropic` | 9 |

Every model that speaks OpenAI exposes `/chat/completions`, so `/responses` never needs to be wired up.

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
