# Hildegard

Your own film studio, on your own GPU. Hildegard directs video models (LTX-2.5, LTX-2 and Wan 2.2) through ComfyUI
with real camera language: bodies, lenses, focal lengths, apertures, moves and film looks. Everything runs on your
computer. Nothing you make leaves it, and nothing costs money per shot.

Cinema Studio is the first room. Voice, music, images and 3D come next, all on the GPUs you already own.

## Install

**macOS and Linux**

```sh
curl -fsSL https://github.com/baney75/hildegard/releases/latest/download/install.sh | sh
```

**Windows** (PowerShell, no admin rights)

```powershell
irm https://github.com/baney75/hildegard/releases/latest/download/install.ps1 | iex
```

The installer checks every download against a SHA-256 written into it, puts everything in one folder in your home
(nothing system-wide, no sudo), then sets up ComfyUI and PyTorch for your GPU and starts Hildegard. Then:

```sh
hildegard setup     # picks a video model that fits your GPU and links your AI apps
hildegard open      # opens the Studio
```

| GPU memory | What `hildegard setup` picks |
| --- | --- |
| 24 GB or more (NVIDIA, AMD on Linux, or a Mac with 32 GB) | LTX-2.5 distilled: video with sound, up to 1088p |
| 12 to 23 GB | Wan 2.2 5B: silent video, 720p |
| Less, or no GPU | Nothing yet. The Studio works, but renders would take hours |

Where it lives: `~/.local/share/hildegard` on Linux, `~/Library/Application Support/Hildegard` on macOS,
`%LOCALAPPDATA%\Hildegard` on Windows. The `hildegard` command goes in `~/.local/bin` (Windows: the folder's `bin`,
added to your PATH). To remove Hildegard, run `hildegard stop` and delete that folder.

On [Omarchy](https://omarchy.org), the [Hildegard bar widget](omarchy/README.md) shows renders in your bar and can do
the install for you.

## Hugging Face

Wan downloads without an account. LTX asks you to accept its license on Hugging Face first, so Hildegard needs your
account to download it:

```sh
hildegard hf login
```

That signs you in with Hugging Face, or asks for a **read** token (from
[huggingface.co/settings/tokens](https://huggingface.co/settings/tokens/new?tokenType=read)) at a prompt that doesn't
echo. The token goes to your system keychain (macOS Keychain, Windows Credential Manager, or the Secret Service on
Linux), or to a file only you can read when no keychain runs. It is never written to `~/.cache/huggingface`, never
passed on the command line, and never shown to AI apps. The Studio's Settings › Hugging Face does the same.

## Use it from your AI apps

Hildegard is an MCP server. Linked apps (Claude Code, Claude Desktop, Codex, Cursor, OpenCode, VS Code, Windsurf, LM
Studio) can direct shots on your GPU as tools:

```sh
hildegard connect --all     # every app found on this computer
hildegard connect cursor    # or one
hildegard connect --print   # the config, for any other app that takes an MCP server
```

Each app's config is backed up once before Hildegard adds itself. The Studio's Agents page does the same, and shows
what each app made.

Tools: `hildegard_status` (with recent takes and their ids), `list_presets`, `direct_shot`, `shot_status`,
`get_shot`, `cancel_take`, `make_sequence`, `export_film`, `install_model`. `direct_shot` takes a `film`: a film's id,
or a title, which reuses the film with that title or makes one.

## At a link, for your other devices and the people you invite

Hildegard can be a server: your own studio at an HTTPS link, for your phone and laptop and for people you invite, all
signing in. It uses [Tailscale](https://tailscale.com); install it and sign in first. Then, on the computer with the GPU:

```sh
hildegard host owner        # your name and a passphrase, for signing in from other devices
hildegard host              # https://my-pc.tail1234.ts.net, on your tailnet
hildegard host invite       # a one-time link for someone else to join as a director
```

Open the link anywhere on your tailnet and sign in. Settings › Sharing and Settings › People do the same with buttons.

- **Directors** make films of their own, which only they and owners see. **Owners** can do everything: models,
  devices, people and settings. `hildegard host people` lists everyone; `hildegard host revoke <name>` signs someone
  out everywhere at once and keeps them out.
- The link is `tailscale serve`: HTTPS, reachable only inside your tailnet. To share with people outside it,
  `hildegard host --funnel` puts it on the public internet with `tailscale funnel`. Anyone could then reach the sign-in
  page, so use a long passphrase; Hildegard slows down guessing. `hildegard host off` turns the link off.
- This computer itself never signs in: the Studio at `127.0.0.1`, the CLI and your linked AI apps work as before.
  Turning the link on, linking apps, pairing devices and stopping Hildegard stay possible only from here.
- Passphrases are kept as scrypt hashes; sign-in cookies are HttpOnly, SameSite=Strict, Secure over HTTPS, and change
  every hour. Neither ComfyUI nor the device-pairing API is ever behind the link.

## Render on another device

A Mac or laptop without a big GPU can render on one of your other computers. Put both on your
[Tailscale](https://tailscale.com) tailnet and install Hildegard on both. On the computer with the GPU (here
`parish1`), with its models installed:

```sh
hildegard choir invite
```

It prints a one-line join code. On the other computer:

```sh
hildegard choir join        # paste the code when asked; it doesn't show
hildegard choir list        # parish1 · RTX 4080 Laptop, online, with its models
```

Takes now render on parish1, and the Studio says so ("Rendering on parish1 · RTX 4080 Laptop"). Models count as
installed when they are installed there, so nothing downloads twice. Settings › Devices does the same with buttons:
"Share this GPU" shows the code to copy, and "Add a device" takes it.

- `hildegard choir use local` renders here again; `hildegard choir use parish1` goes back. A computer without
  ComfyUI switches to the device it joins on its own.
- `hildegard choir leave parish1` forgets the device; `hildegard choir revoke` on parish1 stops sharing and turns
  every paired device away.
- The code holds a fresh 256-bit key. parish1 keeps only its hash; the other computer keeps it in the system
  keychain. Treat the code like a password, and make a new one for each device.
- Sharing opens one more door on parish1, on its Tailscale address only: renders from paired devices, and nothing
  else. The Studio and its API stay on 127.0.0.1 as before. Paired devices can only run graphs Hildegard itself
  builds, and their takes wait in parish1's own queue, so they never run at the same time as its own.
- Hildegard pairs only over Tailscale (or https), so prompts and videos are encrypted on the way. Without Tailscale
  on the GPU computer, give its address yourself: `hildegard choir invite --url http://100.x.y.z:7341`.

## Commands

```
hildegard install          Install ComfyUI and PyTorch for this GPU, then start Hildegard
hildegard setup            Pick a model that fits and link your AI apps
hildegard start | stop     Run Hildegard in the background, or stop it
hildegard status           What's installed and running
hildegard doctor           Check every part, with the command that fixes each problem
hildegard open             Open the Studio in your browser
hildegard models           Models, and whether they fit this GPU
hildegard models install <id> [--accept-license]
hildegard connect [<app>...] | disconnect <app>
hildegard hf login | status | logout
hildegard choir invite | join | list | use <device|local> | leave <device> | revoke
hildegard host [--funnel] | off | status | owner | invite [--role owner] | people | revoke <name> | limit <n>
hildegard mcp              The MCP server, on stdio (AI apps run this)
```

Every command takes `--json` and then prints `{ ok, needsOwner, steps[], message }`. Agents setting Hildegard up for
someone should read [docs/agents.md](docs/agents.md): the app on one computer, a host at a link, or a fleet.

## Licenses

Hildegard is AGPL-3.0-only; the presets in `presets/` are Apache-2.0. The models have their own licenses, which
Hildegard shows before any download: LTX-2.x is free for people and companies under $10M yearly revenue, Wan 2.2 is
Apache-2.0. See [LICENSING.md](LICENSING.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Develop

Node 22.18 or later and pnpm 10. If you don't have pnpm, `npm install -g pnpm@10.28.0` (Node 25 and later no longer
include corepack).

```sh
pnpm install
pnpm dev                                   # server on :7341 with a fake GPU, Studio on :5173
pnpm test && pnpm typecheck && pnpm lint
pnpm e2e                                   # Playwright, desktop and phone
```

See [AGENTS.md](AGENTS.md) for how the code is laid out.
