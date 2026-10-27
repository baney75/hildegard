# Running coding agents within their providers' terms

Hildegard can start Claude Code, Codex, OMP (oh-my-pi) and Pi for its owner, with Hildegard's MCP tools and skills, to
make and edit films, photos, art and sound. This page says which ways of running them are allowed, which aren't, and
why, from each provider's own published terms. `packages/agents/src/policy.ts` enforces exactly this table before
anything starts; `hildegard agents --json` shows the verdict for each agent on a computer.

Read on 2026-10-24, and checked again the same evening. Terms change: when a provider's page changes, update this page and `policy.ts` together, and where
a provider is silent the answer is no.

## The short version

| How the agent is signed in | Owner, asked just now | Owner, on a schedule or unattended | People the owner invited | Another device in the fleet |
| --- | --- | --- | --- | --- |
| The owner's own **Anthropic API key** | Yes | Yes | No: Anthropic requires everyone to bring their own | No |
| The owner's own **cloud account** for Claude (Bedrock, Vertex, Foundry) | Yes | Yes | No, as above | No |
| The owner's own **other API key** (OpenAI, OpenRouter, Gemini, …) | Yes | Yes | Only if the owner turns on `share-keys`, billed to them, never resold | No |
| A **Claude plan** (Pro, Max, Team, Enterprise) in **Claude Code** itself | Yes, paced like a person | No | No | No |
| A **ChatGPT plan** (Plus, Pro, …) in **Codex** itself | Yes, paced like a person | No | No | No |
| A Claude or ChatGPT plan's sign-in **inside another tool** (OMP, say) | No | No | No | No |
| A **local model** (Ollama, llama.cpp, LM Studio, vLLM) | Yes | Yes | Yes | No |

"Paced like a person" means one subscription run at a time, at least 30 seconds apart, and at most 40 a day; more
than that needs an API key.

Hildegard never reads, copies or moves any agent's sign-in files or tokens, never signs in for anyone, and never asks
for a password. It starts the vendor's own unmodified program, which uses its own sign-in.

## Anthropic: Claude Code

Source: [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), and the
[Consumer Terms](https://www.anthropic.com/legal/consumer-terms).

- Sign-in with a Claude plan (OAuth) "is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and
  Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic
  applications."
- Developers building products or services, including with the Agent SDK, "should use API key authentication through
  Claude Console or a supported cloud provider." Anthropic "does not permit third-party developers to offer Claude.ai
  login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of
  their users," and developers "may not collect, store, or intermediate Claude.ai credentials or session tokens."
- This "does not prevent an end user from signing in to the unmodified Claude Code binary with their own Claude
  subscription." "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and
  the Agent SDK."
- Products that run Claude Code: "The Claude Code binary must not be modified", nobody may "remove, disable, or
  restrict any authentication method built into it", and "Customers may not pay for, resell, or intermediate Claude
  usage on their end users' behalf. Each end user must authenticate with their own Anthropic API key, Claude
  subscription plan credentials, or 3P inference provider credential."
- An owner's own key may serve "the customer's own authorized users", "provided the resulting usage is billed to the
  key owner ... and is not resold or intermediated." Because invited people aren't the owner, Hildegard reads this
  strictly and never lets them run Claude on the owner's key or cloud account.
- Names: you may say in plain text that a product runs Claude Code, but not use Anthropic's or Claude Code's names
  or logos in a way that suggests Anthropic built or endorses it. Hildegard shows no Anthropic logos.

So Hildegard runs the `claude` program the owner installed and signed in to, unmodified, for the owner, when the owner
asks, and paces it. It never puts a Claude plan behind a schedule, a queue, or other people. For everything else it
uses the owner's own `ANTHROPIC_API_KEY` (from the keychain, passed in the environment) and removes any plan token
from that environment so the key, not the plan, is billed.

## OpenAI: Codex

Sources: [Codex authentication](https://learn.chatgpt.com/codex/auth),
[non-interactive mode](https://learn.chatgpt.com/codex/non-interactive-mode),
[Sign in with ChatGPT](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt),
[Terms of Use](https://openai.com/policies/terms-of-use).

- `codex exec` reuses Codex's saved sign-in. OpenAI recommends API keys (`CODEX_API_KEY`) as the default for
  automation; ChatGPT-managed sign-in in automation is an advanced option for trusted private runners, never public
  repositories. `auth.json` is to be treated like a password.
- Codex's page: "Use API key authentication for programmatic Codex CLI workflows, such as CI/CD jobs", "Don't expose
  Codex execution in untrusted or public environments", and treat `auth.json` "like a password ... Don't commit it,
  paste it into tickets, or share it in chat."
- A ChatGPT plan's usage reaches another app only through OpenAI's own Sign in with ChatGPT flow, where the app asks
  separately "to use the OpenAI usage included in an eligible ChatGPT plan" and you can cap it. OpenAI names its
  partners for this; OMP isn't one, and its ChatGPT login isn't that flow.
- Accounts are for one person; sharing them is forbidden.

So Hildegard runs `codex exec` with the owner's own Codex sign-in only when the owner asks, and uses
`CODEX_API_KEY` for anything unattended or scheduled.

## Models Hildegard calls itself

The owner can add any OpenAI-compatible model endpoint (`/api/llm/endpoints`). Hildegard refuses addresses that serve a
consumer plan (claude.ai, chatgpt.com, GitHub Copilot) and Claude Code's plan tokens (`sk-ant-oat…`) as keys, since
those plans may only be used in their own apps. Proxies on your own computer that wrap a plan (Copilot or Claude
"API" proxies) break the same rules; Hildegard can't always tell, so don't add one. The models here are shared at
`/v1` only with the owner's own keys, never with invited people.

## OMP (oh-my-pi)

Source: [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) documentation.

OMP can sign in to Anthropic and ChatGPT with their consumer plans, and can import Claude Code's data. Both providers
say those plans belong to their own apps (and OpenAI's listed partners), so Hildegard runs OMP only with an API key
(`--api-key` or a provider's key variable) or a local model. Each run gets its own OMP profile
(`PI_CODING_AGENT_DIR`) and an empty Claude data folder (`CLAUDE_CONFIG_DIR`), and the environment loses
`ANTHROPIC_OAUTH_TOKEN`, `XAI_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` and `OMP_AUTH_BROKER_URL`, so a plan's sign-in
can't leak in by accident.

## Pi

Source: [earendil-works/pi](https://github.com/earendil-works/pi) (formerly badlogic/pi-mono, npm `@earendil-works/pi-coding-agent`;
MIT licensed) documentation.

Pi is open source and uses your own model providers. Like OMP, it can sign in to Anthropic and ChatGPT with their
consumer plans (`/login`), and those providers say their plans belong to their own apps, so Hildegard runs Pi only with
an API key or a local model, from the provider its model names (`--provider` can't point elsewhere).

What a run gets:

- **A fresh profile.** Each run's Pi profile (`PI_CODING_AGENT_DIR`, `.pi-profile` in the run's folder) starts empty,
  then holds only Hildegard's MCP server in its `mcp.json` and the skills in its `skills` folder. Nothing Pi saves in
  one run, a login included, reaches the next. Hildegard never reads Pi's `auth.json` and doesn't reuse its
  credentials.
- **A short environment.** Pi starts with only `PATH`, `HOME`, the locale, the temp folder and Windows' system
  variables, plus the one key Hildegard gives it. No sign-in or other key in Hildegard's environment reaches it.
- **Files and Hildegard's tools, no shell.** Pi has no sandbox and can't allow a shell for some programs only, so it
  runs with `--tools read,edit,write,grep,find,ls,mcp__hildegard__*`. Media work goes through Hildegard's tools.
  A loop that needs a program such as Blender runs on Claude Code or Codex instead.
- **The task on stdin.** It never shows in a process list or passes through a shell.
- **No budget.** Pi can't stop at a spending limit, so `--budget` is refused; set a limit with your provider.

Hildegard checks that `pi` on your PATH is the coding agent (`pi --version` answers with a version) before it counts
Pi as installed. These runs follow Pi 1.4's documentation and haven't yet been tried against a real Pi install. `hildegard connect pi` only adds Hildegard
to `~/.pi/agent/mcp.json` and its skills to `~/.pi/agent/skills`; Pi signs in as you set it up.

## Other coding agents linked to Hildegard

`hildegard connect` only adds Hildegard's MCP server to an app's config and its skills to the app's skill folder; the
app signs in as it always does, and its maker's terms decide how. Each linked app's `sign-in-<app>` step says this:

| App | Sign-in that keeps you within the terms |
| --- | --- |
| Claude Code, Claude Desktop | Your Claude plan or an Anthropic API key: these are Anthropic's own apps |
| Codex | Your ChatGPT plan or an OpenAI API key: this is OpenAI's own app |
| OMP, Pi, OpenCode | An API key or a local model, never a Claude or ChatGPT plan's login (as for OMP above) |
| Gemini CLI | Your own Google account or Gemini API key, under Google's terms |
| Cursor, VS Code (Copilot), Windsurf | Their own accounts, under their makers' terms |
| LM Studio | Local models: nothing to sign in to |

Hildegard's tools run on the owner's own GPUs, so they add nothing to what any of these apps bill.

## Rented and borrowed GPUs

| Provider | Allowed use | Why |
| --- | --- | --- |
| Runpod | A pod that joins the owner's fleet | Runpod rents GPUs for exactly this, billed to the owner's account |
| Hugging Face Jobs | Batch jobs on the owner's account (coming next) | Pay-as-you-go compute on their plan |
| Google Colab | Only a notebook the owner runs themselves (coming next) | The [Colab FAQ](https://research.google.com/colaboratory/faq.html) forbids web services and remote proxies on every runtime, and remote control, bypassing the notebook UI and distributed workers on free ones |

## What this does not cover

This is Hildegard's reading of public terms, not legal advice. Anyone reselling access to models, or running agents
for paying customers, needs their own agreement with the provider.
