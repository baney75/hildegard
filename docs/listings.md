# Listing Hildegard in AI app stores

Everything here is prepared so that the owner only presses submit. Nothing is submitted, no repository is created and
nobody is messaged until the owner does it. Build the packages and the paste-ready fields with:

```sh
node scripts/pack-listing.mjs dist/listing      # the Claude plugin tree, and dist/listing-extras/ beside it
node scripts/check-listing.mjs dist/listing dist/listing-extras/hildegard-openai.zip
```

`dist/listing-extras/` holds `hildegard-openai.zip`, `grok-bot/` (the skill zips) and `listing-fields.md` (every field
below, filled in and ready to paste). CI builds and checks all of it on every change to skills, manifests or these
scripts (`.github/workflows/listing.yml`). Only the `publish` job, on a push to `main`, ever sees the deploy key
(`apps/cli/test/listing-workflow.test.ts` holds the workflow to that), and `pack-listing.mjs` writes only into a
new or empty folder, or one it marked itself (`.hildegard-listing-generated`), and inside the repository only under
`dist/`.

## Before any submission: approve the legal pages

Every store asks for a privacy policy and terms of service URL. Both are **drafts** until the owner approves them.

- Pages: `site/privacy/index.html` and `site/terms/index.html`, to be served at
  `https://dbaney.com/hildegard/privacy/` and `https://dbaney.com/hildegard/terms/`. Each wears a visible DRAFT banner.
- The privacy page lists every outside place the app can connect to, read from the code (update checks, installs,
  Hugging Face model downloads, Tailscale, Cloudflare, Runpod, Figma, page imports, language-model addresses, bug-report
  search). Check it against what you know.
- Fill the `[Owner: …]` lines: contact email, the approval date, who hosts dbaney.com and how long it keeps logs, and the
  paragraph on governing law (have a lawyer read it if you want one).
- To publish: delete the `<p class="draft">` line in each page, remove `<meta name="robots" content="noindex">`, add
  "Privacy" and "Terms" links to the footer of `site/index.html`, and deploy `site/`. Until then the URLs return nothing
  or a draft, and the stores' validators will accept them but a reviewer reading them would not. Don't submit before.
- `listing-fields.md` and the manifests carry these two URLs; if the site lives elsewhere, change `URLS` at the top of
  `scripts/pack-listing.mjs`.

## 1. Anthropic: Claude directory (skills only)

| | |
| --- | --- |
| Where | https://claude.ai/directory/manage, then the **Plugin bundle** option |
| Account | A **paid** Claude account (the portal won't take a free one) |
| Source | The public GitHub repository `baney75/hildegard-plugin`, which the portal validates |
| Package | The tree from `scripts/pack-listing.mjs`, published there by CI |
| Plugin name | `hildegard-craft` |

**Before pressing submit**

1. Create the public repository `baney75/hildegard-plugin` (empty, no `.gitattributes`, no LFS), and a deploy key:
   `ssh-keygen -t ed25519 -f hildegard-plugin-deploy -N ""`, add the public half to that repository's Settings ›
   Deploy keys with **write access**, and save the private half as the secret `LISTING_DEPLOY_KEY` in the
   environment `listing` on `baney75/hildegard` (Settings › Environments › listing › Environment secrets; the first
   run creates the environment). An environment secret never reaches a pull request, and you can add yourself as a
   required reviewer there to approve each publish. The workflow does nothing without the key.
2. Merge, let the `Listing` workflow run on `main`, and open the repository: it should hold `.claude-plugin/`,
   `skills/`, `README.md`, `LICENSE`, `LICENSE-APACHE` and `THIRD_PARTY_NOTICES.md`, and nothing else.
3. Optional local check: `claude plugin validate <tree>` (it passes on the generated tree).
4. Approve and publish the legal pages (above).
5. Paste the fields from `listing-fields.md` (name, description, URLs). Submit.

**What the validator checks, and where we stand** (all enforced by `scripts/check-listing.mjs`):

| Rule | State |
| --- | --- |
| Fewer than 512 files, none over 256 KiB, no binary but the icon | 83 files, the largest 43 KB; the icon is 24 KB |
| No root `.gitattributes` with filter rules (`docs/promo/**/*.mp4 filter=lfs` in this repo breaks validation) | The listing repository is built from the tree, not from this repository, so it has no `.gitattributes` |
| `privacyPolicyUrl`, `termsOfServiceUrl` (https), a LICENSE, a README of 40 or more words | Yes (the README is about 575) |
| Policy section 4B excludes software that makes images, video or audio with AI models | Skills only, no MCP server, and the five skills about making media or running the app (`hildegard-film`, `-art`, `-sound`, `-cloud`, `-setup`) are left out |

**Name.** `hildegard-craft`, not `hildegard`: the directory listing is a different, smaller product, and the full plugin
(with its MCP server) keeps the name `hildegard` for the day Anthropic grants the exception below. Cost: its skill
names read `hildegard-craft:hildegard`, `hildegard-craft:hildegard-craft`. Change `CLAUDE.name` in
`scripts/pack-listing.mjs` to rename.

**Risks a reviewer may raise** (decide before you submit; change `CLAUDE.skills` in the script to adjust):

- The `hildegard` skill is the method for all creative work, so its text still mentions songs, music videos and the
  tools of the app. The listing frames and ships it as craft, but a strict 4B reading could object. If it does, drop
  `hildegard` from `CLAUDE.skills` and resubmit with the rest.
- Some skills tell Claude to use Hildegard's tools (`review_take`, `direct_shot`), which aren't in this plugin. The
  README says the skills work alone.

### Draft letter to Anthropic: an exception to policy 4B for the full plugin

DRAFT for the owner to read, change and send himself. It is not sent. Find the right address on the directory's policy
page or in the portal's contact link.

> Subject: Request for a written exception to section 4B for the Hildegard plugin
>
> Hello,
>
> I'm Donovan Baney, the author of Hildegard (https://dbaney.com/hildegard/), an open-source creative studio. I'm
> asking for a written exception to section 4B of the plugin directory policy, so the full Hildegard plugin can be
> listed. I've already submitted a skills-only version, `hildegard-craft`, which fits the policy.
>
> Hildegard is software that a person runs on their own computers. It is licensed AGPL-3.0-only and the source is at
> https://github.com/baney75/hildegard. The full plugin adds an MCP server that starts the Hildegard the person has
> installed on their own machine. It talks to nothing of mine: I run no servers for it, collect no data, and it has no
> telemetry. The models are open-weight models that the person downloads from their publisher and runs on their own
> GPU, under each model's license, which Hildegard shows and asks them to accept. Nothing is made on Anthropic's
> platform, on mine, or on anyone's cloud unless the person chooses to rent a GPU themselves.
>
> It was built with limits that I think fit the directory's purpose:
>
> - **No sexual content.** Prompts, models and every frame are checked, and Hildegard refuses it at each layer. A change
>   that adds a new way in must add the same checks and a test that a sexual input is refused (docs/safety.md).
> - **Voices are cloned only with a living person's consent.** A voice is cloned only after the speaker reads a fresh
>   line aloud and is heard by a checker. Every clip is watermarked, and an agent cannot start a clone over MCP.
> - **The person owns the work and the machine.** Sign-in for anyone else is the person's own passphrase on their own
>   link, and they can revoke any app, key or device at any time.
> - **Craft over volume.** Its skills teach a maker's method: interview, research, draft, critique against a rubric,
>   refine until it passes, which is the opposite of one-click slop.
>
> I'd like to list the full plugin under the name `hildegard`. If a narrower form would work, for example the MCP server
> limited to editing and 3D tools, I'm glad to hear what would fit. Could you tell me in writing whether an exception is
> possible and what you'd need from me?
>
> Thank you,
> Donovan Baney
> [Owner: contact email]

## 2. OpenAI: Codex and ChatGPT plugin directory

| | |
| --- | --- |
| Where | https://platform.openai.com/plugins, then **Upload plugin** (the page `developers.openai.com/plugins/deploy/submission` describes the fields) |
| Account | A **verified OpenAI developer account** (organization verification) |
| File | `hildegard-openai.zip` |

The zip is `.codex-plugin/plugin.json`, the icon, every skill, a README, the LICENSE, the Apache license for the site templates (`LICENSE-APACHE`) and notices. It has no MCP server and
no hooks, which the directory refuses. `scripts/check-listing.mjs` checks every limit (and a test fails each one past
it): name 64, displayName 30 (`Hildegard`), shortDescription 30 (29), longDescription 4,000, capabilities 20 of 120,
defaultPrompt 3 of 128, a square PNG logo under 5 MiB, a brand color with 2:1 contrast on white (`#133A24` has 12.7:1),
and the four required URLs: `websiteURL`, `supportURL`, `privacyPolicyURL`, `termsOfServiceURL`.

Two things are unconfirmed, because OpenAI's page can't be read from here: the URLs sit under `interface` in the
manifest (where Codex's own spec puts `privacyPolicyURL` and `termsOfServiceURL`), and `supportURL` is not in every
version of that spec. If the upload form complains, move them to the top level of the manifest. A skills-only public
submission may also be refused for lack of an app or connector; the release's `hildegard-codex.zip` stays installable
from the repository either way (`codex plugin marketplace add baney75/hildegard`).

## 3. xAI Grok

There is no store. Each person adds Hildegard as a custom connector (grok.com › Connectors › New Connector › Custom).
The guide is [grok.md](grok.md), including which parts of Hildegard's OAuth sign-in need a live test with Grok. The owner
should try it once from his own Grok account before telling anyone it works.

## 4. Grok Bot

The owner's own platform. [grok-bot.md](grok-bot.md): the custom MCP server (no files) and the private skill bundle
(`dist/listing-extras/grok-bot/hildegard-skills.zip`, per-skill zips and `SHA256SUMS`).

## Not covered here

Claude Code users install from this repository directly (`/plugin marketplace add baney75/hildegard`), the Claude
app and Cowork take `hildegard.plugin`, and claude.ai takes `skill-*.zip` uploads or a custom connector
([chatbots.md](chatbots.md)). Those need no store.
