# vibe-shim

A local, neutral, OpenAI-compatible proxy that exposes a **Mistral Vibe
plan** — the real `vibe` engine, driving every turn — to any client that
speaks OpenAI-style HTTP: OpenCode, Zed, Continue, your own script, whatever
reads a `baseURL`.

No API key, no reimplemented client. The shim shells out to `vibe
run-server` (Vibe's own experimental multi-run server) and serves an agent
socket for it, so the engine runs each turn itself — same system prompt,
same harness guidance, same auth, same backend (`chat.mistral.ai`) your
interactive `vibe` session uses.

## Why this exists

Mistral is splitting billing starting **December 1, 2026**: usage through
third-party tools (a raw API key in your own harness) will draw from the
free **API allowance** ($25-ish on most paid plans) instead of the
dedicated **Vibe allowance** (far larger, e.g. $300 on some plans). The
split isn't by user-agent or protocol — it's by which backend you hit.
`api.mistral.ai` with a key is one bucket; `chat.mistral.ai` through the
Vibe engine's own auth is the other.

This shim keeps the engine in the loop for every single turn, so the
traffic looks like what it is: the Vibe product, driven by its own CLI,
talking to its own backend. It is not a reverse-engineered client — it's a
thin process wrapper around Vibe's own documented (if experimental)
programmatic-mode APIs.

**Verify it yourself**, don't take anyone's word for it: Vibe's billing API
(`GET /v1/billing/budget`) reports `vibe_budget` and `api_budget`
separately. Run some traffic through the shim, then check which one moved.

## What it is NOT (yet)

Be clear-eyed about this before you build on it:

- **Linux and macOS only.** Vibe's own docs say so explicitly: both
  `run-server` and `--agent-socket` are "not supported on Windows (exit
  1)". This isn't a shim limitation, it's upstream. A Windows build would
  need a different mode (spawn `vibe -p` per request, no socket) that
  isn't written yet.
- **Experimental upstream surface.** `run-server` and `--agent-socket` are
  hidden from `vibe --help` and Mistral says the protocol "may change or
  go away without notice." Expect breakage on `vibe` upgrades; pin a
  version if that matters to you.
- **Streaming is fake.** The HTTP response streams as SSE, but it's the
  full reply (or the tool-call batch) emitted once the segment finishes —
  `vibe`'s own run only reports a result once it finishes, there's no
  token-level stream from the engine today.
- **No session resume across turns.** Within a single tool-calling turn,
  the live Vibe run stays parked while your client executes tools and
  resumes when tool results arrive; across separate user turns, each new
  request still flattens the message history into one prompt (including
  `<tool_call>` and `<tool_result>` blocks).
- **`tool_choice` is advisory only (except `"none"`).** `"none"` disables
  declaring client tools; `"required"` and `{type: "function", function:
  {name}}` (and legacy `function_call`) are accepted without error, but
  the Vibe engine does not enforce forcing a specific tool.
- **Usage is reported on the final response.** Intermediate
  `finish_reason: "tool_calls"` responses report zero usage because Vibe
  writes usage only in `export.json` when the run finishes; the final
  `finish_reason: "stop"` response reports the cumulative usage for the
  whole multi-segment run (and emits a final usage SSE chunk when
  `stream_options.include_usage` is set).
- **No image input.** Image parts are replaced with `[image attached]`
  placeholders; `cli.ts models` advertises `images: false`.

If any of this doesn't fit your use case, wait or send a PR.

## How it works

```
your client (OpenCode, Zed, curl...)
  │  POST /v1/chat/completions  (OpenAI Chat Completions shape, optional tools)
  ▼
vibe-shim (:8126, node:http)
  │  creates a per-run Unix agent socket (/tmp/vibe-shim-<uid>/<hex>.sock)
  │  declares the client's OpenAI tools in agent/initialize (namespace: client)
  ▼
vibe run-server (long-lived child process, JSON-RPC over stdio)
  │  run/start → spawns an app-server, assigns the run its agent socket
  ▼
vibe-shim's per-run agent socket (Unix socket, sandbox + client tools)
  │  sandbox/execute, sandbox/readFile: host passthrough for Vibe's own setup
  │  tools/call: parked in-memory while vibe waits for the reply; shim batches
  │    parallel calls (~200ms) and responds to the HTTP client with
  │    finish_reason: "tool_calls" (JSON or SSE deltas)
  ▼
client executes the tools and sends a follow-up request with role: "tool"
  │  shim matches trailing tool_call_ids to the parked run, answers the
  │  pending tools/call RPCs, and continues waiting for the next tool batch
  │  or run/ended (unmatched/expired IDs fall back to a fresh flattened run)
  ▼
run/ended notification → shim closes the socket and reads export.json +
session/generations/*/checkpoint.json for the final reply
  ▼
OpenAI-shaped JSON (or minimal SSE) back to your client
```

Parked runs live up to 30 minutes (TTL) and are aborted if the HTTP client
disconnects mid-segment. Concurrent duplicate requests for an already
in-flight tool batch receive `409 Conflict` instead of racing on the same
run. Passing `tool_choice: "none"` (or legacy `function_call: "none"`) or
omitting `tools`/`functions` runs without declaring any client tools.

### Engine tools & client tool translation

- **Engine built-in tools are disabled** (`enabledTools: ["__vibe_shim_none__"]`)
  so the model calls your client's tools instead of Vibe's host tools.
- **Reserved names and sanitization:** client tools whose names collide with
  Vibe built-ins (`bash`, `edit`, `read`, `grep`, etc. — plus any name the
  engine rejects at runtime) are declared under a `client_` prefix and mapped
  back to the original tool name in `tool_calls`. Non-identifier characters,
  leading digits, unicode, and names over 64 characters are sanitized with
  stable uniqueness and mapped back transparently.
- **Schema normalization:** Vibe requires every tool's top-level `inputSchema`
  to be `"type": "object"`. Missing/empty schemas, `type: ["object", "null"]`,
  top-level `$ref`, `anyOf`/`oneOf`, or primitive top-level schemas are
  normalized (or wrapped under `{type: "object", properties: {value: ...}}`)
  so the engine does not reject the run.
- **Legacy fields:** OpenAI `tools` entries without `type` and legacy
  `functions`/`function_call` fields are accepted.
- **Child process recovery:** if `vibe run-server` crashes, in-flight HTTP
  requests fail cleanly with `502` and the next request lazily restarts and
  re-initializes `vibe run-server`.

## Prerequisites

- Node.js >= 22
- Mistral Vibe CLI installed and logged in:
  - macOS/Linux: `brew install mistral-vibe` (or the official installer:
    `curl -LsSf https://mistral.ai/vibe/install.sh | bash`)
  - then `vibe` once, interactively, to log in
  - confirm with: `vibe -p "hi" --output text`

## Setup

```sh
npm install
npm run build
npm run serve            # listens on :8126 by default
```

Options: `--port <N>` (default 8126), `--workspace <DIR>` (default: cwd —
this becomes the engine's project root for every run, so AGENTS.md,
project context, etc. come from there).

```sh
node dist/cli.js models --port 8126   # prints your account's real model
                                       # catalog as a Zed settings.json snippet
```

### See your real models

The shim has no static model list. There's no `vibe models` command
upstream, so it discovers your account's actual aliases by asking `vibe`
for an invalid one and parsing the "Unknown model: X. Available: a, b, c"
error it returns. `GET /v1/models` serves whatever that discovery found —
re-run after your account's catalog changes (new model released, plan
change), or just restart the shim.

### OpenCode

In `opencode.jsonc` / `opencode.json`:

```jsonc
{
  "providers": {
    "vibe": {
      "name": "Mistral Vibe",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "http://127.0.0.1:8126/v1",
        "apiKey": "dummy"
      },
      "models": {
        // run `node dist/cli.js models` and copy your real aliases here;
        // these are an example, yours will likely differ
        "mistral-large-4-0-3": {
          "modelID": "mistral-large-4-0-3",
          "name": "Mistral Large 4.0.3",
          "limit": { "context": 1048576, "output": 128000 },
          "capabilities": { "tools": true, "input": ["text"] }
        }
      }
    }
  }
}
```

### Zed

In `settings.json`, under `language_models.openai_compatible`:

```json
{
  "vibe": {
    "api_url": "http://127.0.0.1:8126/v1",
    "api_key": "dummy",
    "available_models": [
      {
        "name": "mistral-large-4-0-3",
        "display_name": "Mistral Large 4.0.3",
        "max_tokens": 128000,
        "capabilities": { "tools": true, "chat_completions": true }
      }
    ]
  }
}
```

(`node dist/cli.js models` prints this whole block, pre-filled with your
real catalog — paste it directly.)

## Endpoints

| Route | Behavior |
| --- | --- |
| `GET /health` | `{status, provider, engine}` |
| `GET /v1/models` | Your account's real model aliases, discovered at startup |
| `POST /v1/chat/completions` | OpenAI Chat Completions shape with client tool bridge (parked runs); `stream: true` emits SSE chunks for text or `tool_calls` deltas |

`model` in the request is forwarded as `config.active_model` for the run,
if it matches a discovered alias; otherwise the shim logs it and falls back
to the account's first/default alias.

## Debugging

Run exports and session journals are written under
`$XDG_STATE_HOME/zed-shims/vibe-shim/runs/<run-id>/` (or
`~/.local/state/...` by default) and deleted automatically once each run
finishes or aborts (stale directories older than 24 hours are swept at
startup). Set `VIBE_SHIM_KEEP_RUNS=1` to keep `export.json` and
`session/generations/*/checkpoint.json` on disk for inspection. Shim
logs (including every `sandbox/execute` the engine ran) are at
`.../vibe-shim/shim.log`.

## Roadmap

1. Real token streaming (today: one chunk per segment).
2. Session resume across separate user turns instead of flattening history each time.
3. A Windows-compatible mode: plain `vibe -p` per request, no socket, no
   run-server (loses the "hibernating" long-lived process, keeps the
   billing property).

## License

MIT
