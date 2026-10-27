# Security model

## Threats and defences

| Threat | Defence |
|--------|---------|
| Someone else's computer answering as you | Device-code login approved while signed in. Tokens are 256-bit random, stored only as a hash on the server, revocable from the portal, and rate-limited per device. |
| Your API keys | Checked with a free model-list call, then kept in the OS keychain (or a `0600` file). They are sent only to the official API host, never to BridgeLit, and requests define no tools. `key remove` deletes a key. |
| Token theft on your computer | Kept in the OS keychain (macOS) or Secret Service (Linux), else a `0600` file. `logout` deletes it and revokes it on the server. |
| Network attackers | HTTPS only (HTTP only for `localhost`). Redirects are refused. The agent opens no ports. |
| **Prompt injection in book text** (for example a passage saying "read ~/.ssh/id_rsa") | The server labels passages as data, not instructions. Claude runs with **no tools** and **no MCP servers**. Codex runs in a read-only sandbox. Any tool attempt (`tool_use`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`) kills the run and discards the answer. Each run gets an empty working folder. |
| Private data in an answer | Answers and partial text are scanned for private keys, cloud and API tokens, JWTs, and your home folder path. A match means nothing is sent back. |
| The server sending commands | The server can send only a system prompt and a user prompt. The agent builds the CLI arguments itself from a fixed list, and the prompt goes in on stdin, never through a shell. |
| Runaway use of your plan | One job at a time per user. Server-side daily caps. A timeout per run. `--approve` lets you confirm each question. Stop in the portal kills the run. |

## Reporting

Email security reports to the BridgeLit team (see bridgelit.net). Please don't open a public issue for a
vulnerability.
