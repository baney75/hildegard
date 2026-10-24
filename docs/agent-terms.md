# Running coding agents within their providers' terms

Hildegard can start Claude Code, Codex and OMP (oh-my-pi) for its owner, with Hildegard's MCP tools and skills, to
make and edit films, photos, art and sound. This page says which ways of running them are allowed, which aren't, and
why, from each provider's own published terms. `packages/agents/src/policy.ts` enforces exactly this table before
anything starts; `hildegard agents --json` shows the verdict for each agent on a computer.

Read on 2026-10-24. Terms change: when a provider's page changes, update this page and `policy.ts` together, and where
a provider is silent the answer is no.

## The short version

| How the agent is signed in | Owner, asked just now | Owner, on a schedule or unattended | People the owner invited | Another device in the fleet |
| --- | --- | --- | --- | --- |
| The owner's own **API key** (Anthropic, OpenAI, OpenRouter, Gemini, …) | Yes | Yes | Only if the owner turns on `share-keys`, billed to them, never resold | No |
| The owner's own **cloud account** (Bedrock, Vertex, Foundry) | Yes | Yes | As API keys | No |
| A **Claude plan** (Pro, Max) in **Claude Code** itself | Yes, paced like a person | No | No | No |
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

- Sign-in with a Claude plan (OAuth for Free, Pro and Max) is "intended exclusively for ... ordinary use of Claude Code
  and other native Anthropic applications."
- Developers building products or services, including with the Agent SDK, must use an API key or a supported cloud
  provider. Third-party products may not offer claude.ai sign-in, may not route requests through a plan's credentials
  on behalf of their users, and may not collect or store those credentials.
- It also says this "does not prevent an end user from signing in to the unmodified Claude Code binary with their own
  Claude subscription", and that "Advertised usage limits ... assume ordinary, individual usage of Claude Code and the
  Agent SDK."

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
- Using a ChatGPT plan through Sign in with ChatGPT in third-party tools is allowed only for the partners OpenAI lists
  (OpenCode, OpenClaw, Pi, T3 and others as of the 2026-09-29 announcement). OMP is not among them.
- Accounts are for one person; sharing them is forbidden.

So Hildegard runs `codex exec` with the owner's own Codex sign-in only when the owner asks, and uses
`CODEX_API_KEY` for anything unattended or scheduled.

## OMP (oh-my-pi)

Source: [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) documentation.

OMP can sign in to Anthropic and ChatGPT with their consumer plans, and can import Claude Code's data. Both providers
say those plans belong to their own apps (and OpenAI's listed partners), so Hildegard runs OMP only with an API key
(`--api-key` or a provider's key variable) or a local model. Each run gets its own OMP profile
(`PI_CODING_AGENT_DIR`) and an empty Claude data folder (`CLAUDE_CONFIG_DIR`), and the environment loses
`ANTHROPIC_OAUTH_TOKEN`, `XAI_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` and `OMP_AUTH_BROKER_URL`, so a plan's sign-in
can't leak in by accident.

## Rented and borrowed GPUs

| Provider | Allowed use | Why |
| --- | --- | --- |
| Runpod | A pod that joins the owner's fleet | Runpod rents GPUs for exactly this, billed to the owner's account |
| Hugging Face Jobs | Batch jobs on the owner's account (coming next) | Pay-as-you-go compute on their plan |
| Google Colab | Only a notebook the owner runs themselves (coming next) | The [Colab FAQ](https://research.google.com/colaboratory/faq.html) forbids web services and remote proxies on every runtime, and remote control, bypassing the notebook UI and distributed workers on free ones |

## What this does not cover

This is Hildegard's reading of public terms, not legal advice. Anyone reselling access to models, or running agents
for paying customers, needs their own agreement with the provider.
