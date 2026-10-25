Hildegard's craft skills, and its loop, for the Claude app, Cowork and Claude Code.

[Hildegard](https://dbaney.com/hildegard/) is an open-source studio that runs on your own computers: image, film,
voice, music, 3D, print and web work on your own GPUs, with nothing sent anywhere else. This plugin brings its skills:

- **hildegard**: the midwife's method for serious creative work in any form, from a short interview to research,
  drafts, contact sheets, blind critique and checks.
- **hildegard-3d**: 3D models for screens and for printing, built in code and checked by Hildegard view by view.
- **hildegard-print**: working parts to 3D print, measured from a photo or a shop listing, sized from your printer's
  fits, sliced, and handed over with a print sheet.
- **hildegard-web**: websites and web app screens as real HTML and CSS, rendered at phone, tablet and desktop width in
  light and dark, and audited until they pass.
- **hildegard-loop**: generate, render, critique, refine, by hand or as a coding-agent run your user starts.
- **hildegard-film**, **hildegard-art**, **hildegard-sound**, **hildegard-photo-edit**, **hildegard-video-edit**,
  **hildegard-craft**, **hildegard-cloud** and **hildegard-setup**.

## Link your own computers

The skills work on their own. With Hildegard linked, its tools run the work on your machines:

- **Claude Code**: `/plugin marketplace add baney75/hildegard`, then `/plugin install hildegard@hildegard`. The plugin
  starts the Hildegard installed on this computer as its MCP server, and says how to install it when it isn't.
- **The Claude app**: run `hildegard connect claude-desktop` on the computer Hildegard runs on.
- **claude.ai, Cowork and the phone apps**: add a custom connector (Settings › Connectors › Add custom connector) with
  the `mcpUrl` that `hildegard host --funnel --json` prints. That puts Hildegard's sign-in page on the public
  internet, so it is your call; you sign in on it with your own name and passphrase.

Every app's steps: [docs/chatbots.md](https://github.com/baney75/hildegard/blob/main/docs/chatbots.md).

AGPL-3.0-only. Source: https://github.com/baney75/hildegard
