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

Tools: `hildegard_status`, `list_presets`, `direct_shot`, `shot_status`, `get_shot`, `make_sequence`, `export_film`,
`install_model`.

## From another device

Use [Tailscale](https://tailscale.com). Bind Hildegard to this computer's Tailscale address, and allow its name:

```sh
hildegard restart --host "$(tailscale ip -4)" --allow-host my-pc.tail1234.ts.net
```

Then open `http://my-pc.tail1234.ts.net:7341` on your phone or laptop. Hildegard still answers on 127.0.0.1 for this
computer's own apps, and nothing else on your network can reach it. Hildegard Link, an end-to-end encrypted relay of
our own, is coming.

## Commands

```
hildegard install          Install ComfyUI and PyTorch for this GPU, then start Hildegard
hildegard setup            Pick a model that fits and link your AI apps
hildegard start | stop     Run Hildegard in the background, or stop it
hildegard status           What's installed and running
hildegard open             Open the Studio in your browser
hildegard models           Models, and whether they fit this GPU
hildegard models install <id> [--accept-license]
hildegard connect [<app>...] | disconnect <app>
hildegard hf login | status | logout
hildegard mcp              The MCP server, on stdio (AI apps run this)
```

Every command takes `--json` and then prints `{ ok, needsOwner, steps[], message }`. Agents setting Hildegard up for
someone should read [INSTALL-FOR-AGENTS.md](INSTALL-FOR-AGENTS.md).

## Licenses

Hildegard is AGPL-3.0-only; the presets in `presets/` are Apache-2.0. The models have their own licenses, which
Hildegard shows before any download: LTX-2.x is free for people and companies under $10M yearly revenue, Wan 2.2 is
Apache-2.0. See [LICENSING.md](LICENSING.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Develop

Node 22.18 or later and pnpm 10.

```sh
pnpm install
pnpm dev                                   # server on :7341 with a fake GPU, Studio on :5173
pnpm test && pnpm typecheck && pnpm lint
pnpm e2e                                   # Playwright, desktop and phone
```

See [AGENTS.md](AGENTS.md) for how the code is laid out.
