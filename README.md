# BridgeLit Connect

Answer the questions you ask on [BridgeLit](https://bridgelit.net) with **your own Claude or ChatGPT
subscription, or your own API key**, on your own computer. No copying and pasting between tabs, and no
passwords or keys given to BridgeLit.

```
 BridgeLit (reader or author portal)            your computer
 ┌───────────────────────────────┐   HTTPS    ┌──────────────────────────────┐
 │ you type a question           │◄──────────►│ bridgelit-connect            │
 │ server picks book passages    │ (outbound  │  └─ claude -p  (Claude plan) │
 │ shows the checked answer      │   only)    │  └─ codex exec (ChatGPT plan)│
 └───────────────────────────────┘            │  └─ your API key (keychain)  │
                                              └──────────────────────────────┘
```

## Install

You need Node.js 20+.

```bash
npm install -g github:nadeem-gh/bridgelit-connect
```

Then pick one or more ways to pay for answers:

| Option | Command | What it does |
|--------|---------|--------------|
| Claude plan (Pro / Max), no key | `bridgelit-connect setup claude` | Installs Claude Code and runs `claude auth login` |
| ChatGPT plan (Plus / Pro / Team), no key | `bridgelit-connect setup chatgpt` | Installs OpenAI's Codex CLI and runs `codex login` (choose "Sign in with ChatGPT") |
| Anthropic API key | `bridgelit-connect key add anthropic` | Checks the key, then stores it in your keychain |
| OpenAI API key | `bridgelit-connect key add openai` | Checks the key, then stores it in your keychain |

`bridgelit-connect doctor` shows what is ready.

> **ChatGPT without an API key:** the ChatGPT desktop and web apps have no interface that other programs
> can call. OpenAI's Codex CLI, signed in with your ChatGPT account, is the supported way to use a ChatGPT
> plan from a program. It runs on your computer and counts against your ChatGPT plan, not an API bill.

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
| `start [--approve] [--parallel N] [--claude-model M] [--codex-model M]` | Stays connected and answers questions, up to 3 at once (BridgeLit's limit; `--parallel 1` answers one by one). `--approve` asks y/N in the terminal first and answers one at a time. Book translation uses the model BridgeLit's own Codex / Claude uses, unless you set one; a model your plan doesn't offer falls back to the CLI's default. |
| `status` | Shows the server, this computer, and the AIs it offers. |
| `doctor` | Checks Node, Claude Code and Codex are installed and signed in. |
| `logout` | Disconnects this computer and deletes its token. |
| `setup claude\|chatgpt` | Installs Claude Code or Codex and opens its sign-in. |
| `key add\|remove anthropic\|openai`, `key list` | Manages your own API keys (OS keychain, never uploaded). |

API-key answers use `claude-opus-5-5` and `gpt-5.5` by default. Change them with
`start --anthropic-model …` or `--openai-model …`. Claude API requests opt into Anthropic's server-side
refusal fallback (`fallbacks: "default"`).

Environment: `BRIDGELIT_ANTHROPIC_BASE_URL` / `BRIDGELIT_OPENAI_BASE_URL` (proxies only), `BRIDGELIT_SERVER` (default `https://bridgelit.net`), `BRIDGELIT_CLAUDE_PATH`,
`BRIDGELIT_CODEX_PATH`, `BRIDGELIT_CONNECT_HOME` (config folder),
`BRIDGELIT_CREDENTIAL_STORE=file` (skip the OS keychain on headless machines).

## Pictures

ChatGPT (Codex) and an OpenAI API key can also make pictures: a reader's
picture from a prompt, or an author's picture for a paragraph of their draft.
They can also enhance a picture already on a draft. Claude can't make pictures.

- **Codex** uses its built-in image tool with your ChatGPT plan. It is on by
  default; if it is off, run `codex features enable image_generation`. Codex
  saves each picture under `~/.codex/generated_images/`, and the agent sends
  that picture back.
- **OpenAI API key** uses the images API (`gpt-image-1` unless you pass
  `--openai-image-model`). This is billed to your OpenAI account.

The agent tells BridgeLit which AIs can make pictures. Versions before 0.2.0
can't, so reinstall with `npm install -g github:nadeem-gh/bridgelit-connect`.

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

- Your Claude and ChatGPT logins, and any API keys you add, never leave your computer. API keys are sent
  only to `api.anthropic.com` and `api.openai.com`, even if `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL` is set
  for another tool. API-key variables in your shell are hidden from the CLIs so your subscription is used
  (pass `--use-api-keys` to change this).
- API-key answers are plain requests with no tools defined.
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
