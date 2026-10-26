# Setting up Hildegard: a guide for AI agents

For AI agents (Claude Code, Codex, Cursor, OpenCode and the like) setting Hildegard up for someone, end to end. Pick
the goal your user asked for and follow its steps in order. Every command takes `--json`, never asks a question with
it, and is safe to run again: a step that is already done comes back as `skipped`.

| Goal | What your user gets |
| --- | --- |
| [A. The app on this computer](#a-the-app-on-this-computer) | The Studio at `http://127.0.0.1:7341`, and Hildegard's tools in their AI apps |
| [B. Host it at a link](#b-host-it-at-a-link) | Their own Hildegard at an HTTPS link, for their phone, laptop and the people they invite, all signing in |
| [C. Join a fleet](#c-join-a-fleet) | Their devices render on each other over Tailscale: a laptop without a GPU uses the desktop's |
| [D. Rent a GPU](#d-rent-a-gpu) | A Runpod GPU that joins their fleet and stops itself when idle |
| [E. Skills and coding agents](#e-skills-and-coding-agents) | Hildegard's skills in Claude Code, Codex and OMP, and agent runs within each provider's terms |
| [F. AI apps on other devices, and chatbots](#f-ai-apps-on-other-devices-and-chatbots) | Hildegard's tools in the AI apps on their laptop, and in claude.ai or ChatGPT |
| [G. Their local models](#g-their-local-models) | The models they run (Ollama, LM Studio, llama.cpp, vLLM, MLX…) direct shots, and serve their other devices |

B and C build on A: do A first on every computer involved.

## How to read the output

Every command prints one JSON object:

```json
{ "ok": true, "needsOwner": false, "steps": [ { "id": "…", "title": "…", "status": "done", "detail": "…", "command": "…" } ], "message": "…" }
```

- `status` is `done`, `skipped` (already so, or optional and not set up), `needs-owner` or `failed`.
- `ok` is false when a step failed, and the exit code is then 1. Run the failed step's `command`, then the same command
  again.
- `needsOwner` is true when a step waits on your user. See [What only your user can do](#what-only-your-user-can-do),
  then run the same command again.
- Extra fields (such as `url`, `host`, `models`) carry the details; the verification sections below say which to read.

When anything is unclear, run `hildegard doctor --json`. It checks the GPU, ComfyUI, models, Hugging Face, Tailscale,
paired devices, host mode and linked apps, changes nothing, and gives each problem a `command` that fixes it.

## Rules

- **Never accept a model license on your own judgment.** Show your user the license step's `detail` word for word and
  ask. Only after a clear yes, pass `--accept-license <model id>`, naming that one model.
- **Never choose, see or store a passphrase or token.** The owner types their passphrase into
  `hildegard host owner` or the Studio; the owner links Hugging Face with `hildegard hf login`. If your user hands you a
  Hugging Face token anyway, pipe it on stdin (`--hf-token-stdin`), never put it in a command line, a file or a log.
- **Treat invite links and join codes as passwords.** Hand each straight to your user (or the next command, on stdin),
  and never write them to logs or files.
- **Never turn on Funnel (the public internet) unless your user asked for exactly that.** Tailscale Serve, inside their
  tailnet, is the default.

## A. The app on this computer

1. Install, if `hildegard` isn't there yet. macOS and Linux:

   ```sh
   curl -fsSL https://github.com/baney75/hildegard/releases/latest/download/install.sh | sh -s -- --json
   ```

   Windows, in PowerShell:

   ```powershell
   $env:HILDEGARD_INSTALL_ARGS = '--json'; irm https://github.com/baney75/hildegard/releases/latest/download/install.ps1 | iex
   ```

   It needs no sudo or admin rights, checks every download's SHA-256, installs ComfyUI and PyTorch for the GPU it
   finds, and starts Hildegard. The command lands in `~/.local/bin` (Windows: `%LOCALAPPDATA%\Hildegard\bin`); call
   it by that path if it isn't on `PATH` yet. Rerunning it fetches only what changed.

   A person can install with the [Hildegard app](../README.md#the-hildegard-app) instead: it runs this same install
   from a window, into the same folder and with the same `hildegard` command, so every step below works after it.

2. Set up a model and link the AI apps on this computer:

   ```sh
   hildegard setup --yes --json
   ```

   It picks the best model that fits the GPU. Its `model` step is usually `needs-owner` with the license in `detail`:
   show it to your user. If they accept, run the step's `command`, which names the model:

   ```sh
   hildegard setup --model wan-2-2-ti2v-5b --accept-license wan-2-2-ti2v-5b --yes --json
   ```

   A gated model (LTX) also needs your user's Hugging Face account: the step's `command` is `hildegard hf login`,
   which they run themselves. If your user gives you a read token instead, pipe it:
   `printf %s "$TOKEN" | hildegard setup --model ltx-2-5-distilled --accept-license ltx-2-5-distilled --hf-token-stdin --yes --json`.
   `--yes` links every AI app found; leave it off to link none (later: `hildegard connect <app> --json`).

3. Verify:

   ```sh
   hildegard status --json
   ```

   | Field | Expect |
   | --- | --- |
   | `running` | `true` |
   | `engine.online` | `true` (ComfyUI answers) |
   | `models[]` | the chosen model with `installed: true`, or `downloading` with `done`/`total` bytes while it downloads |
   | `agents[]` | the apps you linked with `connected: true` |

   The Studio is at `url` (`http://127.0.0.1:7341` unless another port was given). `hildegard open` opens it.

4. Direct with the tools. In a linked app, start with `hildegard_status`: it lists the models and the recent takes,
   with their ids, status, shot and film. `direct_shot` puts a shot in the film named by `film`, a film id or a title
   (such as `"Agent Cut"`): a title reuses the film with exactly that title, or makes it. `make_sequence` makes a new
   film of several shots at once. To stop a take you queued by mistake, `cancel_take` with its id; a finished take
   can't be canceled.

## B. Host it at a link

Hildegard as a server your user and the people they invite reach at a link. Everyone signs in there; this computer
itself never has to. Do A on this computer first.

Hildegard uses [Tailscale](https://tailscale.com): `tailscale serve` gives the link HTTPS inside your user's tailnet, and
only on request, `tailscale funnel` puts it on the public internet. Hildegard never puts ComfyUI or the paired-device API
behind the link.

1. **Tailscale.** `hildegard doctor --json` has a `tailscale` step. If it isn't `done`, your user installs Tailscale
   from tailscale.com and signs in (`tailscale up`). That's theirs to do.

2. **The owner account.** Check `hildegard host status --json`: when `host.owner` is false, ask your user to run this
   in a terminal on this computer, or to use Settings › Sharing in the Studio here:

   ```sh
   hildegard host owner
   ```

   It asks for their name and a passphrase of at least 10 characters, which doesn't show. If your user insists on
   handing you the passphrase to set, pipe it, and never echo it: `printf %s "$PASS" | hildegard host owner --name
   "Their Name" --passphrase-stdin --json`. Running it again with the same name sets a new passphrase and signs them
   out everywhere: that's also how a forgotten passphrase is replaced.

3. **The link.**

   ```sh
   hildegard host --json
   ```

   On success the `host` step is `done` and `url` is the link, such as `https://parish1.tail1234.ts.net`. Rerunning it
   keeps the same link. When a step is `needs-owner`, its `command` is the fix; the usual ones:

   | `command` | Why |
   | --- | --- |
   | `sudo tailscale set --operator=$USER` | Linux: Tailscale lets only root change its serve settings until your user allows it once |
   | `https://login.tailscale.com/f/serve?…` or `…/f/funnel?…` | HTTPS (or Funnel) isn't turned on for the tailnet yet: your user opens the page and turns it on |
   | `https://login.tailscale.com/admin/dns` | MagicDNS and HTTPS certificates are off for the tailnet |
   | `hildegard host owner` | No owner account yet (step 2) |

   Only if your user asked for the public internet: `hildegard host --funnel --json`. The result carries a `warning`;
   show it to them. `hildegard host --json` moves the link back inside the tailnet; `hildegard host off --json` turns
   it off, keeping accounts for next time. Without `tailscale serve` (an old Tailscale), `hildegard host --address
   "$(tailscale ip -4)" --json` answers on the Tailscale address over plain HTTP, which WireGuard encrypts; Hildegard
   refuses any address outside the tailnet.

4. **Invite people**, when your user asks:

   ```sh
   hildegard host invite --role director --json
   ```

   `url` is a one-time link, valid for three days (`--hours 1` to `720` to change that). Give it to your user to send;
   whoever opens it first chooses a name and passphrase. A **director** makes films of their own, seen only by them and
   owners; an **owner** (`--role owner`) can do everything, including models, devices, people and settings.
   `hildegard host people --json` lists everyone and unused invites; `hildegard host role <name> owner|director --json`
   changes a role; `hildegard host revoke <name> --json` removes someone and ends every session they have at once.
   `hildegard host limit <n> --json` sets how many takes each director may have waiting at once (default 3, 1 to 100;
   owners and this computer have no limit), and `hildegard host limit --json` reads it. Anyone signed in can change
   their own passphrase in Settings › Your account; doing so signs them out everywhere else.

5. Verify:

   ```sh
   hildegard host status --json
   ```

   | Field | Expect |
   | --- | --- |
   | `host.on` | `true` |
   | `host.url` | the link (null while it isn't working) |
   | `host.problem` | `null`; otherwise one sentence on what's wrong, with `host.fix` the command or page that fixes it |
   | `host.owner` | `true` |
   | `host.via` | `tailscale` (Serve), `funnel` or `address` |

   Then ask your user to open the link on their phone and sign in. `hildegard status --json` also carries `host`.

What stays as it was: the CLI, linked AI apps and the Studio on this computer itself (at `127.0.0.1`) never sign in.
Linking apps, pairing devices, stopping Hildegard and turning the link on or off work only from this computer.

## C. Join a fleet

Devices render on each other over Tailscale: one with a GPU shares it, the others join and send it their takes. Do A
on every device (on one without a GPU, `hildegard install --yes --json` then skip the model), and have Tailscale signed
in on each.

1. **On the device with the GPU**, with a model installed:

   ```sh
   hildegard choir invite --json
   ```

   `code` is a one-time join code holding a key. Hand it straight to the next step; never log it. Without Tailscale it
   returns `needs-owner` with `tailscale up`; pass `--url http://<tailscale-ip>:7341` only with an address on the
   tailnet.

2. **On each other device**, pipe the code in (a code on the command line lands in shell history):

   ```sh
   printf %s "$CODE" | hildegard choir join --code-stdin --json
   ```

   A device without ComfyUI switches to rendering there at once. Otherwise `hildegard choir use <device> --json`.

3. Verify on the joined device:

   ```sh
   hildegard choir list --json
   hildegard status --json
   ```

   | Field | Expect |
   | --- | --- |
   | `choir.use` | the GPU device's name |
   | `choir.devices[]` | that device with `online: true`, its `gpu`, and its `models` |
   | `engine.comfy` (from status) | `remote`, with `engine.device` naming the device and `engine.online: true` |

   `hildegard choir use local --json` renders here again; `hildegard choir leave <device> --json` forgets a device;
   `hildegard choir revoke --json` on the GPU device turns every paired device away.

A fleet and a link go together: the computer with the link (B) can render on the fleet's GPU (C), so people signing in
at the link use it without knowing where it is.

## D. Rent a GPU

For a user with no GPU, or who needs a bigger one for a while. Billed to their own Runpod account; say so first. Do A
on this computer (no model needed), then:

```sh
printf %s "$RUNPOD_API_KEY" | hildegard cloud runpod key --key-stdin --json
hildegard cloud runpod up --model wan-2-2-ti2v-5b --json
```

The second command returns the model's license as `needs-owner`; handle it as in the rules above, then run the step's
`command`. The first start takes 10 to 30 minutes; if `up` says it is still setting up, run it again later. Verify
with `hildegard cloud runpod status --json` (`device.online: true`). `hildegard cloud runpod down --json` stops it; it
also stops itself after 30 idle minutes. Details: [cloud.md](cloud.md).

## E. Skills and coding agents

```sh
hildegard connect --all --json    # tools and skills in every coding agent here, with a sign-in step for each
hildegard skills install --json   # only the skills, where Claude Code, Codex, OMP, Pi, Gemini CLI and OpenCode read them
hildegard agents --json           # each coding agent here, how it's signed in, and what Hildegard may do with it
```

The skills hold Hildegard's quality bar ([craft.md](craft.md)): brief, lint the prompt, review every take, at most
three rounds. Agent runs follow each provider's terms ([agent-terms.md](agent-terms.md)): a Claude or ChatGPT plan
only in its own app, only when your user starts the run; OMP, Pi and OpenCode only with an API key or a local model; API keys (piped with
`hildegard agents key <provider> --key-stdin`) for everything else; never a plan's sign-in inside another tool.

A whole loop (generate, render, critique, refine) can go to a coding agent, started by your user:

```sh
hildegard loop run codex "a standing heron finial, 120 mm, for an FDM print" --kind model --print --size 40x40x120 --json
hildegard loop show <id> --json   # every round: its checks, its sheet, its critique
```

The result's `loop` names the loop and the round delivered. The **hildegard-loop** skill has the rest.

## F. AI apps on other devices, and chatbots

Hildegard's MCP answers at `/mcp` (Streamable HTTP, stateless) as well as on stdio. On the computer Hildegard runs on
it needs nothing. Anywhere else it needs a bearer token and acts as that token's person, with their role. Do B first.

**An AI app on another of your user's devices** (their laptop's Claude Code, say):

1. On the computer with Hildegard:

   ```sh
   hildegard host key "Claude Code on the laptop" --json
   ```

   `key` (`hgk_…`) is a secret, shown this once. Hand it straight to the next step; never log it or write it to a file.
   It acts as the owner unless you pass `--person <name>`; `--days <n>` makes it expire.
2. On the other device, with Hildegard installed there too (the CLI is enough), pipe it in:

   ```sh
   printf %s "$KEY" | hildegard connect claude-code --remote https://parish1.tail1234.ts.net --key-stdin --json
   ```

   It checks the key against that Hildegard first, keeps it in the keychain, and links the app to
   `hildegard mcp --remote <link>`. The app's config never holds the key.
3. Verify: the `remote` step is `done` with a tool count, and the app's `connect-…` step is `done`.

An app that takes an MCP address and headers can skip step 2: `<link>/mcp` with `Authorization: Bearer <key>`.

**A chatbot on the web** (claude.ai, ChatGPT) runs on its maker's servers, so it can't reach a tailnet. It needs the
public link, which only your user may ask for: `hildegard host --funnel --json` (show them its `warning`). Then:

- **claude.ai:** Settings › Connectors › Add custom connector, with the address in `mcpUrl`.
- **ChatGPT:** Settings › Apps › Developer mode, then Create, with that address. It needs Plus or
  higher.
- **Grok:** grok.com › Connectors › New connector › Custom, with that address.
- **Grok Bot:** it runs on its own cloud computer, so it needs this public link too. Tell it to add a custom MCP
  server named `hildegard` at that address, with OAuth.

Every app's steps, the Claude Code plugin and the skill uploads are in `docs/chatbots.md`.

The chatbot opens Hildegard's sign-in page, where **your user** types their own name and passphrase. Never do it for
them. It then acts as them, until they revoke it or change their passphrase.

`hildegard host keys --json` lists every key and chatbot (`grants[]`, with `kind`, `person` and `lastUsedAt`);
`hildegard host keys revoke <id|name> --json` ends one at once. `hildegard doctor --json` has an `mcp` step.

What a remote app gets differs in two ways: videos and stills come as links (signed, good for a day) instead of paths,
and a start frame goes as `start_frame_data` (base64), since a path would be read on the wrong computer.

## G. Their local models

Hildegard finds what runs on this computer: Ollama (11434, or `OLLAMA_HOST`'s port), LM Studio (1234), llama.cpp,
MLX LM or llamafile (8080), vLLM (8000), SGLang (30000), Jan (1337), KoboldCpp (5001), TabbyAPI (5000), and Local AI's
gateways on Omarchy.

```sh
hildegard llm --json
```

`endpoints[]` lists each with `online`, `url` and `models[]` (`id`, and `size`, `context`, `loaded` where the runtime
says). To add one it doesn't find, such as a server elsewhere on their network:

```sh
printf %s "$API_KEY" | hildegard llm add "Desk vLLM" http://desk:8000/v1 --key-stdin --json   # key only if it needs one
```

To let one direct:

```sh
hildegard llm use ollama qwen3:8b --json                          # optional: which one, from now on
hildegard llm direct "a heron lifting off a misty lake at dawn" --film "Heron" --json
```

`mode` is `tools` when the model called Hildegard's tools itself, or `plan` when it wrote a shot list that Hildegard
checked and queued (`--plan` asks for that from the start, which suits small models). `shots[]` are the shot ids;
follow them with `hildegard status --json` or the MCP's `shot_status`. A local model is never given `install_model`.

Every local model here is also one OpenAI-compatible API at `http://127.0.0.1:7341/v1`, with models named
`<endpoint>/<model>` (`ollama/qwen3:8b`). From your user's other devices it is at `<link>/v1`, with an owner's key from
`hildegard host key` as the bearer token: point any OpenAI-compatible app or agent there.

## What only your user can do

| Step | What to tell them |
| --- | --- |
| A model license (`model`, `needs-owner`) | Show `detail` word for word. Only on a clear yes, run the step's `command` |
| Hugging Face (`command`: `hildegard hf login`) | Run it in a terminal here, or use Settings › Hugging Face. They accept the model's license on its Hugging Face page too |
| A GPU driver (`check`, `needs-owner`) | What `detail` says. Driver installs need their admin rights |
| Tailscale (`command`: `tailscale up`) | Install Tailscale and sign in |
| The owner account (`command`: `hildegard host owner`) | Run it in a terminal here and choose a passphrase, or use Settings › Sharing |
| Tailscale permission or a Tailscale admin page | Run the command, or open the page and turn the feature on |
| A Runpod or provider API key (`key`, `needs-owner`) | Make the key on the provider's site and hand it to you to pipe in; it's billed to them |
| A chatbot's sign-in (claude.ai, ChatGPT) | They add the connector and type their own name and passphrase on Hildegard's page |
| The public internet (`hildegard host --funnel`) | Only when they asked for it: chatbots on the web need it, AI apps on their own devices don't |

## If something fails

The step's `detail` says what happened, and `hildegard doctor --json` says what to run. Logs are in the data folder's
`logs/` (`install.log`, `comfyui.log`, `comfy-api-proxy.log`, `server.log`); the data folder is
`~/.local/share/hildegard` on Linux, `~/Library/Application Support/Hildegard` on macOS and `%LOCALAPPDATA%\Hildegard` on
Windows. Every command here is safe to run again.

## Telling Hildegard's makers: bugs and ideas

When Hildegard itself is at fault (a command or tool fails in a way the doctor's fix and a changed request don't
cure, or it crashes), or your user wants something Hildegard can't do yet, offer to tell the people who make it. Never
file without your user's yes: an issue is public, under their name.

1. **Draft.** Over MCP: `report_draft` (kind `bug` or `idea`, a one-line title, and `what`). From a shell:

   ```sh
   hildegard report bug "Draft takes fail on a 4 GB GPU" --what "What you did, what you expected, what happened" --json
   hildegard report idea "Cut a trailer from my takes" --what "The work they want to make" --json
   ```

   A bug carries `hildegard doctor`, the version, the system and the end of `server.log` (`--no-log` leaves the log
   out). Keys and tokens, home folders, the account and computer names, device and people names, tailnet names, IP and
   email addresses are taken out of every part, and the draft says how many of each. Nothing is sent but the title's
   words, to search GitHub for issues like it.
2. **Show it.** Give your user the title and text word for word, and the matching issues. If one is the same thing,
   add to it rather than open another.
3. **On their yes, file it.** `report_file` with the draft's id and `confirm: true` (and `on: <number>` to add to an
   open issue), or `hildegard report file <id> [--on <number>]`. It files exactly the text they read, through the
   GitHub CLI signed in on the computer Hildegard runs on, as them. Without the GitHub CLI, or for someone who isn't the
   owner, the draft's `url` opens the issue form on GitHub filled in, for them to send from their own account.

A draft files once; the same title from the same computer goes on the first issue; at most five go from one computer in
a day. Security problems never go in an issue: see `SECURITY.md`.

