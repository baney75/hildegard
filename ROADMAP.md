# Roadmap

What Hildegard is building next, and in what order. Done work moves to the release notes. Each line names what must
be true before it counts as done.

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
- skills reach installs only inside a release signed with minisign, checked against the key built into Hildegard.

Next, in order:

1. **Try a suggestion before anyone reads it as good.** Run the changed skill against fixed prompts in a sandbox (no
   network, no keys, a throwaway folder). The before and after go in the pull request, so the owner judges results
   as well as words. Done when a suggestion that tries to reach the network or a key fails in the sandbox and says so.
2. **A second reviewer for intent.** A model-based reviewer in CI reads skill diffs for what the patterns miss, such as
   a step that quietly widens what an agent may touch. It is advisory only and can never approve. Done when it flags
   every case in a fixed set of hostile examples.
3. **Per-model notes, kept apart.** Model-specific advice lives in `skills/<skill>/models/<family>.md`, read only by
   that model, so one model's workaround never changes what another model is told. Done when `read_skill` serves
   them and the scan covers them.
4. **Counts.** Suggestions per skill and per model, so the owner sees where skills fail most and fixes those first.
5. **Provenance for every skill file.** The signed release lists a hash for each skill file, and an install refuses a
   skill whose hash isn't in its release. Done when a hand-edited skill file in an install is reported, not loaded.

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
