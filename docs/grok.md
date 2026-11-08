# Hildegard in Grok

Grok (grok.com) has no store. You add Hildegard to it as a custom connector, which takes four steps and one sign-in.
Grok runs on xAI's servers, not on your computer, so it can reach Hildegard only at a public HTTPS address. A tailnet
address won't do.

## Steps

1. **Make a public address.** On the computer Hildegard runs on, use one of these:

   ```sh
   hildegard tunnel tailscale --funnel      # Tailscale Funnel: a name on your tailnet, open to the internet
   hildegard tunnel cloudflare --hostname hildegard.example.com   # a Cloudflare tunnel on a domain you own
   ```

   `hildegard tunnel` with no words says where Tailscale and Cloudflare stand here and what each still needs.
   `cloudflare --quick` makes a temporary `trycloudflare.com` name with no account, but it changes whenever the tunnel
   restarts, and Grok would lose the connector each time; use it only to try Grok out.
2. **Copy the MCP address.** `hildegard host status --json` prints `mcpUrl`, such as
   `https://your-computer.your-tailnet.ts.net/mcp`.
3. **Add the connector in Grok.** Open grok.com/connectors, then **New Connector** › **Custom**, name it `Hildegard`, paste
   the address, and choose OAuth if it asks how to sign in.
4. **Sign in on Hildegard's page.** Grok opens it. Type your own name and passphrase (or a one-time code from
   `hildegard host code`). An agent never does this step for you. Grok then acts as you until you revoke it in
   Settings › Sharing or with `hildegard host keys revoke`.

That puts Hildegard's sign-in page on the public internet, so turn it on only if you want Grok to use it. Turn it off
with `hildegard tunnel off`.

## The craft comes with the link

Grok reads Hildegard's skills over the same connector, so there is nothing to upload. In a chat, say:

```text
Call list_skills, then read_skill "hildegard" before you make anything.
```

`list_skills` names the 14 skills; `read_skill` returns one's instructions, and with `file` its other files (the
references and the scripts it names). The `hildegard` skill says which of the others to read for the job.

## Does Hildegard's sign-in match what a custom connector needs?

I read `apps/server/src/oauth.ts`, `grants.ts` and `remote-mcp.ts` against the MCP authorization flow that custom
connectors use. What matches, and what only a live test can settle:

| Step a connector takes | Hildegard |
| --- | --- |
| `POST /mcp` with no token must answer 401 and point to the metadata | Yes: `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp", scope="hildegard"` |
| Protected resource metadata (RFC 9728) | Yes, at `/.well-known/oauth-protected-resource` and `…/mcp` |
| Authorization server metadata (RFC 8414) | Yes, at `/.well-known/oauth-authorization-server` and `…/mcp`: authorization, token, registration and revocation endpoints; `S256` only; `authorization_response_iss_parameter_supported` |
| Client registration | Dynamic registration (RFC 7591) at `/oauth/register`, and client ID metadata documents. Redirect URIs must be https, an app's own scheme, or `http://localhost` |
| Authorization code with PKCE | Yes, `S256` required, `resource` and `scope` optional (the one scope is `hildegard`) |
| Token and refresh | Yes: `authorization_code` and `refresh_token`, form or JSON, CORS answered |
| Transport | Stateless Streamable HTTP at `/mcp`, `POST` only |

What may not work with Grok, and must be tried live (`untested live`: no Grok sign-in was available to the agent that
wrote this page):

1. **A client secret.** Hildegard registers public clients only. If Grok's registration asks for
   `token_endpoint_auth_method` of `client_secret_basic` or `client_secret_post`, `/oauth/register` answers
   `invalid_client_metadata`. If that is what you see, Grok needs a client that accepts `none`, or Hildegard needs to
   accept a secret it ignores.
2. **The older SSE transport.** `GET /mcp` answers `405` (Hildegard keeps no session or stream). A client that speaks
   only the older HTTP+SSE transport (`GET /sse`) can't connect. Streamable HTTP clients are fine.
3. **Tool results with media.** Hildegard's tools return links to videos and stills, valid for 24 hours without
   signing in. Whether Grok shows them inline or only as links is Grok's choice.
4. **Rate and size.** Each connector may make 240 calls a minute, and `read_skill` cuts a file at 400 KB and says so.
5. **A changing address.** The OAuth tokens belong to one address (`resource`). A new Funnel or Cloudflare name needs
   a new connector.

If any of these fails, `hildegard doctor` and the server log show the request that was refused.

## Revoke

Settings › Sharing in the Studio, or `hildegard host keys revoke <id|name>`, ends Grok's access at once.
