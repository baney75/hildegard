---
name: hildegard-site-and-seo
description: Where the dbaney.com/hildegard page lives and how it deploys; SEO/ASO copy source; 2026-10-26 site rebuild (PR #25)
metadata:
  type: project
---

- Source of the page: baney75/hildegard `site/` (tests: `pnpm --filter @hildegard/studio e2e:site`). It is COPIED by hand into baney75/dbaney.com `hildegard/` (also list every file in dbaney.com `public-files.json`), then pushed to dbaney.com main, which Cloudflare deploys. Keep `hildegard/oauth/hf-client.json` there (HF sign-in).
- dbaney.com rules: `npm test` needs a fresh share video per changed page: `CHROME=<wrapper running playwright chromium with --no-sandbox> npm run og:video` works in the cloud container. Front page shows exactly six `featured: true` projects.
- 2026-10-26 rebuild (PR #25 + dbaney.com 89f8ecc): headline "Your own AI studio, on your own GPU", rooms (Film/Voice/Characters ready, 3D/Websites with your AI app, Music coming), hero reel + gallery clips cut from ~/Projects/hildegard-demos/films on rectory1 (site/video/), Why-own-it table, FAQ + JSON-LD. Hildegard added to dbaney.com Projects (content/work/hildegard.md, docs); Graze un-featured to keep six.
- Listing/ASO/search-term copy: baney75/hildegard `brand/listing.md`. Store metadata must not name competitors; the website may.
- GitHub About, topics, social preview (brand/social-preview.jpg) can't be set from the cloud session; needs Donovan's `gh repo edit` (topics/description) and Settings upload (preview).

- Link preview: owned by the site/SEO thread (PR #27, og.jpg?v=2, twitter:site tags). Keep one card. On X the domain label covers the card's bottom-left corner, so keep text out of it; bump the ?v= when the card changes so X refetches.

Related: [[hildegard-roadmap]]
