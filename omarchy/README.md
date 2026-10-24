# Hildegard for Omarchy

Hildegard in your Omarchy bar. A small aperture ring sits on the right; it fills while a take renders. Click it
for a panel that shows what's rendering, the last five takes (click one to open it in the Studio), and buttons
to start or stop Hildegard, open the Studio, the queue, or the page that links your AI apps. When a take finishes
while the panel is closed, you get a notification that opens it.

The widget only talks to Hildegard on `127.0.0.1`. It runs no root commands, installs no services, and changes
none of your config. **Set up** opens a terminal that installs Hildegard for you alone, from a release whose
installer is checked against a SHA-256 pinned in [`release.env`](release.env), and asks you before it accepts
any model license or links any app.

Built for Omarchy 4 (Quattro) and its `omarchy-shell` bar.

## Install

```sh
omarchy plugin add https://github.com/baney75/omarchy-hildegard --enable
```

`--enable` asks where in the bar to put it. From a script or an agent, with no terminal to ask in, add `--yes`. Without it, enable it later with
`omarchy plugin enable io.github.baney75.hildegard`.

To install from a checkout of the Hildegard repo instead (Omarchy wants a copy, not a symlink):

```sh
cp -r omarchy ~/.config/omarchy/plugins/io.github.baney75.hildegard
omarchy-shell shell rescanPlugins
omarchy plugin enable io.github.baney75.hildegard
```

Then click the ring and choose **Set up Hildegard**, or install Hildegard yourself (see the
[main README](../README.md#install)); the widget finds the `hildegard` command on your PATH or in
`~/.local/bin`.

## A key for the panel

Omarchy plugins can't add key bindings, so add one yourself in `~/.config/hypr/bindings.lua`:

```lua
o.bind("SUPER + ALT + H", "Hildegard", "qs ipc -p \"$OMARCHY_PATH/shell\" call io.github.baney75.hildegard toggle")
```

## What it needs

`bash`, `curl`, `jq` and `flock` (all part of Omarchy), and Hildegard itself. Hildegard listens on port 7341;
set `HILDEGARD_PORT` in the shell's environment if you run it on another port.

## Remove

```sh
omarchy plugin remove io.github.baney75.hildegard
rm -rf ~/.local/state/hildegard-omarchy
```

That removes the widget only. To remove Hildegard too, run `hildegard stop`, then delete
`~/.local/share/hildegard` and `~/.local/bin/hildegard`.

## Develop

- `Widget.qml` draws the ring and the panel; `Model.js` decides what they show, as plain functions.
- `bin/hildegard-omarchy` is the backend: `snapshot | start | stop | open [route] | setup | notify`.
- `bin/hildegard-omarchy-setup` is what **Set up** runs in a terminal.

From the Hildegard repo root: `node --test omarchy/test/*.test.mjs` runs the tests (the backend ones start a real
Hildegard server on a stand-in GPU), and `node scripts/check-omarchy.mjs` checks the plugin against the
marketplace's rules. Logs: `qs log -p "$OMARCHY_PATH/shell" --tail 100`. Lint: `qmllint -I "$OMARCHY_PATH/shell"
Widget.qml`.

`node scripts/pin-omarchy.mjs dist/release` pins **Set up** to a release you just built.

## License

AGPL-3.0-only, like Hildegard. See [LICENSE](LICENSE).
