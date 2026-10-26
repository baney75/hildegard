# Hildegard for Omarchy

Your own film studio, on your own GPU, in your Omarchy bar. A small aperture ring sits on the right; it fills while a
take renders. Click it for a panel that shows what's rendering, the last five takes (click one to open it in the
Studio), and buttons to start or stop Hildegard, open the Studio, the queue, or the page that links your AI apps. When a
take finishes while the panel is closed, you get a notification that opens it. When a new Hildegard is out, the panel
offers **Update to** it; Hildegard also updates itself when nothing is rendering, unless you turned that off in
Settings.

![Hildegard in the Omarchy bar](preview.png)

## Install

```sh
omarchy plugin add https://github.com/baney75/omarchy-hildegard --enable
```

`--enable` asks where in the bar to put it. Then click the ring and choose **Set up Hildegard**. That's all: no
password, no logout, no reboot.

**Set up** opens a terminal and:

1. Installs Hildegard for you alone, into `~/.local/share/hildegard` with a `hildegard` command in `~/.local/bin`. No
   root, nothing outside your home folder. It runs the installer that ships inside this plugin,
   [`share/install.sh`](share/install.sh) (the very one each [Hildegard release](https://github.com/baney75/hildegard/releases)
   publishes), and only if it matches the SHA-256 pinned in [`release.env`](release.env). The installer downloads
   Node.js from nodejs.org and Hildegard from GitHub, and refuses either unless it matches the SHA-256 written into it.
2. Runs `hildegard install`, which sets up ComfyUI and PyTorch for your GPU (NVIDIA or AMD), about 8 GB.
3. Runs `hildegard setup`, which picks a video model that fits your GPU and asks you before accepting its license or
   linking any AI app.

If Hildegard is already installed (say, with the [one-line installer](https://github.com/baney75/hildegard#install)),
Set up skips step 1 and the widget finds the `hildegard` command on your PATH or in `~/.local/bin`.

### For AI agents

Everything above runs without a person at the keyboard too, with the same checked installer:

```sh
omarchy plugin add https://github.com/baney75/omarchy-hildegard --enable --yes
~/.config/omarchy/plugins/io.github.baney75.hildegard/bin/hildegard-omarchy-setup --yes --json
```

The second line asks nothing: it installs Hildegard, sets up ComfyUI and PyTorch, links the AI apps it finds and
accepts no license. Its progress goes to stderr, and stdout holds only `hildegard setup`'s JSON, which
[INSTALL-FOR-AGENTS.md](https://github.com/baney75/hildegard/blob/main/INSTALL-FOR-AGENTS.md) explains, including the
steps that belong to the owner (accepting a model's license).

## A key for the panel

Omarchy plugins can't add key bindings, so add one yourself in `~/.config/hypr/bindings.lua`:

```lua
o.bind("SUPER + ALT + H", "Hildegard", "qs ipc -p \"$OMARCHY_PATH/shell\" call io.github.baney75.hildegard toggle")
```

## What it needs

- Omarchy 4 (Quattro) and its `omarchy-shell` bar. The widget uses Omarchy's own `omarchy-launch-tui`,
  `omarchy-launch-browser` and `omarchy-notification-send`.
- `bash`, `curl`, `jq`, `flock` and `sha256sum`, all part of Omarchy.
- An NVIDIA or AMD GPU for real renders (Hildegard also runs on the CPU, slowly), and about 30 GB free: 8 GB for ComfyUI
  and PyTorch, the rest for the first model.
- Network access to `github.com` (Hildegard), `nodejs.org` (Node.js), `download.pytorch.org` and `pypi.org` (PyTorch
  and ComfyUI), and `huggingface.co` (models). Only during Set up and updates.

The widget itself only talks to Hildegard on `127.0.0.1`. It runs no root commands, installs no services, and changes
none of your config. Hildegard listens on port 7341; the widget follows it to another port on its own.

## Update

Hildegard updates itself, and the panel's **Update to** button does it at once. To update the widget:

```sh
omarchy plugin update io.github.baney75.hildegard
```

## Remove

```sh
omarchy plugin remove io.github.baney75.hildegard
rm -rf ~/.local/state/hildegard-omarchy
```

That removes the widget only. To remove Hildegard too, run `hildegard stop`, then delete `~/.local/share/hildegard` and
`~/.local/bin/hildegard`.

## Develop

This plugin is built from the [`omarchy/` folder of Hildegard](https://github.com/baney75/hildegard/tree/main/omarchy)
with each release, which adds that release's installer; send changes there.

- `Widget.qml` draws the ring and the panel; `Model.js` decides what they show, as plain functions.
- `bin/hildegard-omarchy` is the backend: `snapshot | start | stop | update | open [route] | setup | notify`.
- `bin/hildegard-omarchy-setup` is what **Set up** runs in a terminal.

From the Hildegard repo root: `node --test omarchy/test/*.test.mjs` runs the tests (the backend ones start a real
Hildegard server on a stand-in GPU), `node scripts/check-omarchy.mjs` checks the plugin against the marketplace's
rules, and `node scripts/scan-omarchy.mjs <marketplace checkout>` runs the marketplace's own security baseline on it.
`node scripts/build-omarchy.mjs dist/release` builds this repo's contents from a release you built. Logs:
`qs log -p "$OMARCHY_PATH/shell" --tail 100`. Lint: `qmllint -I "$OMARCHY_PATH/shell" Widget.qml`.

To try a change, copy the built plugin in (Omarchy wants a copy, not a symlink):

```sh
cp -r dist/release/omarchy-hildegard ~/.config/omarchy/plugins/io.github.baney75.hildegard
omarchy-shell shell rescanPlugins
omarchy plugin enable io.github.baney75.hildegard
```

## License

AGPL-3.0-only, like Hildegard. See [LICENSE](LICENSE).
