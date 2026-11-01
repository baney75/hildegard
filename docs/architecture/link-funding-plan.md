# Keeping Hildegard Link free: costs, funding and the fallback

*Written 2026-10-24. Builds on [mcp-public-link.md](mcp-public-link.md), sections 4a and 4b, which set the costs and the Link Plus price. Figures are estimates, not quotes.*

## The short answer

Hildegard Link can be free for everyone if about **$1,200 a year** is covered. That is the fixed cost of a properly redundant relay (six small servers in three regions, DNS, monitoring and a domain). Bandwidth is the only cost that grows with users, and it stays small because chatbots get previews while originals stay home: about $1.20 per TB, or roughly a cent a month for a typical user.

So the funding ask is small. Three or four of the sources below would each cover it alone.

- **Plan A: sponsored and free.** Apply now to the four sources marked "apply now". Any one that says yes funds Link for a year or more.
- **Plan B: community-funded and free.** Launch with GitHub Sponsors and Open Collective, plus a public cost page. About 100 people giving $1 a month covers the fixed cost.
- **Plan C: no sponsor.** Keep a free tier (previews, 2 GB a month) and launch Link Plus at **$24 a year** to pay for it. Break-even on hard costs is about 55 members.

In every plan, Tailscale stays the free, no-relay way in, and anyone can run their own relay with `hildegard relay serve`.

## What has to be paid for

| Item | Monthly | Notes |
|---|---|---|
| 6 relay servers (2 each in EU, US East, US West or Asia) | about $60 | Hetzner-class VPS; EU includes 20 TB traffic |
| GeoDNS and health checks | about $10 | Sends each user to the nearest healthy relay |
| Monitoring, status page, logs | about $20 | |
| Domain `hildegard.link` | about $3 | |
| Spikes and abuse cleanup | about $7 | |
| **Fixed total** | **about $100 ($1,200 a year)** | |
| Bandwidth | about $1.20 per TB | 10,000 free users at the full 2 GB cap is about 20 TB, or about $24 |

A **minimum viable launch** is cheaper: two servers in two regions, at about $25 a month ($300 a year). It has no redundancy within a region, but one region can fail over to the other.

The hidden cost is people time: abuse reports, security updates and on-call. Sponsors usually fund that more readily than servers, so ask for it explicitly.

## Who might pay, ranked by fit

| Source | What it gives | Fit for Link | Status | Next step |
|---|---|---|---|---|
| **NLnet** (NGI Zero, EU-funded) | Grants of €5,000 to €50,000 for open internet infrastructure | **Very good.** An end-to-end encrypted, self-hostable relay is exactly what NGI funds. | Restack and CodeSupply funds are open. **Next deadline: 3 November 2026, 12:00 CET.** | **Apply now.** NLnet says it does not want AI-written proposals, so Donovan should write it himself; a draft outline is below. |
| **Cloudflare Project Alexandria** | Recurring yearly credits; upgrades up to Business or Enterprise | **Medium.** The relay can't run on Workers (they would decrypt). But an Enterprise plan includes Spectrum, which can carry raw TCP on port 443 with DDoS protection in front of our relays. | Open; form on the page | **Apply now.** Catch: it asks that the project "operate solely on a non-profit basis", which conflicts with Link Plus earning a profit. Apply for the open-source project with Link free; drop Plus if accepted. |
| **Cloudflare Community Engineers** (the 2026 $1M pledge) | Grants for open-source developers | **Good.** It favours projects around Cloudflare's own open source, including **Hono**, which Hildegard's server is built on. | Applications "open at a later date" | Watch cloudflare.com/community; apply as a Hono-based project when it opens. |
| **Fastly Fast Forward** | Free or reduced-price CDN, security and edge for open source | **Medium.** Like Cloudflare, Fastly would terminate TLS, so it suits the website, docs, downloads and model mirrors rather than the relay. That still saves money elsewhere. | Open, rolling | **Apply now** for the site and downloads. |
| **GitHub Sponsors** and **Open Collective** | Recurring donations, public ledger | **Good** as a base layer, and the transparency matches the Link promise | Available any time | **Set up at launch** with a monthly cost page. Open Collective can hold funds through a fiscal host such as Open Source Collective. |
| **A single big donor** (a GPU, cloud or AI company) | Any amount | Good if it comes | — | Pitch after the challenge entry is public; one $1,200 cheque covers a year. Offer a "Link sponsored by" credit on the status page. |
| **Sovereign Tech Agency** | Large contracts for critical open infrastructure, and fellowships | **Poor for now.** It funds infrastructure many others already depend on. | Fellowship rounds open periodically | Revisit once Hildegard has real adoption. |
| **FLOSS/fund** (Zerodha) | Grants for widely used open source | **Poor for now**, for the same reason; 2025 was billed as its final tranche | Uncertain | Revisit later. |
| **Cloudflare Project Galileo** | Free protection for at-risk public-interest groups | **Doesn't fit.** It is for journalists, human-rights groups and similar. | — | Skip. |

Cheap infrastructure helps too, without any application: the Oracle Cloud free tier (ARM VMs with 10 TB a month of egress) can run one or two community relays at no cost.

## How Plan C works if nobody helps

This is already designed in mcp-public-link.md section 4b. In short:

- **Link (free):** random address, previews only, 2 GB a month, 60 requests a minute. When someone reaches the cap, the link slows down instead of breaking.
- **Link Plus, $24 a year or $3 a month:** 100 GB, full-resolution outputs, a custom name or your own domain, a choice of region, and priority on busy relays.
- **Published margin:** profit capped at 30% of Link revenue. If it goes over for two quarters in a row, everyone's limits go up or the price comes down. Backed by a quarterly public ledger.
- **Payments:** a merchant of record (Paddle or Lemon Squeezy) handles worldwide tax. Yearly billing keeps their $0.50 fee from eating small payments.

Free ways past the cap stay open in every plan:
- **Tailscale:** already shipping, with no relay at all.
- **Self-host:** run your own relay on a $5 VPS.
- **Community relays:** because traffic stays encrypted, a stranger's relay can't read it.

## Order of work

1. **This week:** draft and send the NLnet proposal before 3 November. Apply to Fast Forward and Project Alexandria.
2. **At launch:** turn on GitHub Sponsors and Open Collective, and publish the cost page.
3. **Build Link** so the free tier is cheap by design: previews by default, the per-link caps, and `hildegard relay serve` for self-hosting. A first prototype of the relay is in the repo (`packages/link`).
4. **Decide on Link Plus** once the applications come back. If Alexandria accepts us, keep Link free and drop Plus. Otherwise, switch Plus on before relay costs pass what donations cover.

## NLnet proposal outline (for Donovan to write in his own words)

- **Abstract:** Hildegard Link gives any self-hosted AI studio a public HTTPS address that chatbots such as Claude and ChatGPT can reach, with no account and without the relay ever seeing the traffic. TLS ends on the user's own computer; the relay routes by SNI alone. Anyone can run a relay, and relays are interchangeable.
- **Why it matters:** today, the easy way to expose a home service to a chatbot is a tunnel company that decrypts everything. Link makes private, user-owned AI infrastructure as easy to link as a cloud service.
- **Work and budget, about €30,000:**
  - The relay itself, hardened, with per-name caps and a takedown process
  - Automatic certificates through ACME TLS-ALPN-01 passing through the relay
  - Getting `hildegard.link` onto the Public Suffix List
  - Community relay discovery
  - A security audit, which NLnet can arrange through its partners
  - Documentation
- **Licence:** AGPL-3.0, with the relay usable by other projects.

## Sources

- [Cloudflare: Ambassadors, Community Engineers and $1M in open-source funding](https://blog.cloudflare.com/community-program-refresh/)
- [Cloudflare Project Alexandria](https://www.cloudflare.com/lp/project-alexandria)
- [NLnet: apply for funding](https://nlnet.nl/propose) and [NGI Zero Commons Fund](https://www.nlnet.nl/commonsfund)
- [Fastly Fast Forward](https://www.fastly.com/fast-forward)
- [Sovereign Tech Agency programs](https://www.sovereign.tech/programs)
- [Zerodha FLOSS/fund final tranche](https://www.opensourceforu.com/2025/10/zerodha-announces-final-675000-tranche-for-global-open-source-projects-advocates-sovereign-foss-fund/)
