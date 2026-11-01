---
name: hildegard-mcp-linking
description: How Hildegard's MCP reaches cloud chatbots (ChatGPT, claude.ai): public-link recommendation and Cloudflare cost findings, 2026-10-18
metadata:
  type: project
  modified: 2026-10-18T04:04:46.795Z
---
**2026-10-19 change: Tailscale (Funnel) is the shipping public link; Hildegard Link is optional and shown as 'coming soon'.** Research 2026-10-18 in /mnt/project-files/architecture/mcp-public-link.md (Hildegard Link plan APPROVED by Donovan 2026-10-18; foundation doc not yet updated, change list is in section 7 of that file).
- Cloud chatbots need a public HTTPS URL; local clients (Claude Desktop/Code, Cursor, VS Code, LM Studio) use stdio and need none.
- Recommended: free, off-by-default public link. Default from MVP = "Hildegard Link", our open-source TLS-passthrough (SNI) relay, no account, est. $10-50/mo, domain on Public Suffix List. Fallbacks: embedded Tailscale Funnel (needs Tailscale sign-in), BYO Cloudflare.
- Donovan 2026-10-18: as few clicks as possible AND agents must be able to set Hildegard up end to end for the owner. So every setup step = CLI with --json + MCP tool; only public link, chatbot OAuth consent, spend, and gallery access wait for one owner tap on a paired device (doc section 6a).
- Rejected: T3 Connect model (per-user Cloudflare tunnels on our domain): free to 1,000 tunnels then $4.50/tunnel/mo (~$40.5k/mo at 10k users), Cloudflare decrypts, video ToS risk.
- Auth: daemon is its own OAuth AS (pre-registered > CIMD > DCR, iss check), consent approved on a paired device, per-chatbot agent grants. Target MCP spec 2026-07-28. ChatGPT custom MCP needs Plus+; Claude Free allows 1 custom connector.
- Sustainability (proposed 2026-10-18, doc section 4a): previews through the link and originals over iroh, a 10 GB/mo fair-use cap, self-host and community relays, sponsorships; a ~$3/mo Supporter tier only if hosting goes above ~$100/mo.
- Pricing proposal 2026-10-18 (doc section 4b): free Link 2 GB/mo previews; Link Plus $24/yr or $3/mo via merchant of record (Paddle/Lemon Squeezy); published split ($1.70 fees, $4 infra, $11.10 maintenance, $7.20 profit), 30% profit cap with quarterly public ledger; Tailscale Funnel as the free alternative. Awaiting Donovan.
- BUILT 2026-10-24 (PR #3, merged): /mcp Streamable HTTP; remote needs bearer: keys (`hildegard host key`, `connect <app> --remote <link>` keeps key in keychain) or OAuth 2.1 (DCR+CIMD, PKCE, resource-bound, refresh rotation) for claude.ai/ChatGPT. Local models: `hildegard llm` finds Ollama/LM Studio/llama.cpp/vLLM/MLX/0xSero gateway, `llm direct` lets one direct a film, shared as /v1 to owner keys. packages/link = relay prototype (SNI passthrough, PROXY line, token-held names), not yet wired into server.
- Funding plan 2026-10-24: /mnt/project-files/architecture/link-funding-plan.md. Fixed cost ~$1,200/yr. Best fits: NLnet (deadline 2026-11-03, Donovan must write it himself, NLnet rejects AI-written proposals), Cloudflare Project Alexandria (requires non-profit operation, conflicts with Link Plus), Cloudflare Community Engineers (Hono-orbit projects, not open yet), Fastly Fast Forward (site/downloads). Fallback: Link Plus $24/yr.
Related: [[hildegard-architecture]]
