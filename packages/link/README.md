# Hildegard Link (prototype)

Hildegard Link gives a Hildegard a public address, `https://<name>.hildegard.link`, so a chatbot such as Claude or ChatGPT can reach its MCP without a Tailscale account. The relay never decrypts anything. It reads only the name from the TLS ClientHello and passes the encrypted bytes through to your Hildegard, which holds the certificate.

The full design is in the project's architecture notes (`mcp-public-link.md`); costs and funding are in `link-funding-plan.md`.

## What works now

- **The relay** (`LinkRelay`) has a public port for callers and an agent port for Hildegards. A Hildegard dials out, so it works behind any router. For each caller, the relay asks it to dial back, then joins the two connections. A PROXY v1 line tells your Hildegard who called.
- **Names** are claimed by a 256-bit token. Only the token's hash is kept, in a file that only the relay's user can read.
- **Limits:**
  - connections open at once, per name
  - new connections a minute, per name
  - the number of names
  - a deadline for a caller's hello and for each dial-back
- **Liveness:** pings, so a Hildegard that goes quiet is dropped.
- **Takedown:** blocking a name ends its Hildegard and every caller at once.
- **The agent** (`LinkAgent`) holds the name, reconnects with backoff, and hands each caller, still encrypted, to a TLS server through `server.emit('connection', socket)`.

## Before launch

1. **Domain:** buy `hildegard.link`, or another name.
2. **Public Suffix List:** submit it to the PSL, so each name is its own site.
3. **Certificates:** a certificate for each Hildegard through ACME TLS-ALPN-01, answered by the Hildegard through the relay.
4. **Wiring:**
   - Wire `LinkAgent` into the server's hosted listener, with the PROXY address feeding its rate limits.
   - Add a `hildegard link on` command and a switch in the Studio.
5. **Deployment:**
   - TLS on the agent port.
   - A `hildegard relay serve` command and a container image.
   - Relays in three regions, plus status and abuse pages.
6. **Traffic caps:** the per-name monthly cap (2 GB free) and preview-sized outputs.
