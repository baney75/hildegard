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
- the app and server take skills only inside a release signed with minisign, checked against the key built into
  Hildegard. The Claude Code plugin is the exception: it installs from `main`, which takes only reviewed, green pull
  requests, but no signature;
- notes for one model family live in `skills/<skill>/models/` (`claude.md`, `claude-opus.md`, `qwen.md`), and
  `read_skill` with `model` adds only the ones that match.

Next, in order:

1. **Try a change before anyone reads it as good.** When a maintainer opens a pull request that changes a skill, they
   can run it against fixed prompts in a sandbox: no network, no keys, a throwaway folder. Only a maintainer's pull
   request runs, never the text of an issue. The before and after go in the pull request, so the owner judges results
   as well as words. Done when a change that tries to reach the network or a key fails in the sandbox and says so.
2. **A second reviewer for intent.** A model in CI reads skill diffs for what the patterns miss, such as a step that
   quietly widens what an agent may touch. The diff is hostile input to that model too, so it runs with no secrets
   and no write token, sees the diff only as data, and its report can never approve or merge anything. Done when it
   flags every case in a fixed hostile set, including diffs addressed to the reviewer itself, and stays quiet on at
   least 9 of 10 cases in a fixed set of ordinary skill edits.
3. **Pull the plugin from a signed release.** The Claude Code plugin should take skills from the same signed release
   as the app, not from `main`. Done when a plugin install refuses skills that don't match a signed release.
4. **Counts.** Suggestions per skill and per model, so the owner sees where skills fail most. Anyone can file an
   issue and name any skill or model, so the counts are advisory: they count distinct accounts, and a count never
   changes a skill by itself. Done when the counts appear in the release checklist with distinct-account totals.
5. **Provenance for every skill file.** The signed release lists a hash for each skill file. Done when `read_skill`
   and Hildegard's installer report and refuse a hand-edited skill file. An agent that reads a skill folder directly
   is outside what Hildegard can check, and the docs say so.

## 2. Every device, every GPU

- **NVIDIA DGX Spark** (GB10, unified memory) is detected with its shared memory, and models fit against it
  (#37). Next: a render on real Spark hardware in the release checks, and two Sparks paired over ConnectX.
- **Choir, opportunistic or not** (#39). Off, renders from your other devices take their turn. On, they yield to the
  computer's own work and wait while it's busy. Next: notice other programs starting on the GPU during a guest
  render (today only Hildegard's own work stops one), quiet hours, and changing the mode from another device.
- **AMD on Windows**, which today renders on the CPU.
- **Link**, the encrypted relay that pairs devices without Tailscale.

## 3. Making things

- **OpenSCAD in model loops** (#34): source in, measured parts out. It is held until the renderer runs in a
  filesystem sandbox on macOS and Linux, and refuses library includes where there is none. Next: bundle OpenSCAD and
  BOSL2 with the app, so no one has to install them first.
- **Products from print to page.** Parts to print (after print3d), then the product's page, with the same rounds of
  measuring and review. Next: a side-by-side check of Hildegard's web loop against pen.dev on the same briefs, with
  the scores published, before anyone calls it better.

## 4. Every agent, within its terms

Hildegard links into Claude Code, Codex, OMP, Pi, Gemini CLI, OpenCode and others over MCP and skills, and runs
coding agents only on terms their makers allow ([docs/agent-terms.md](docs/agent-terms.md)). Next: run video edits
end to end through each linked agent in CI, and record which agents can do each kind of work.

## 5. Updates

Any device updates the others (`hildegard update all`). Installs update only to a signed release, and a failed update
rolls back to the version it replaced (0.1.10). Next: staged rollouts, where one device takes a release first and the
rest follow once it renders.
