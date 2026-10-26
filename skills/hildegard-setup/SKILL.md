---
name: hildegard-setup
description: Install and set up Hildegard for its owner end to end - the app, a model, linking AI apps over MCP, these skills, coding-agent access under each provider's terms, hosting at a link, and a fleet of devices. Use when asked to install, set up, connect, update or troubleshoot Hildegard.
---

# Setting up Hildegard for your user

The full guide is `docs/agents.md` in the Hildegard repository
(https://github.com/baney75/hildegard/blob/main/docs/agents.md). This is the short path. Every `hildegard` command
takes `--json` and prints `{ ok, needsOwner, steps[], message }`; a step that's `needs-owner` is your user's to do.
Rerunning any command is safe.

## The app and a model

```sh
# macOS and Linux
curl -fsSL https://github.com/baney75/hildegard/releases/latest/download/install.sh | sh -s -- --json
# Windows (PowerShell)
$env:HILDEGARD_INSTALL_ARGS = '--json'; irm https://github.com/baney75/hildegard/releases/latest/download/install.ps1 | iex

hildegard setup --yes --json
```

`setup` picks a model that fits the GPU and returns its license in the `model` step's `detail`. Show it to your user
word for word. Only on a clear yes, run that step's `command` (it carries `--accept-license <model>`). Then
`hildegard status --json` should show `running: true` and the model installed.

## Your AI apps and these skills

```sh
hildegard connect --all --json      # tools + skills in Claude Code, Codex, OMP, Pi, Gemini CLI, OpenCode, Cursor, …
hildegard skills install --json     # only these skills, for apps linked another way
```

Each linked app gets a `sign-in-<app>` step: pass its `detail` to your user as written, since it says how that app
may be signed in without breaking its provider's terms. Start a new session of the agent afterwards. `hildegard skills install --project <dir>` puts them in one project
instead. In Claude Code the plugin does both: `/plugin marketplace add baney75/hildegard`, then
`/plugin install hildegard@hildegard`.

Chatbots that run on their makers' servers (claude.ai, ChatGPT, Grok, Grok Bot) need the public link, which only your
user may ask for: `hildegard host --funnel --json`, then the app's custom connector with `mcpUrl`, and your user signs
in on Hildegard's page. Each app's steps: `docs/chatbots.md`. They read these skills over MCP with `read_skill`.

## Letting Hildegard run coding agents

`hildegard agents --json` shows each coding agent on this computer, how it's signed in, and what Hildegard may do
with it. The rules come from the providers' own terms and Hildegard enforces them; don't try to work around them, as
that can get your user's account banned:

- A **Claude or ChatGPT plan** runs only in its own app (Claude Code, Codex), only when your user starts the run
  themselves, paced like a person working, and never for other people or on a schedule.
- Your user's own **API key** can run anything for them, including scheduled runs:
  `printf %s "$KEY" | hildegard agents key anthropic --key-stdin --json` (or `openai`, `openrouter`, …). Keys go to
  the system keychain. Never put a key on a command line or in a file.
- **OMP** runs only with an API key or a local model (`--use local --model ollama/<model>`), never with a Claude or
  ChatGPT login. The same holds for **Pi** and **OpenCode** when your user links them.
- Never read, copy or move any agent's sign-in files, and never sign in for your user.

`hildegard agents run claude-code "<task>"` runs one; add `--use key` to bill their key, `--unattended` for a run
nobody is watching (needs a key).

## A link and a fleet

- **Host at a link** (their phone, people they invite): `docs/agents.md`, section B. Tailscale sign-in and the owner
  passphrase are your user's to do.
- **A fleet** (a laptop rendering on the desktop's GPU): `docs/agents.md`, section C.
- **Rented GPUs** (Runpod, Hugging Face, Colab): the **hildegard-cloud** skill.

## When something's wrong

`hildegard doctor --json` checks every part and gives each problem the command that fixes it. Logs are in the data
folder's `logs/`.
