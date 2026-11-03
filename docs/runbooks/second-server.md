# A second Talk server

How to bring up a second serving device for remote Talk, next to the owner's GPU desktop, and prove one turn runs
there. The example is abbey1, a WSL server on the tailnet with no NVIDIA GPU. The policy is in
[talk-caps.md](../architecture/talk-caps.md#policy): the microphone and speaker stay on the primary, Funnel stays off,
and no consent recording, voice sample or cloned voice leaves the primary.

On a server with its own release install, one command does sections 2 and 3, and starts Hildegard from a user
systemd unit (a LaunchAgent on macOS):

```sh
curl -fsSL https://github.com/baney75/hildegard/releases/latest/download/install.sh | sh -s -- --server
hildegard doctor            # service, voice, llm and sharing are done, or each says its fix
hildegard choir invite --long --json
```

Then go on at [section 4](#4-pair-it) with `hildegard choir invite --long --json` in place of the `curl`, and
`loginctl enable-linger $USER` if it should keep serving after you sign out (the installer asks; it's the owner's
choice). The rest of this page runs the server from a source checkout with its own data folder, beside an install
that's already there.

## 1. Before you start

- The server is on the tailnet (`tailscale status` lists it) and so is the primary.
- Node 22.18 or newer. pnpm comes through `npx`, pinned to the repository's version.
- Find out what else runs there before you pick a port: `ss -ltn`. Leave other stacks alone. Don't stop their
  containers, change their bind mounts, or reuse their data folders.

## 2. Install beside what's there

Use a folder of its own, so an existing Hildegard install and its data stay as they are:

```sh
# on the primary, from a checkout of the branch you want to run
git archive --format=tar HEAD | ssh abbey1 '
  d=~/.local/share/hildegard-abbey1-talk
  mkdir -p $d/src $d/data && tar -x -C $d/src && cd $d/src &&
  npx -y pnpm@10.28.0 install --frozen-lockfile --filter @hildegard/server...'
```

To update it, run the same command again.

## 3. Start it

With no NVIDIA GPU, use the stand-in GPU. It advertises stand-in Whisper, Kokoro and a stub language model, so the
Talk routes answer without Python or downloads. On a server with a GPU and the voice engine installed, leave
`--fake-gpu` off.

```sh
ssh abbey1 '
  d=~/.local/share/hildegard-abbey1-talk; cd $d/src
  HILDEGARD_SECRETS=file setsid nohup node apps/server/src/main.ts --fake-gpu --data $d/data --port 47341 \
    > $d/server.log 2>&1 < /dev/null & echo $! > $d/server.pid'
ssh abbey1 'curl -s -H "x-hildegard: 1" http://127.0.0.1:47341/api/talk'
```

`/api/talk` should say `"ready": true` and list `stt`, `tts` and `llm` under `capabilities`. The server listens on
loopback only.

## 4. Pair it

On the server, make a long join code. The server then also listens on its own Tailscale address, for `/api/node/*`
only. The code holds a key: write it to a file only you can read, and never paste it into a log or a chat.

```sh
ssh abbey1 '
  d=~/.local/share/hildegard-abbey1-talk; umask 077
  curl -s -X POST -H "x-hildegard: 1" -H "content-type: application/json" -d "{\"long\": true}" \
    http://127.0.0.1:47341/api/choir/invite > $d/invite.json'
```

`invite.json` has `code` (the long `hgc1_` code) and `url`. Keep `code` in its own 0600 file (`$d/code`) and
delete `invite.json`. Without `"long": true` the invite gives only a short `HG-XXXX-XXXX` code under `short` and
`code` is `null`, so there is nothing to keep.

On an installed Hildegard the same step is `hildegard choir invite --long --json`, and the primary joins with
`printf %s "$CODE" | hildegard choir join --code-stdin --json`.

A short code is for typing on the other device. It works once, for 10 minutes, and names no address, so the harness
needs the invite's `url` with it: set `HILDEGARD_SECOND_URL` next to `HILDEGARD_SECOND_CODE`. Given a short code
alone, the harness stops and says so.

## 5. Run one Talk turn there

The harness starts a stand-in primary on this computer, joins the server with the code, sends a recording, and
plays the answer here. The recording says an invented line, `Plan a short film about a lighthouse keeper.` A
stand-in engine hears whatever sits in `<sha256 of the recording>.wav.txt` in the server's voice uploads, so stage
that line first; a real Whisper hears the recording itself.

```sh
F=apps/server/test/fixtures/talk/lighthouse.wav
SHA=$(sha256sum $F | cut -d' ' -f1)
ssh abbey1 "mkdir -p ~/.local/share/hildegard-abbey1-talk/data/media/voice &&
  cat > ~/.local/share/hildegard-abbey1-talk/data/media/voice/$SHA.wav.txt" < $F.txt

HILDEGARD_SECOND_CODE="$(ssh abbey1 cat ~/.local/share/hildegard-abbey1-talk/code)" \
  node apps/server/scripts/talk-remote-harness.mjs | tee .runs/talk-second-server.log
```

With an address and key instead of a code, set `HILDEGARD_SECOND_URL`, `HILDEGARD_SECOND_TOKEN` and, if you like,
`HILDEGARD_SECOND_NAME`. The harness never prints the key.

## 6. Read the result

The harness writes `.runs/talk-second-server-latency.json`:

| Field | What to look for |
| --- | --- |
| `transcript` | The staged line. `heardStagedLine` is true when it matches the fixture's `.txt`. |
| `replyText` | The answer. The stub model echoes the transcript. |
| `ms` | From sending the recording to having the answer's audio here, in milliseconds. |
| `route` | `remote` for `stt`, `llm` and `tts`. Anything `local` means a step ran on the primary. |
| `sha` | The commit the harness ran from. |
| `server` | The device's name and the host the primary reached. |

The harness exits nonzero when any step ran locally. The server keeps the recording in its own
`data/media/voice`, and nothing else from the primary.

To check the refusals from the primary, call the server's Tailscale address: `/api/node/info` without a key, or
with a wrong one, answers 401, and `/api/talk` or `/api/choir` there answers 404.

## 7. Stop it

```sh
ssh abbey1 'kill $(cat ~/.local/share/hildegard-abbey1-talk/server.pid)'
```

To end the pairing for good, `POST /api/choir/revoke` on the server first, or delete its `data` folder.
