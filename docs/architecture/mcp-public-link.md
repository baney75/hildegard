# Hildegard in any chatbot: MCP linking, tunnels and cost

*Research for Donovan, 2026-10-18. Companion to [hildegard-technical-foundation.md](hildegard-technical-foundation.md), which this file does not edit; section 7 lists what in it should change.*

**Status:** Donovan approved the Hildegard Link plan on 2026-10-18. Section 4a covers how it stays affordable; section 4b proposes the Link Plus price.

## The answer in brief

- **Make it free.** Linking a chatbot should be free and on by one button, but off until the user turns it on.
- **Don't run Cloudflare tunnels for users the way T3 Connect does.** The first 1,000 tunnels are free, then each costs **$4.50 a month**. At 10,000 linked users that is about **$40,500 a month**, Cloudflare can read every request and every generated image, and its terms restrict serving video and large files on non-Enterprise plans.
- **Make Hildegard Link the default from the MVP.** *(Revised 2026-10-18 after Donovan asked for as few clicks as possible, and for agents to be able to set Hildegard up end to end for their owner.)* Hildegard Link is our own small open-source relay that forwards traffic without decrypting it. It gives every user `https://<name>.hildegard.link/mcp` with **no account anywhere**. That makes it the only option that is one click for a person and needs no human sign-in for an agent. It costs roughly **$10 to $50 a month** for thousands of users, and anyone can self-host it.
- **Keep two fallbacks.** An embedded **Tailscale Funnel** link is free and encrypted end to end, but it needs a Tailscale sign-in, which an agent can't do for you. **Bring your own Cloudflare Tunnel** stays as the advanced option.
- **Local agents need none of this.** Claude Desktop, Claude Code, Cursor, VS Code, LM Studio, Gemini CLI and similar tools run Hildegard's MCP locally over stdio. A `hildegard connect` command and one-click install links set them up.
- **Agents can set up everything, and the owner approves only what's risky.** Every setup step is a CLI command with `--json` output and is also an MCP tool. The owner taps one approval on their phone only for steps that expose the machine or spend money. Section 6a has the details.

## 1. How MCPs reach chatbots today

There are two kinds of MCP client, and they need different plumbing.

| Client kind | Examples | How it reaches Hildegard | Needs a public URL? |
|---|---|---|---|
| **Local** (runs on your computer) | Claude Desktop, Claude Code, Cursor, VS Code / Copilot, LM Studio, Gemini CLI, Codex, Zed, Ollama front ends | stdio (`hildegard mcp`) or `http://127.0.0.1` | **No** |
| **Cloud** (runs on the vendor's servers) | ChatGPT (web, desktop, mobile), claude.ai (web, desktop connectors, mobile), Claude in Slack, hosted agents | Streamable HTTP from the vendor's data centre to a public `https://` URL | **Yes** |

The cloud kind is the crux. ChatGPT and claude.ai call your MCP server from their own servers, so `localhost`, iroh and a private tailnet are all unreachable to them. Something on the public internet has to accept the HTTPS request and get it to the user's machine.

**Plan support (2026):**
- **Claude:** custom remote connectors work on every plan; the Free plan is limited to one custom connector. Claude registers by OAuth Dynamic Client Registration (DCR). Its outbound MCP traffic comes from `160.79.104.0/21`.
- **ChatGPT:** custom MCP needs Developer Mode, which starts at Plus; Free and Go only get directory apps. ChatGPT prefers Client ID Metadata Documents (CIMD) and falls back to DCR.
- **Spec:** MCP 2026-07-28 deprecated DCR in favour of CIMD (DCR stays for at least 12 months), requires issuer (`iss`, RFC 9207) checks, and removed protocol sessions. Hildegard's "long work returns a job handle" design already fits the stateless model.

**What "easy linking" looks like for each:**
- Cloud chatbots: paste one URL, then click through an OAuth sign-in. Claude also has an install deeplink that prefills the connector dialog.
- Local clients: install deeplinks (`cursor://`, `vscode://`, `lmstudio://`), a `.mcpb` bundle that installs with a double-click in Claude Desktop, or a JSON config entry.

## 2. What T3 Connect is

T3 Connect is part of Theo's open-source T3 Code (pingdotgg/t3code). You run `npx t3 connect`, sign in, and your machine gets a public address that phones, the web app and hosted agents such as ChatGPT and Claude can reach, including a "Copy MCP URL" action.

How it works, from its docs and third-party write-ups:
- **Identity:** Clerk accounts. The CLI uses OAuth with PKCE; API sessions are bound with DPoP proof-of-possession and last about an hour.
- **Tunnel:** the CLI installs a pinned copy of `cloudflared`. Traffic flows through a **Cloudflare tunnel hostname T3 provisions on its own domain**. A small T3-run relay (deployed with Alchemy, PlanetScale database) handles sign-in, linking and discovery; once set up, traffic goes through the tunnel straight to the machine.
- **OAuth for MCP:** the relay host serves OAuth protected-resource metadata so chatbots can sign in.
- **Price:** free to users. Its docs don't say who pays for tunnels past Cloudflare's free 1,000.
- **Rough edges:** the MCP URL isn't discoverable in a single-machine setup yet (issue #17216, open since 2026-10-08).

**Lesson for Hildegard:** the user experience is right: one command, sign in, copy a URL. The plumbing is the part not to copy. TLS ends at Cloudflare, and the cost grows linearly once you pass 1,000 users.

## 3. What Cloudflare Tunnel costs

| Item | Cost or limit |
|---|---|
| Tunnels 1 to 1,000 per account | Free |
| Each tunnel after 1,000 ("Tunnels for Platforms", launched 2026-10-16) | **$4.50 a month**, counting inactive tunnels too |
| Replicas per tunnel | 25 |
| DNS records on a free zone (one per user subdomain) | 1,000 for zones created after September 2024 |
| Request body on Free plan | 100 MB, which limits uploads of video or audio for editing |
| Video and large files on Free, Pro and Business | May be restricted or redirected. This applies to tunnel public hostnames too. |
| Domain | About $10 to $15 a year |

**Three ways Hildegard could use it:**

| Model | Who pays | Cost to us at 10,000 users | Privacy |
|---|---|---|---|
| **A. User brings their own Cloudflare account and domain** | The user, normally $0 | $0 | Cloudflare sees traffic |
| **B. We provision a tunnel per user under our domain (T3 Connect model)** | Us | About **$40,500 a month** in tunnel fees, plus extra DNS zones | Cloudflare sees traffic; video terms risk |
| **C. One Cloudflare Worker relay plus a Durable Object per user** | Us | Tens to low hundreds of dollars a month (estimate) | Cloudflare sees traffic; still covered by the video terms |

**Verdict:** A is a fine advanced option. B can't be free at scale and breaks the privacy promise. C is cheap but still decrypts at Cloudflare. That makes Cloudflare a poor fit for a free default.

## 4. Options that keep traffic private

The key idea is **TLS passthrough**. The relay reads only the hostname from the TLS handshake (SNI) and forwards the still-encrypted bytes. The user's own Hildegard daemon holds the certificate and decrypts. The relay never sees prompts, tokens or media.

| Option | Extra account | End to end | Cost to us | Notes |
|---|---|---|---|---|
| **Tailscale Funnel**, embedded in the daemon through `tsnet` | Free Tailscale account | **Yes**; Funnel relays don't decrypt | $0 | Address is `name.tailnet.ts.net`. Ports 443, 8443, 10000 only. Bandwidth limits are unpublished. Still in beta. |
| **Hildegard Link** (our relay) | None | **Yes** | About $5 to $50 a month for thousands of users | Open source and self-hostable. We run it, and we handle abuse reports. |
| **BYO Cloudflare Tunnel** | Cloudflare account and domain | No | $0 | Already in the foundation doc as the advanced option |
| Other tunnels (ngrok, zrok, Pangolin and similar) | Varies | Usually no | Varies | ngrok charges for custom domains; none beats the two above |

### Hildegard Link design sketch

- **Connection:** the daemon opens an outbound connection to `link.hildegard.<tld>`, authenticated with its device key. Hildegard already uses iroh, so this can be an iroh/QUIC connection with no ports to open.
- **Address:** each daemon gets a stable subdomain such as `<word-word-1234>.hildegard.link`.
- **Certificates:** the daemon gets its own Let's Encrypt certificate through TLS-ALPN-01, which works through the passthrough relay. The relay can't issue certificates for anyone.
- **Public Suffix List:** put `hildegard.link` on the PSL before launch. Each subdomain then counts as its own site for Let's Encrypt rate limits (otherwise 50 certificates a week for the whole domain), cookies are isolated between users, and one abused subdomain doesn't damage the reputation of the others.
- **Relay software:** stateless SNI routing, a few hundred lines of Rust. It forwards only port 443 TCP, rate-limits per subdomain, and has a takedown switch.
- **Cost estimate, not a quote:** MCP calls are small JSON. The big bytes are outputs the chatbot fetches: an image is 1 to 5 MB, a video clip 10 to 50 MB. At 1,000 active users averaging 100 MB a day, that is about 3 TB a month, within what a single budget VPS includes. Two VPS in different regions, plus a domain, is about $10 to $50 a month.
- **Abuse:** someone could use their link to host phishing pages. Mitigations: the relay only forwards to an authenticated daemon, the daemon serves only Hildegard's routes (`/mcp`, `/.well-known/*`, signed output links), and there is an abuse contact and kill switch per subdomain.

## 4a. Keeping Hildegard Link affordable

*Added 2026-10-18 after Donovan said "we can't pay for everyone for free."* Hildegard Link should not depend on us paying for heavy use.

**Where the cost actually comes from:**
- **Bandwidth:** a budget VPS of about €5 to €6 a month includes roughly 20 TB of traffic.
- **Relayed JSON:** MCP calls relayed as JSON cost almost nothing.
- **Media:** full-size images and video are the real cost.
- **Ops time and abuse handling:** these cost us time rather than money.

**Rules that keep it cheap, from the first release:**
1. **Previews through the link, originals stay home.** A chatbot gets a compressed preview through the link: a WebP image about 1024 px wide (around 150 KB), or for video a poster frame plus a short low-bitrate clip. The full-resolution file stays in the user's gallery and reaches their phone and desktop over iroh directly, which costs us nothing. A per-call `full_resolution` option exists, but it counts against the cap. This cuts relayed bytes by roughly 10 to 50 times.
2. **A fair-use cap on the free link.** The proposed cap is 2 GB a month and 60 requests a minute per link (revised from 10 GB once Link Plus was added; see section 4b). When a user reaches the cap, the link slows to a trickle rather than breaking, and the app offers the options in rule 3.
3. **Free ways past the cap that cost us nothing:**
   - **Self-host:** run your own relay with `hildegard relay serve`, a single binary or Docker image, on any $5 VPS or a free cloud tier.
   - **Community relays:** anyone can register a public relay, and the app picks the nearest healthy one. Because relays pass traffic through still encrypted, using a stranger's relay doesn't expose your data. It only affects uptime.
   - **Other transports:** Tailscale Funnel, or your own Cloudflare Tunnel.
4. **A paid Link Plus tier with a published margin.** Section 4b sets the price, the cost breakdown and the margin.
5. **Sponsorships from day one.** Set up GitHub Sponsors and Open Collective, with a public monthly cost dashboard so people can see where the money goes.

**Cost estimate, not a quote.** With previews by default, a typical active user relays well under 1 GB a month. At 10,000 linked users that is a few TB a month, which fits on one or two €5 to €6 servers. Even if every free user hit the 2 GB cap, 10,000 users would need about 20 TB a month, which is roughly €20 a month in servers and traffic. The money is small either way; the cap exists mainly to stop a single abuser.

**Recommendation (revised 2026-10-18):** launch with all five rules. Donovan asked for a transparent paid tier where we profit a stated amount, so Link Plus (section 4b) ships at launch rather than waiting for costs to grow.

## 4b. Link Plus: a transparent price

*Added 2026-10-18. Donovan asked for a reasonable, transparent price where we profit a stated amount, a plain explanation of why the link costs money, and how to use Tailscale instead for free.*

### What running the relay properly costs

"Strong and scalable" means relays in three regions (Europe, US East, US West or Asia), with two servers in each so that one can fail without an outage.

| Fixed cost | Monthly | Basis |
|---|---|---|
| 6 relay servers | about $60 | About $10 each on Hetzner-class VPS. EU servers include 20 TB of traffic; US servers include 1 TB, then about $1.20 per TB. |
| GeoDNS and health checks | about $10 | Routes each user to the nearest healthy relay |
| Monitoring, status page, logs | about $20 | |
| Domain (`hildegard.link`) | about $3 | |
| Reserve for spikes and abuse cleanup | about $7 | |
| **Total fixed** | **about $100 a month (about $1,200 a year)** | Estimate, not quotes |

**Costs per user:**
- **Bandwidth:** about $1.20 per TB. A Plus user at the 100 GB cap costs at most about $0.12 a month; a typical user costs about one cent.
- **Payment handling:** a merchant of record such as Paddle or Lemon Squeezy charges 5% plus $0.50 per payment. In exchange it handles worldwide sales tax and VAT, invoices and failed payments, so Hildegard doesn't have to register for tax in every country.

Because of that fixed $0.50, **annual billing is much fairer**. On $3 a month the fee takes 22%; on $24 a year it takes 7%.

### Proposed price

| Plan | Price | What you get |
|---|---|---|
| **Link (free)** | $0 | Random address (`word-word-1234.hildegard.link`), previews only, 2 GB a month, nearest region. Enough for roughly 10,000 preview images a month, and still zero-account, so agents can set it up. |
| **Link Plus** | **$24 a year** (or $3 a month) | 100 GB a month, full-resolution outputs, a custom name (`donovan.hildegard.link`) or your own domain, a choice of region, priority on busy relays |

**Where $24 goes**, at an assumed 10,000 free users and 300 Plus members:

| Share of each $24 | Amount | |
|---|---|---|
| Payment and tax handling | $1.70 | 7% |
| Servers and bandwidth, including the free tier | $4.00 | 17% |
| Maintenance, security updates and abuse handling (paid time) | $11.10 | 46% |
| **Profit to Hildegard** | **$7.20** | **30%** |

How those numbers follow from the assumptions:
- Fixed costs of about $1,200 a year, divided over 300 members, come to $4 each.
- At $24 a member, the 300 members pay $7,200 a year. Profit is set at 30% of that, which is $2,160.
- With fewer members, maintenance and profit shrink first. Break-even on hard costs is about 55 members.

**Recommendation: $24 a year, $3 a month, with a profit target of 30% published as a cap.** The commitment reads: "If Link profit goes above 30% of Link revenue for two quarters in a row, we raise everyone's limits or lower the price." A quarterly public ledger of revenue, costs and profit backs it up.

$24 a year is well below ngrok's custom-domain plan (about $20 a month). Nobody needs a cheaper option, because Tailscale is always free.

### Why the link costs money: user-facing text (draft)

> **Why does Hildegard Link have a paid plan?**
> Hildegard runs on your computer, and that is free forever. But ChatGPT and Claude live on other companies' servers, so they can only reach your computer through a public address on the internet. Hildegard Link is that address: servers we rent in three regions that pass your traffic along, still encrypted, so we can't read it.
> Renting those servers, keeping them secure, and handling abuse costs real money every month. So the basic link is free, and Link Plus costs $24 a year. Of each $24, about $1.70 goes to payment and tax processing, $4 to servers and bandwidth, $11.10 to the people who maintain and secure the relay, and about $7.20 is Hildegard's profit, which funds the rest of the open-source project. We publish the real numbers every quarter. If profit goes above 30%, we raise your limits or lower the price.
> **Prefer not to pay?** Use Tailscale instead: it is free, also encrypted end to end, and Hildegard sets it up for you (see "Use Tailscale instead"). Or run your own relay; the code is open source.

### Legal checklist (not legal advice; have a lawyer review before launch)

- **Use a merchant of record** (Paddle or Lemon Squeezy). It is the legal seller, so it collects and remits sales tax and VAT and handles consumer-law notices in each country.
- **Auto-renewal rules:**
  - The US federal "click-to-cancel" rule was vacated in July 2025, but state laws still apply, notably California's Automatic Renewal Law.
  - Show the price, renewal term and how to cancel before checkout, and get explicit consent.
  - Send a confirmation email.
  - Send a reminder before each annual renewal.
  - Allow cancellation online in one step from the app.
- **EU and UK right of withdrawal.** Buyers of digital services have 14 days to withdraw. Either honour a 14-day refund, which is simplest and recommended, or get explicit consent to start the service immediately and acknowledgement that the right is lost.
- **Truthful claims.**
  - Published cost splits and the 30% cap are promises, so state them as "about" with the ledger as proof, and keep the ledger accurate.
  - Say "free" only for what is free with no hidden conditions.
  - Describe the relay's privacy honestly: "we can't read your traffic" is true for TLS passthrough, but we do see connection metadata (IP addresses, timing, bytes). Say so in the privacy policy.
- **Terms of service and acceptable use** for Link: no hosting of phishing or illegal content, our right to suspend abusive subdomains, an uptime target rather than a guarantee, and a refund policy.
- **AGPL fit.** Charging for a hosted service around AGPL code is allowed. The relay source stays public, which is also the self-host escape hatch.

### Use Tailscale instead (free)

**User-facing guide, draft:**
1. In Hildegard, open **Settings → Remote access → Public link** and choose **Use Tailscale (free)**.
2. Sign in with Google, GitHub, Microsoft or Apple when Tailscale's page opens. Tailscale's free Personal plan covers up to 6 users with unlimited devices, and Funnel is available on all plans.
3. Hildegard turns on Tailscale Funnel by itself and shows your address, for example `https://hildegard.your-tailnet.ts.net/mcp`. Paste it into ChatGPT or Claude exactly as you would a Hildegard Link address.

**Already run Tailscale yourself?** `hildegard connect --public --via tailscale` uses your existing tailnet. The manual equivalent is `tailscale funnel` pointed at Hildegard's port.

**Good to know:**
- Funnel is still in beta, and Tailscale applies bandwidth limits it doesn't publish.
- Your address includes your tailnet's name.
- Ports are limited to 443, 8443 and 10000.
- An agent can do everything except the Tailscale sign-in, which you do once.

## 5. Security model for a public MCP link

These rules apply whatever transport carries the link.

1. **Off by default.** Turn it on per device with a single toggle. Show the public URL, an "active" badge and a kill switch.
2. **The daemon is its own OAuth 2.1 authorization server.** It serves protected-resource and authorization-server metadata and supports pre-registered clients, CIMD and DCR (in that order). It sends and checks `iss`, uses PKCE, issues short-lived audience-bound tokens and rotates refresh tokens.
3. **Consent happens on a paired device.** When ChatGPT or Claude starts sign-in, the browser page shows "Approve on your phone or desktop" plus a short code. The user approves in the Hildegard app. There are no passwords to phish.
4. **Each chatbot gets a grant.** The grant is the same kind the foundation doc already defines for agents: which tools, a GPU-hours cap, an outside-API spend cap ($0 by default), gallery read off by default, and the agent priority class. Each grant can be revoked from the Choir screen.
5. **Outputs use signed, expiring links.** A chatbot receives `https://…/o/<hash>?sig=…` that expires within hours, rather than the whole gallery.
6. **Optional source allowlist.** Accept OAuth'd traffic only from known chatbot egress ranges (for example Anthropic `160.79.104.0/21`, plus OpenAI's published ranges). This is off by default, because ranges change.
7. **Rate limits and audit.** Every call is logged with the client name in the Queue and Costs screens, which the foundation doc already plans.
8. **Be honest about privacy.** Whatever goes to ChatGPT or Claude is seen by OpenAI or Anthropic. End-to-end transport only guarantees that nobody *else*, including us, sees it.

## 6. The linking experience

- **Hildegard app, "Connect a chatbot" screen.** It has one tile per client:
  - Claude: a "Add to Claude" deeplink with the URL prefilled.
  - ChatGPT: a copy button and three steps (Settings → Apps → Developer mode → Create). It notes that ChatGPT needs Plus or higher.
  - Cursor, VS Code, LM Studio: one-click install deeplinks.
  - Claude Desktop: a `.mcpb` download.
  - Anything else: copyable JSON config.
- **CLI.** `hildegard connect` lists the clients it finds on the machine and writes their configs. `hildegard connect --public` turns on the public link and prints the URL. This mirrors the experience of `npx t3 connect`.
- **Directories.** Publish to the official MCP Registry so clients that browse it can find Hildegard. Users still connect their own machine, so no shared server is involved.

## 6a. Setup by an agent, end to end

Donovan wants agents to be able to set Hildegard up for their owner. The design rule: **everything a person can click, an agent can do with a command, and only the risky steps need the owner.**

**Agent-operable surface**
- **Install with one command per OS**, for example `curl -fsSL https://hildegard.<tld>/install.sh | sh`, `winget install Hildegard` or `brew install hildegard`. Each is non-interactive, and the install script is signed and versioned.
- **Every setup step is a CLI command with `--json` output and stable exit codes:**
  - `hildegard setup --profile auto` detects hardware and picks starter models.
  - `hildegard models install <id>` installs a model.
  - `hildegard connect <client>` links one client.
  - `hildegard connect --public` turns on the public link.
  - `hildegard pair --print-code` pairs a device.
  - `hildegard status --json` reports state.
- **The same steps are MCP tools,** such as `setup_status`, `install_model`, `connect_client`, `enable_public_link`, `create_agent_grant` and `doctor`. An agent already connected to Hildegard can finish setup, or repair it, by itself.
- **Agent-readable docs:** an `llms.txt` and an `AGENTS.md` / Agent Skill describing the setup flow, and `hildegard doctor --json` with exact fix commands for every failure.

**Which clients an agent can link without a click**

| Client | How an agent links it | Owner clicks |
|---|---|---|
| Claude Code, Codex, Gemini CLI | Their own `mcp add` commands, run by `hildegard connect` | 0 |
| Claude Desktop, Cursor, LM Studio, Zed | Writes the client's MCP config file | 0, plus a restart of the client |
| VS Code | `code --add-mcp` | 0 |
| claude.ai (web, desktop connectors, mobile) | Prints an install deeplink with the URL prefilled. Claude doesn't let an outside agent add connectors silently. | About 2: open the link, approve the sign-in |
| ChatGPT | Prints the URL and the Developer Mode steps. ChatGPT has no install link for custom MCPs. | About 4, and it needs Plus or higher |

**What waits for the owner**
- These steps always wait for the owner: turning on the public link, OAuth consent for a cloud chatbot, granting outside-API spending, and gallery read access.
- The agent can *request* each step. The owner gets one push notification on a paired device ("Claude Code wants to turn on a public link for Hildegard: Approve / Deny"). The agent then polls `setup_status`.
- One approval can cover a bundle. For example, "Link ChatGPT" turns on the public link, creates the grant and pre-approves that client's OAuth sign-in in a single tap.
- On a fresh machine with no paired phone yet, the owner's first approval is the pairing QR shown on that machine's screen. This is the only step an agent can never do, by design.

**Why this changes the transport choice:** Tailscale Funnel needs the owner to sign in to Tailscale in a browser, so an agent can't finish setup alone. Hildegard Link needs no account, so its whole flow is one approval tap. That is why section "The answer in brief" now makes Hildegard Link the MVP default, with Funnel as a fallback.

## 7. What changes in the foundation doc

| Section | Today | Proposed change |
|---|---|---|
| **3a**, "Built into the daemon, two transports" | Says remote Streamable HTTP is "reachable over the same iroh / Tailscale paths as the phone" | Split remote clients in two. Agents on your own devices use iroh or a tailnet. **Cloud chatbots need a public HTTPS link** (new section 6x, "Public link"). Name the target spec as MCP 2026-07-28 (stateless, CIMD, `iss`). |
| **3a**, OAuth sentence | "OAuth 2.1 … mapped onto paired-device grants" | Add: the daemon is its own authorization server; supports pre-registered clients, CIMD and DCR; consent is approved on a paired device; chatbots get agent grants; outputs are served through signed, expiring links. |
| **6**, comparison table | Six rows; Cloudflare Tunnel is the only public-URL option | Add rows for **Tailscale Funnel (tsnet)** and **Hildegard Link (TLS-passthrough relay)**. Add a column "Gives a public HTTPS URL for cloud chatbots". Note the per-tunnel cost and the video terms on the Cloudflare row. |
| **6**, recommendation | 3 tiers: iroh, Tailscale, Cloudflare | Keep them for phone-to-home. Add a separate list for **chatbot linking**: (1) Hildegard Link, the default from the MVP; (2) Tailscale Funnel as a fallback; (3) BYO Cloudflare, advanced. State that managed Cloudflare tunnels were rejected because of cost and privacy. |
| **3a**, new bullet | Agents use Hildegard but don't set it up | Add **"Agents can install and configure Hildegard"**: every setup step is a CLI command with `--json` and an MCP tool, and risky steps wait for owner approval on a paired device (section 6a). |
| **7**, threat model | "No open ports by default" | Add a row for **"Public MCP link enabled"**: OAuth with consent on a paired device, scoped grants, rate limits, optional egress allowlist, kill switch, audit log. Add **abuse of Hildegard Link subdomains** under internet attacker. |
| **11**, decisions | No chatbot-linking decision | Add the decision "free public MCP link through Hildegard Link?". In the build plan, put these in the MVP: `hildegard connect`, local deeplinks, agent-operable setup (section 6a), Hildegard Link with PSL submission, and embedded Funnel as a fallback. |

## Sources

- [T3 Connect public MCP URL issue #17216 (GitHub)](https://github.com/pingdotgg/t3code/issues/17216)
- [T3 Connect authentication (DeepWiki)](https://deepwiki.com/pingdotgg/t3code/7.2-t3-connect-authentication)
- [T3 Connect internals doc (GitHub)](https://github.com/pingdotgg/t3code/blob/main/docs/internals/t3-connect.md)
- [A deep dive into T3 Code (Flavio Copes)](https://flaviocopes.com/t3-code/)
- [Theo's T3 Connect announcement (X)](https://x.com/theo/status/2082277789395501263)
- [t3-mcp connector (GitHub)](https://github.com/rodrigorm/t3-mcp)
- [Tunnels for Platforms pricing (Cloudflare Docs)](https://developers.cloudflare.com/tunnel/features/tunnels-for-platforms/)
- [Cloudflare One account limits](https://developers.cloudflare.com/cloudflare-one/account-limits/)
- [Delivering videos with Cloudflare](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/delivering-videos-with-cloudflare/)
- [Cloudflare free plan limits 2026 (eastondev)](https://eastondev.com/blog/en/posts/dev/20260526-cloudflare-free-limits/)
- [Cloudflare Tunnel vs Tailscale Funnel vs VPS (devtoolpicks)](https://devtoolpicks.com/blog/when-to-use-cloudflare-tunnel-vs-tailscale-funnel-vs-public-vps-indie-hackers-2026)
- [Tailscale Funnel docs](https://tailscale.com/docs/features/tailscale-funnel)
- [MCP authorization spec 2026-07-28 changes (SSOJet)](https://ssojet.com/blog/mcp-authorization-spec-2026-07-28-what-changed)
- [Which MCP clients a remote server lets in (hidekazu-konishi)](https://hidekazu-konishi.com/entry/which_mcp_clients_a_remote_mcp_server_lets_in.html)
- [Which plans support MCP in 2026 (caipi)](https://caipi.ai/blog/which-plans-support-mcp-2026)
- [State of MCP clients (MCP Bundles)](https://mcpbundles.com/blog/state-of-mcp-clients)
- [Hetzner traffic pricing (egresscost)](https://egresscost.com/hetzner)
- [Paddle vs Lemon Squeezy fees (Dodo Payments)](https://dodopayments.com/blogs/paddle-vs-lemon-squeezy/)
- [Tailscale free tier doubled, April 2026](https://thisisanitsupportgroup.beehiiv.com/p/tailscale-s-free-tier-just-doubled-if-you-ve-been-putting-it-off-today-s-the-morning)

**Inferred, not verified:**
- The cost of Option C and of Hildegard Link, worked out from typical VPS pricing and the traffic estimate above.
- Who pays for T3 Connect's tunnels beyond 1,000.
- The Link Plus fixed-cost table and the 300-member assumption.
- The legal checklist is a summary to hand to a lawyer, not legal advice.
