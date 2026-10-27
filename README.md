# BridgeLit Connect

Answer the questions you ask on [BridgeLit](https://bridgelit.net) with **your own Claude or ChatGPT
subscription**, on your own computer. No copying and pasting between tabs, and no API keys or passwords
given to BridgeLit.

```
 BridgeLit (reader or author portal)            your computer
 ┌───────────────────────────────┐   HTTPS    ┌──────────────────────────────┐
 │ you type a question           │◄──────────►│ bridgelit-connect            │
 │ server picks book passages    │ (outbound  │  └─ claude -p  (Claude plan) │
 │ shows the checked answer      │   only)    │  └─ codex exec (ChatGPT plan)│
 └───────────────────────────────┘            └──────────────────────────────┘
```

## Install

You need Node.js 20+ and at least one of:

| AI | Install | Sign in with your plan |
|----|---------|------------------------|
| Claude (Pro / Max) | `npm install -g @anthropic-ai/claude-code` | `claude auth login` |
| ChatGPT (Plus / Pro / Team) | `npm install -g @openai/codex` | `codex login` |

```bash
npm install -g github:nadeem-gh/bridgelit-connect
bridgelit-connect doctor
```

## Connect and run

```bash
bridgelit-connect login     # shows a code: type it on "Connect your AI" in BridgeLit
bridgelit-connect start     # keep this running while you use BridgeLit
```

Start it automatically at login (macOS launchd / Linux systemd user unit):

```bash
bridgelit-connect service install
bridgelit-connect service uninstall
```

On Windows, create a Task Scheduler task "At log on" that runs `bridgelit-connect start`.

### Commands

| Command | What it does |
|---------|--------------|
| `login [--server URL] [--name NAME]` | Connects this computer (device-code login). |
| `start [--approve] [--claude-model M] [--codex-model M]` | Stays connected and answers questions. `--approve` asks y/N in the terminal first. |
| `status` | Shows the server, this computer, and the AIs it offers. |
| `doctor` | Checks Node, Claude Code and Codex are installed and signed in. |
| `logout` | Disconnects this computer and deletes its token. |

Environment: `BRIDGELIT_SERVER` (default `https://bridgelit.net`), `BRIDGELIT_CLAUDE_PATH`,
`BRIDGELIT_CODEX_PATH`, `BRIDGELIT_CONNECT_HOME` (config folder),
`BRIDGELIT_CREDENTIAL_STORE=file` (skip the OS keychain on headless machines).

## How it works

1. `login` asks the server for a one-time code, which you approve while signed in to BridgeLit. The
   server then issues a **device token**. The token is stored in the macOS Keychain or Linux Secret
   Service, or else in a `0600` file. The server keeps only its SHA-256.
2. `start` checks in over HTTPS every ~2 seconds (`POST /api/bridge/device/jobs/next/`). Nothing listens
   on a port, so it works behind any router or firewall.
3. When you ask a question in BridgeLit, the **server** chooses the passages from its own search index and
   builds the full prompt. The agent runs that prompt as-is through your local CLI, streams the text back,
   and then sends the final answer.
4. The server checks the answer (for readers: it must not copy the book's text), then shows it with page
   or paragraph links.

### Protocol (`/api/bridge/`)

| Call | Body → reply |
|------|--------------|
| `POST device/pair/` | `{name, providers, agent_version, platform}` → `{device_code, user_code, expires_in, interval}` |
| `POST device/pair/poll/` | `{device_code}` → `202 pending` · `200 {token, device}` (once) · `410 expired` |
| `POST device/hello/` | `{providers, agent_version, platform}` → `{device, next_poll_ms}` |
| `POST device/jobs/next/` | → `{job: {id, provider, system, prompt, max_answer_chars, timeout_seconds} \| null, next_poll_ms}` |
| `POST device/jobs/<id>/progress/` | `{partial}` → `{keep_going}` (false = the user pressed Stop) |
| `POST device/jobs/<id>/result/` | `{answer}` or `{error}` |
| `POST device/logout/` | revokes this device |

All device calls send `Authorization: Bridge <token>`. A `401` means the device was disconnected.

## Security

See [SECURITY.md](SECURITY.md). In short:

- Your Claude and ChatGPT logins never leave your computer. API-key variables are hidden from the CLIs so
  your subscription is used (pass `--use-api-keys` to change this).
- Every run happens in a fresh, empty temporary folder.
  - **Claude:** `--tools ""` turns off every tool. `--strict-mcp-config` with an empty config loads no
    MCP servers. `--no-session-persistence` saves nothing.
  - **Codex:** `--sandbox read-only`.
- If the model tries to use any tool anyway, for example because a book passage contains planted
  instructions, the run is killed and the answer is thrown away.
- An answer that looks like a key, token or private path from this computer is never sent back.

## Development

```bash
npm test          # node:test, no dependencies
npm run lint      # syntax check
node bin/bridgelit-connect.js --help
```

Point it at a local backend with `--server http://localhost:8000` (plain HTTP is allowed only for localhost).

## Terms

You use your own Claude or ChatGPT plan under your own agreement with Anthropic or OpenAI. BridgeLit
Connect runs only questions you type yourself in BridgeLit, one at a time, on your own computer.
