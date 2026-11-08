# Hildegard in Grok Bot

Grok Bot is the owner's own bot platform. It runs on its own cloud computer, so Hildegard has to be at a public HTTPS
address first (the same link Grok needs: [grok.md](grok.md), step 1 and 2). Then there are two ways to give it
Hildegard, and the first needs no files:

| | What Grok Bot gets | Files |
| --- | --- | --- |
| **A. Custom MCP server** (use this) | Hildegard's tools on your GPUs, and its skills through `list_skills` and `read_skill` | None |
| **B. Private skills** (add this if you want the craft kept in the bot) | The skills as text it can load without a connection | `hildegard-skills.zip`, or one zip per skill |

## A. The custom MCP server

1. On the computer Hildegard runs on: `hildegard tunnel tailscale --funnel` (or a Cloudflare tunnel on your own
   domain), then `hildegard host status --json` and copy `mcpUrl`.
2. Paste this into a chat with Grok Bot, with your address in place of the example:

   ```text
   Add a custom MCP server named "hildegard" at https://your-computer.your-tailnet.ts.net/mcp (Streamable HTTP, OAuth).
   I'll sign in on its page myself. Then call list_skills and read the "hildegard" skill before you make anything.
   ```

3. Open the sign-in page Grok Bot gives you and type your own name and passphrase (or a code from
   `hildegard host code`). A Grok Bot agent must never do this step.

Hildegard's MCP is stateless, so it answers Grok Bot's reused sessions and its requests without an
`MCP-Protocol-Version` header (the test `answers an app that leaves out the protocol header…` in
`apps/server/test/remote-mcp.test.ts` holds that). Revoke it any time: Settings › Sharing, or
`hildegard host keys revoke <id|name>`.

## B. The skills as a private bundle

Grok Bot's docs name no upload format for a private skill, only a folder with a `SKILL.md`. So the package is that
folder, zipped two ways. Run `node scripts/pack-listing.mjs <out>` (CI and the release do it too); the files are in
`<out>-extras/grok-bot/`:

- `hildegard-skills.zip`: all 14 skills, each as a folder at the top (`hildegard/SKILL.md`, `hildegard-3d/SKILL.md`, …).
- `<skill>.zip`: one skill each (`hildegard.zip`, `hildegard-web.zip`, …), with its folder at the top.
- `SHA256SUMS`: the checksum of each zip. The same repository files always give the same bytes.

What the owner or a Grok Bot agent does:

1. Check the zip against `SHA256SUMS` (`sha256sum -c SHA256SUMS`). Pin that snapshot, not "latest" (the bot's
   skill-stewardship rule: take skills from a named author and pin a snapshot).
2. Unzip into the bot's private skills folder, so each skill is a folder with its own `SKILL.md`. Skills that open other
   files (the `hildegard` skill reads `references/` and `scripts/`) need those folders kept beside the `SKILL.md`.
3. Read each `SKILL.md` before it can run. Hildegard's skills pass `node scripts/check-skills.mjs`, which refuses the
   shapes of an attack (a curl into a shell, a prompt to ignore other instructions, hidden text), and nothing is
   hidden in them: they are Markdown, a few Python helpers and web templates.
4. Start with the `hildegard` skill; it says which of the others to read. The skills name Hildegard's tools
   (`direct_shot`, `review_take` and so on), which exist only once A is connected.

If Grok Bot takes a single `SKILL.md` rather than a folder, give it `hildegard/SKILL.md` alone; the
rest of that skill's files then come through `read_skill` over A. Which of these Grok Bot accepts is not written down
anywhere in this repository, so try the combined zip first and fall back one step at a time.
