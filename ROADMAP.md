# Roadmap

What Hildegard is building next, and in what order. Section 1 says what must be true before each step counts as done.
The other sections are shorter: where things stand, and what comes next.

## 1. Skill suggestions that can't be turned into an attack

Agents already suggest skill changes, for every model or for their own (`report_draft` kind `skill`,
[docs/skill-suggestions.md](docs/skill-suggestions.md)). A skill is instructions an agent follows on someone's own
computer, so a suggested change is code, and a hostile one is an attack on everyone who updates. Security comes
before anything else here.

In place now:

- the draft is scanned on the agent's own computer (`mcp/src/skill-scan.ts`), and a block finding stops it unwritten;
- the person sees the exact text and files it only on their yes, as a GitHub issue under their own account;
- an issue is only data: no bot, workflow or Hildegard ever turns one into a change;
- a maintainer writes any change in their own words; CI scans every skill file (`scripts/check-skills.mjs`), and
  `CODEOWNERS` puts `skills/`, the scan and `SCAN-ALLOW` under the owner's review;
- app and server installs update only to a release signed with minisign, checked against the key built into them.
  The Claude Code plugin is the exception: it installs from `main`, which takes only reviewed, green pull requests,
  but nothing checks a signature, so a change merged to `main` reaches plugin users before any release;
- notes for one model family live in `skills/<skill>/models/` (`claude.md`, `claude-opus.md`, `qwen.md`), and
  `read_skill` with `model` adds only the ones that match.

Next, in order:

1. **Try a change before anyone reads it as good.** When a maintainer opens a pull request that changes a skill, they
   can run it against fixed prompts in a sandbox with a throwaway folder and no keys of the owner's. A change to the
   shared skill text runs on a local model with no network at all. A change to one family's notes
   (`models/claude-opus.md`) runs on that family's model, through a proxy that lets through only that model's
   endpoint. The key lives only in the proxy, which adds it to outbound requests and caps spending; nothing inside the
   sandbox can read it. Only a maintainer's pull request runs, never the text of an issue. The offline run is a smoke
   test: passing it is not evidence that the change is safe on every model family. The before and after go in the pull request, so the
   owner judges results as well as words. Done when a change that tries to reach the network or a key fails in the
   sandbox and says so, and the before and after transcripts for the fixed prompts are attached to the pull request.
2. **A second reviewer for intent.** A model in CI reads skill diffs for what the patterns miss, such as a step that
   quietly widens what an agent may touch. The diff is hostile input to that model too. It runs on pull requests from
   this repository's own branches, and on a fork's only after a maintainer adds a label. Its key lives only in a
   separate job that receives the diff as a file, with no checkout, no write token and no other secrets. Another job
   with a comment-only token posts the report in a fenced plain-text block, with links and HTML stripped and a length
   cap, and the report can never approve or merge anything. Done when it
   flags every case in a fixed hostile set, including diffs addressed to the reviewer itself, and stays quiet on at
   least 9 of 10 cases in a fixed set of ordinary skill edits.
3. **Pull the plugin from a signed release.** The Claude Code plugin should take skills from the same signed release
   as the app, not from `main`. The plugin from `main` would carry only a small loader with Hildegard's public key
   pinned in it; the loader fetches the skills from the newest signed release and checks them before any agent reads
   them. The signed bundle carries its version, and the loader refuses any bundle older than the last one it
   accepted, so an old signed release with a known-bad skill can't be replayed. If the release host can't be reached,
   the loader uses the last bundle it verified, or no skills, never anything unsigned. The loader itself still comes
   from reviewed `main`, so it is the one part trusted on install. Done when a bundle that fails the signature check,
   an older signed bundle, and an unreachable release host each leave the agent with no unsigned skills, and say why.
4. **Counts.** Suggestions per skill and per model, so the owner sees where skills fail most. Anyone can file an
   issue and name any skill or model, so the counts are advisory: they count distinct accounts, and a count never
   changes a skill by itself. Done when the counts appear in the release checklist with distinct-account totals,
   counted only against the known skill and model names, with anything else in one "other" bucket that echoes none of
   the filed text.
5. **Provenance for every skill file.** The signed release lists a hash for each skill file. Done when `read_skill`
   and Hildegard's installer report and refuse a hand-edited skill file, and the docs say that an agent reading a
   skill folder directly is outside what Hildegard can check.

## 2. Every device, every GPU

- **NVIDIA DGX Spark** (GB10, unified memory), in review in #37: Hildegard will count the GB10's shared memory and
  fit models against it. Next: a render on real Spark hardware in the release checks, and two Sparks paired over
  ConnectX.
- **Choir, opportunistic or not**, in review in #39. Off, renders from your other devices will take their turn. On,
  they will yield to the computer's own work and wait while it's busy. Next: notice other programs starting on the
  GPU during a guest render, quiet hours, and changing the mode from another device.
- **AMD on Windows**, which today renders on the CPU.
- **Link**, an encrypted relay that would pair devices without Tailscale. Not built yet; devices pair over
  Tailscale today.

## 3. Making things

- **OpenSCAD in model loops** (#34): source in, measured parts out. Not merged yet: it waits until the renderer runs
  in a filesystem sandbox on macOS and Linux. When it ships, a computer without a sandbox (Windows today) will render
  only the files a round carries and refuse library includes. Next: bundle OpenSCAD and
  BOSL2 with the app, so no one has to install them first.
- **Products from print to page.** Parts to print (after print3d), then the product's page, with the same rounds of
  measuring and review. Next: a side-by-side check of Hildegard's web loop against pen.dev on the same briefs, with
  the scores published, before anyone calls it better.

## 4. Every agent, within its terms

Hildegard links into Claude Code, Codex, OMP, Pi, Gemini CLI, OpenCode and others over MCP and skills, and runs
coding agents only on terms their makers allow ([docs/agent-terms.md](docs/agent-terms.md)). Next: run video edits
end to end through each linked agent in CI, and record which agents can do each kind of work.

## 5. Updates

Any device updates the others (`hildegard update all`). The app and server update only to a signed release (the
Claude Code plugin still installs from `main`; see section 1, step 3), and since 0.1.10 a failed update rolls back to
the version it replaced. Next: staged rollouts, where one device takes a release first and the
rest follow once it renders.
