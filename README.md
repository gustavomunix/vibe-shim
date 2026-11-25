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

- **No tool-calling bridge.** If your client sends `tools` in the request,
  the shim logs a warning and runs the turn without them. You get a chat
  partner through this endpoint, not an acting agent — it cannot edit
  files or run commands *via your harness's tool system* yet. (Vibe's own
  tools still run for its own purposes, like reading project context —
  your harness just can't hand it its own tools yet.)
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
  full reply in one chunk at the end of the run — `vibe`'s own run only
  reports a result once it finishes, there's no token-level stream from
  the engine today.
- **No conversation state.** Each request flattens the whole message
  history into one prompt; there's no session resume across requests yet.

If any of this doesn't fit your use case, wait or send a PR.

## How it works

```
your client (OpenCode, Zed, curl...)
  │  POST /v1/chat/completions  (OpenAI Chat Completions shape)
  ▼
vibe-shim (:8126, node:http)
  │  flattens the message history into one prompt
  ▼
vibe run-server (long-lived child process, JSON-RPC over stdio)
  │  run/start → spawns an app-server, assigns the run an agent socket
  ▼
vibe-shim's agent socket (Unix socket, sandbox passthrough)
  │  sandbox/execute, sandbox/readFile: the engine's own tool calls,
  │  run on your host exactly like plain `vibe -p` would
  ▼
vibe engine executes the turn — its own system prompt, project context,
AGENTS.md, skills — and talks to chat.mistral.ai with your plan's auth
  │
  ▼
run/ended notification → shim reads export.json + the session's
generations/*/checkpoint.json for the reply
  ▼
OpenAI-shaped JSON (or minimal SSE) back to your client
```

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
          "capabilities": { "tools": false, "input": ["text"] }
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
        "capabilities": { "tools": false, "chat_completions": true }
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
| `POST /v1/chat/completions` | OpenAI Chat Completions shape; `stream: true` gets a 3-event SSE (role, full content, stop) |

`model` in the request is forwarded as `config.active_model` for the run,
if it matches a discovered alias; otherwise the shim logs it and falls back
to the account's first/default alias.

## Debugging

Every run leaves its export and session journal under
`$XDG_STATE_HOME/zed-shims/vibe-shim/runs/<run-id>/` (or
`~/.local/state/...` by default): `export.json` for outcome/usage/cost, and
`session/generations/*/checkpoint.json` for the actual turn output. Shim
logs (including every `sandbox/execute` the engine ran) are at
`.../vibe-shim/shim.log`.

## Roadmap

1. Tool-calling bridge: declare the client's tools in the agent socket
   handshake, route `tools/call` back to the client, handle the
   parked-turn/resume dance for results that arrive on the next request.
2. Real token streaming (today: one chunk at the end).
3. Session resume across requests instead of flattening history each time.
4. A Windows-compatible mode: plain `vibe -p` per request, no socket, no
   run-server (loses the "hibernating" long-lived process, keeps the
   billing property).

## License

MIT
