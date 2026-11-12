# BridgeLit Connect

Answer the questions you ask on [BridgeLit](https://bridgelit.net) with **your own Claude, ChatGPT or Gemini
subscription, or your own API key**, on your own computer. No copying and pasting between tabs, and no
passwords or keys given to BridgeLit.

```
 BridgeLit (reader or author portal)            your computer
 ┌───────────────────────────────┐   HTTPS    ┌──────────────────────────────┐
 │ you type a question           │◄──────────►│ bridgelit-connect            │
 │ server picks book passages    │ (outbound  │  └─ claude -p  (Claude plan) │
 │ shows the checked answer      │   only)    │  └─ codex exec (ChatGPT plan)│
 └───────────────────────────────┘            │  └─ gemini     (Google plan) │
                                              │  └─ your API key (keychain)  │
                                              └──────────────────────────────┘
```

## Install

### The easy way: one line

On **Connect your AI** in the BridgeLit reader or author portal, pick Claude, ChatGPT or Gemini and copy the line
it shows into Terminal (macOS / Linux) or PowerShell (Windows). The line carries a one-time code (good for
30 minutes) and runs a short script you can read first at
[bridgelit.net/api/bridge/connect.sh](https://bridgelit.net/api/bridge/connect.sh) /
[connect.ps1](https://bridgelit.net/api/bridge/connect.ps1). It:

1. uses your Node.js 20+, or downloads the official one from nodejs.org into `~/.bridgelit/node` and
   checks its SHA-256;
2. installs this package into `~/.bridgelit` (no admin password, no `sudo`);
3. connects the computer with the code (`bridgelit-connect login --token …`);
4. installs Claude Code, Codex or Gemini CLI if missing and opens its sign-in;
5. starts Connect now and at every login (`service install`).

Remove everything again with
`curl -fsSL https://bridgelit.net/api/bridge/connect.sh | sh -s -- --remove`, or on Windows
`$env:BRIDGELIT_REMOVE='1'; irm https://bridgelit.net/api/bridge/connect.ps1 | iex`.

### By hand

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
| Gemini plan (Google AI Pro / Ultra, Code Assist), no key | `bridgelit-connect setup gemini` | Installs Google's Gemini CLI and runs it once: choose "Sign in with Google", then `/quit` |
| OpenAI API key | `bridgelit-connect key add openai` | Checks the key, then stores it in your keychain |
| Gemini API key (Google AI Studio) | `bridgelit-connect key add gemini` | Checks the key, then stores it in your keychain |

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

On Windows, `service install` adds a "BridgeLit Connect" entry to your own Run key (no administrator) that
starts it hidden at sign-in and restarts it if it stops.

### Commands

| Command | What it does |
|---------|--------------|
| `login [--server URL] [--name NAME]` | Connects this computer (device-code login). |
| `login --token CODE` | Connects with the one-time code from a portal's install line. |
| `start [--approve] [--parallel N] [--claude-model M] [--codex-model M]` | Stays connected and answers questions: up to 3 at once with the Claude / Codex apps and, separately, up to 8 with your own API keys (BridgeLit's limits; `--parallel 1` answers one by one). When an API key hits its rate limit, Connect waits as the provider asks (up to a minute, twice) and otherwise hands the question back to BridgeLit to send again later, so nothing fails for it; a key with no credit left says so. `--approve` asks y/N in the terminal first and answers one at a time. Book translation uses the model BridgeLit's own Codex / Claude uses, unless you set one; a model your plan doesn't offer falls back to the CLI's default. |
| `status` | Shows the server, this computer, and the AIs it offers. |
| `doctor` | Checks Node, Claude Code and Codex are installed and signed in. |
| `logout` | Disconnects this computer and deletes its token. |
| `setup claude\|chatgpt\|gemini` | Installs Claude Code, Codex or Gemini CLI and opens its sign-in. |
| `key add\|remove anthropic\|openai\|gemini`, `key list` | Manages your own API keys (OS keychain, never uploaded). |

API-key answers use `claude-opus-5-5`, `gpt-5.5` and `gemini-3.1-pro-preview` by default. Change them with
`start --anthropic-model …`, `--openai-model …` or `--gemini-api-model …` (Gemini CLI: `--gemini-model …`).
A model you pick in BridgeLit always wins over these. Claude API requests opt into Anthropic's server-side
refusal fallback (`fallbacks: "default"`).

Environment: `BRIDGELIT_ANTHROPIC_BASE_URL` / `BRIDGELIT_OPENAI_BASE_URL` / `BRIDGELIT_GEMINI_BASE_URL` (proxies only), `BRIDGELIT_SERVER` (default `https://bridgelit.net`), `BRIDGELIT_CLAUDE_PATH`,
`BRIDGELIT_CODEX_PATH`, `BRIDGELIT_GEMINI_PATH`, `BRIDGELIT_CONNECT_HOME` (config folder),
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

- Your Claude, ChatGPT and Google logins, and any API keys you add, never leave your computer. API keys are
  sent only to `api.anthropic.com`, `api.openai.com` and `generativelanguage.googleapis.com`, even if
  `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` or `GOOGLE_GEMINI_BASE_URL` is set for another tool. API-key variables in your shell are hidden from the CLIs so your subscription is used
  (pass `--use-api-keys` to change this).
- API-key answers are plain requests with no tools defined.
- Every run happens in a fresh, empty temporary folder.
  - **Claude:** `--tools ""` turns off every tool. `--strict-mcp-config` with an empty config loads no
    MCP servers. `--no-session-persistence` saves nothing.
  - **Codex:** `--sandbox read-only`.
  - **Gemini CLI:** a policy file (`--policy`) denies every tool and MCP tool; the run folder's
    `.gemini/settings.json` registers no tools (`tools.core: []`), excludes every built-in one and loads
    no context files; `--allowed-mcp-server-names` allows no MCP server; BridgeLit's system prompt
    replaces the CLI's agent prompt (`GEMINI_SYSTEM_MD`). Gemini CLI can't read page pictures this way,
    so OCR polish with pictures needs the Gemini API key.
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

You use your own Claude, ChatGPT or Gemini plan under your own agreement with Anthropic, OpenAI or Google. BridgeLit
Connect runs only questions you type yourself in BridgeLit, one at a time, on your own computer.
