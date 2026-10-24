---
name: hildegard-cloud
description: Rent a GPU for Hildegard on Runpod with one command - it joins the owner's fleet, renders their takes and stops itself when idle. Use when the owner has no GPU or needs a bigger one, or asks about Runpod, Hugging Face or Colab for rendering.
---

# Rented GPUs for Hildegard

Your user's own computers come first. Rent a GPU when they have none, or need a bigger one for a while. Everything is
billed to their own Runpod account by the second; tell them that before you start a pod.

Every command takes `--json` and prints `{ ok, needsOwner, steps[], message }`. Rerunning is safe.

## Runpod: a GPU that joins the fleet

1. **Their API key.** Ask your user to make one at https://console.runpod.io/user/settings (API Keys, read and write)
   and give it to you. Pipe it in; it goes to the system keychain:

   ```sh
   printf %s "$RUNPOD_API_KEY" | hildegard cloud runpod key --key-stdin --json
   ```

   Never put the key on a command line, in a file or in a log.

2. **The model's license.** The first `up` returns a `needs-owner` step with the license:

   ```sh
   hildegard cloud runpod up --model wan-2-2-ti2v-5b --json
   ```

   Show `detail` to your user word for word. Only on a clear yes, run the step's `command` (it adds
   `--accept-license wan-2-2-ti2v-5b`). Wan 2.2 needs no Hugging Face account. LTX models are gated: they also need
   `--send-hf-token`, which puts your user's Hugging Face token in the pod's environment (their Runpod account can
   see it). Ask before adding it.

3. **Wait.** `up` rents the GPU (secure cloud, on demand), the pod installs Hildegard's signed release and the model,
   and this computer joins it and renders there. The first start takes 10 to 30 minutes. If `up` returns
   `needs-owner` with "still setting up", run the same command again later: it picks up where it left off.

4. **Check.** `hildegard cloud runpod status --json` shows `pod.status`, `pod.costPerHr` and `device.online`.
   `hildegard choir list --json` shows the pod as a device, and `choir.use` names it.

5. **Stop.** The pod stops itself after 30 idle minutes (`--idle-minutes <n>` on the first `up`; 0 never).
   `hildegard cloud runpod down --json` stops it now and keeps its disk for a fast start (a little storage cost);
   `--delete` removes it and its disk. `up` starts a stopped pod again.

Options for the first `up`: `--gpu "<Runpod GPU id>"`, `--disk <GB>` (default 100), `--volume <network volume id>`,
`--spot` (cheaper, Runpod may take it back mid-render), `--community` (other people's machines: cheaper and less
private; ask your user first).

### What to tell your user

- Prompts, start frames and videos travel through Runpod's HTTPS proxy to a GPU Runpod runs. That's less private than
  their own computers.
- Outside the pod, only the paired-device API answers, behind a key made on this computer; there is no account to
  sign in to.
- It costs money while running. Say the hourly price from `status` before long renders.

## Hugging Face Jobs and Colab

Not built yet: `hildegard cloud --json` lists them as coming next. Colab's terms forbid remote proxies, web services
and (on free runtimes) remote UIs and distributed workers, so Hildegard will never join Colab to a fleet; it will only
ever be a notebook your user runs themselves. Don't work around this with tunnels.
