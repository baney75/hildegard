# Installing Hildegard for your user

This is for AI agents (Claude Code, Codex, Cursor, OpenCode and the like) setting Hildegard up on someone's computer.
Every step runs without questions and prints JSON. A few steps belong to your user alone; the JSON marks them and says
what to ask.

## 1. Install

macOS and Linux:

```sh
curl -fsSL https://github.com/baney75/hildegard/releases/latest/download/install.sh | sh -s -- --json
```

Windows, in PowerShell:

```powershell
$env:HILDEGARD_INSTALL_ARGS = '--json'; irm https://github.com/baney75/hildegard/releases/latest/download/install.ps1 | iex
```

No sudo or admin rights. It installs into the user's home folder only, checks every download's SHA-256, sets up
ComfyUI and PyTorch for the GPU it finds (NVIDIA CUDA, AMD ROCm on Linux, Apple Metal, or the CPU), and starts
Hildegard at `http://127.0.0.1:7341`. It takes a few minutes; PyTorch is the big download. Running it again is safe and
only fetches what changed.

The `hildegard` command is then in `~/.local/bin` (Windows: `%LOCALAPPDATA%\Hildegard\bin`). If it isn't on PATH yet
in your shell, call it by that full path.

## 2. Set up

```sh
hildegard setup --yes --json
```

This picks the best video model that fits the GPU, starts its download if your user has accepted its license, and links
every AI app it finds on this computer (`--yes` links them; leave it off to link none).

## 3. Read the result

Every command prints:

```json
{
  "ok": true,
  "needsOwner": true,
  "steps": [
    { "id": "model", "title": "Install LTX-2.5 distilled", "status": "needs-owner",
      "detail": "LTX-2.5 distilled comes under the LTX-2.x Community License (…). The owner must accept it first: …",
      "command": "hildegard models install ltx-2-5-distilled --accept-license" }
  ],
  "message": "Open the Studio at http://127.0.0.1:7341, once the steps marked ! are done."
}
```

`status` is `done`, `skipped` (already so), `needs-owner` or `failed`. `ok` is false when a step failed; the exit code is
then 1. When `needsOwner` is true, handle each `needs-owner` step as below, then run the same command again.

## What only your user can do

**Accept a model's license.** Show your user the `detail` text word for word: the license name, its link and every
term. LTX-2.x, for one, is free only for people and companies under $10M yearly revenue. Ask whether they accept. Only
if they say yes, run the step's `command` (it adds `--accept-license`). Never accept a license on your own judgment.

**Link Hugging Face** (step `command` is `hildegard hf login`). LTX downloads need your user's own Hugging Face account
and their acceptance of the license on the model's Hugging Face page. You cannot do this for them, and you must never
ask them to paste a token to you. Ask them to run `hildegard hf login` in a terminal on this computer, or to use
Settings › Hugging Face in the Studio. Either way the token goes to their system keychain, never into chat, files you
can read, or command lines. `hildegard hf status --json` tells you when it's done.

**Install a GPU driver** (step `check` is `needs-owner`). Tell them what the `detail` says. Driver installs need their
admin rights.

## After setup

```sh
hildegard status --json     # GPU, ComfyUI, models and downloads, linked apps
hildegard models --json     # every model, whether it fits this GPU, and its license
hildegard connect <app>     # claude-code, claude-desktop, codex, cursor, opencode, vscode, windsurf, lm-studio
hildegard open              # the Studio, in the browser
```

Once linked and restarted, an app has these tools: `hildegard_status`, `list_presets`, `direct_shot`, `shot_status`,
`get_shot`, `make_sequence`, `install_model`. If your app isn't in the list, `hildegard connect --print --json` gives
the MCP server config to add by hand: it runs `hildegard mcp` on stdio.

## If something fails

The step's `detail` says what happened. Logs are in the data folder's `logs/` (`install.log`, `comfyui.log`,
`comfy-api-proxy.log`, `server.log`); the data folder is `~/.local/share/hildegard` on Linux,
`~/Library/Application Support/Hildegard` on macOS, `%LOCALAPPDATA%\Hildegard` on Windows. `hildegard install --json`
is safe to rerun. Add `--cpu` to install the CPU build when the GPU build won't work, which renders far too slowly
for real use.
