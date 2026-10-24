# Rented GPUs

The owner's own computers come first. When they have no GPU, or need a bigger one for a while, `hildegard cloud`
rents one. Agents follow the **hildegard-cloud** skill (`skills/hildegard-cloud/SKILL.md`).

## Runpod

```sh
printf %s "$RUNPOD_API_KEY" | hildegard cloud runpod key --key-stdin --json
hildegard cloud runpod up --model wan-2-2-ti2v-5b --accept-license wan-2-2-ti2v-5b --json
hildegard cloud runpod status --json
hildegard cloud runpod down [--delete] --json
```

How it works:

1. `up` makes a 32-byte pairing key on this computer and keeps it in the keychain, then creates a pod through
   Runpod's REST API with the owner's key: Ubuntu 24.04 pinned by digest, secure cloud and on demand unless the owner
   asks otherwise, a 100 GB volume, port 7341 behind Runpod's HTTPS proxy. The pod's environment carries
   `deploy/runpod/boot.sh` (base64), the version, the pairing key, the model, and the license acceptance only when the
   owner named that model.
2. On the pod, `boot.sh` installs that exact Hildegard release with `install.sh` (which checks every download's
   SHA-256), installs the model, and turns on sharing with the pairing key (`choir invite --key-stdin`). The key never
   reaches the log or a command line.
3. This computer builds the join code itself from the key it made, so nothing secret comes back from the pod, and
   joins as soon as the pod answers (the first start takes 10 to 30 minutes), then renders there.
4. The pod watches its own queue and stops itself after 30 idle minutes, with the API key Runpod gives each pod.

Security: on the pod Hildegard listens on all interfaces but only accepts the proxy's host name, and requests through
the proxy are never "this computer", so everything except `/api/node/*` (behind the pairing key) needs a sign-in, and
no account exists there.

Privacy: prompts, start frames and videos pass through Runpod's proxy and a GPU Runpod runs. Community cloud
(`--community`) is other people's machines.

## Hugging Face Jobs and Colab

Designed, not built yet. Both will be batches: pack a film's shots, render them remotely with the same release, and
import the takes. Colab's terms rule out joining a fleet, so it will only ever be a notebook the owner runs.
