# Setting up Hildegard: a guide for AI agents

For AI agents (Claude Code, Codex, Cursor, OpenCode and the like) setting Hildegard up for someone, end to end. Pick
the goal your user asked for and follow its steps in order. Every command takes `--json`, never asks a question with
it, and is safe to run again: a step that is already done comes back as `skipped`.

| Goal | What your user gets |
| --- | --- |
| [A. The app on this computer](#a-the-app-on-this-computer) | The Studio at `http://127.0.0.1:7341`, and Hildegard's tools in their AI apps |
| [B. Host it at a link](#b-host-it-at-a-link) | Their own Hildegard at an HTTPS link, for their phone, laptop and the people they invite, all signing in |
| [C. Join a fleet](#c-join-a-fleet) | Their devices render on each other over Tailscale: a laptop without a GPU uses the desktop's |

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

## What only your user can do

| Step | What to tell them |
| --- | --- |
| A model license (`model`, `needs-owner`) | Show `detail` word for word. Only on a clear yes, run the step's `command` |
| Hugging Face (`command`: `hildegard hf login`) | Run it in a terminal here, or use Settings › Hugging Face. They accept the model's license on its Hugging Face page too |
| A GPU driver (`check`, `needs-owner`) | What `detail` says. Driver installs need their admin rights |
| Tailscale (`command`: `tailscale up`) | Install Tailscale and sign in |
| The owner account (`command`: `hildegard host owner`) | Run it in a terminal here and choose a passphrase, or use Settings › Sharing |
| Tailscale permission or a Tailscale admin page | Run the command, or open the page and turn the feature on |

## If something fails

The step's `detail` says what happened, and `hildegard doctor --json` says what to run. Logs are in the data folder's
`logs/` (`install.log`, `comfyui.log`, `comfy-api-proxy.log`, `server.log`); the data folder is
`~/.local/share/hildegard` on Linux, `~/Library/Application Support/Hildegard` on macOS and `%LOCALAPPDATA%\Hildegard` on
Windows. Every command here is safe to run again.
