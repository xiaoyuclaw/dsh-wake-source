# dsh-wake-source

Let **external scripts wake a running DSH agent** — no `DEEPSEEK_API_KEY`, no new process.

## Why

In DSH, "being woken" means *something delivers a user message into a session*. That is exactly what
IM channel plugins do (`agent.followup(createUserMessage(...))`), and they can do it because they run
**inside** the `dsh web` process and reuse its login state.

`dsh headless`, by contrast, is a separate process and must carry its own API key. So a shell script
that notices "price broke the stop level" had only one option: start a headless agent with a key.

This plugin exposes the delivery primitive over localhost HTTP. A script `curl`s it, the session
starts a turn, the agent decides what to do.

```
script  →  POST 127.0.0.1:8737/wake  →  dsh web process  →  agent.followup(msg)  →  turn
```

## Install

It is a Cordis bundle for a DSH profile. From your DSH checkout / profile:

1. Copy or clone this directory somewhere on the machine.
2. Install it into your profile (the plugin manager performs `package.json` and patch edits):

```
dsh plugin --profile <profile> add link:/abs/path/to/dsh-wake-source
```

   or, from an agent session, call the plugin manager with `install_bundle` and the absolute
   package directory as `target`.

3. Adjust `cordis.patch.yml` if needed (see Configuration), then reload the entry.

## Configuration

All optional, via the bundle patch (`cordis.patch.yml`):

| Key | Default | Meaning |
|---|---|---|
| `host` / `port` | `127.0.0.1` / `8737` | Listen address |
| `token` | empty | Must match header `x-wake-token`; empty disables the check (localhost only anyway) |
| **`identityRoot`** | follows `dsh`'s start directory | **cwd for newly created sessions** (your agent workspace). Old key `cwd` still works |
| `agentPreset` | default preset | Preset composition to mount for created sessions |
| `provider` / `model` / `reasoningEffort` | none | Created sessions have no model to inherit — set these to your profile's defaults |

Per request you may override: `{"cwd": "...", "preset": "...", "provider": "...", "model": "..."}`.

## API

```
GET  /status
  → {"ok": true, "live": ["session-…", …], "identityRoot": "/path/to/workspace"}

POST /wake
  headers: x-wake-token: <token>
  body:    {"session": "session-…", "text": "what to do"}
  → 200 {"ok": true, "session": "session-…"}
  → 200 {"ok": true, "session": "session-…", "created": true}   # target was not live, created one
  → 409 {"ok": false, "code": "session-not-live", "live": [...]}
  → 401 {"ok": false, "code": "bad-token"}
```

```bash
curl -s http://127.0.0.1:8737/status
curl -s -X POST http://127.0.0.1:8737/wake \
  -H 'content-type: application/json' \
  -H 'x-wake-token: change-me' \
  -d '{"session":"session-abc","text":"stop level is 1.8% away — check and act"}'
```

## Behavior

- **Live session** → `agent.followup(...)`, the turn starts immediately.
- **Session not live** (or unknown id) → creates a new session with `identityRoot` / `agentPreset` /
  `provider`+`model`, injects the message, and disposes the agent once the turn goes idle.
  Pass `{"create": false}` to disable this and get a 409 instead.
- The HTTP call returns as soon as the message is queued; it does not wait for the turn to finish.

## Security notes

- Binds `127.0.0.1` only. Do not expose it on a network interface.
- Set a `token` and keep it out of any file you publish.
- Anything that can reach this port can make the agent run — treat it as a local privilege boundary.
- Created sessions are real sessions: they are persisted on disk (the agent itself is disposed).

## Limitations

- Requires a running `dsh web` (or any long-lived profile process) — that process is the one that
  delivers the message. With nothing running, there is nothing to wake.
- Newly created sessions start with no conversation history; give them a self-contained instruction.

## License

MIT
