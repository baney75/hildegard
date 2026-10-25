# Hildegard in your AI apps

Hildegard is how an AI app reaches your own computers. Link it once and the app gets Hildegard's tools (films, stills,
voices, music, 3D, your local models) running on your GPUs, its craft skills, and its loop: generate, render,
critique, refine, until the piece passes. This page is every app's steps, fewest clicks first.

| App | Tools on your GPUs | Skills | Steps |
| --- | --- | --- | --- |
| Claude Code | Plugin | Plugin | Two commands |
| Claude Desktop | `hildegard connect` | Plugin upload | One command, one upload |
| claude.ai, Cowork, Claude on phones | Custom connector (public link) | Skill uploads, or over MCP | A link, a sign-in |
| ChatGPT | Developer-mode app (public link) | Over MCP, or Skills upload | A link, a sign-in |
| Grok (grok.com) | Custom connector (public link) | Over MCP | A link, a sign-in |
| Grok Bot | Custom MCP server (public link) | Over MCP, or a private skill | One message, a sign-in |
| Codex, Cursor, VS Code, Gemini CLI, OpenCode, Windsurf, Zed, OMP | `hildegard connect` | `hildegard skills install` | One command |

**Skills over MCP.** Every app that links Hildegard can read its skills with the `list_skills` and `read_skill` tools,
and apps that show MCP prompts list each skill as one (`/hildegard`, `/hildegard-3d`). So in ChatGPT, Grok and Grok Bot
the skills come with the link, and uploading them is optional.

**The public link.** claude.ai, ChatGPT, Grok and Grok Bot run on their makers' servers, not on your computer, so they
reach Hildegard only at a public HTTPS address. `hildegard host --funnel --json` makes one with Tailscale Funnel and
prints it as `mcpUrl`. That puts Hildegard's sign-in page on the public internet, so turn it on only if you want
these apps. Each app then opens Hildegard's sign-in page, where you type your own name and passphrase (an agent never
does this for you), and acts as you until you revoke it in Settings › Sharing or with `hildegard host keys revoke`.
Apps on your own devices don't need Funnel: Tailscale Serve keeps them inside your tailnet. **Hildegard Link**, an
end-to-end encrypted relay that needs no Tailscale, is coming soon.

## Claude Code

```text
/plugin marketplace add baney75/hildegard
/plugin install hildegard@hildegard
```

The plugin brings every skill and an MCP server that starts the Hildegard installed on this computer
(`plugin/mcp.mjs`). If Hildegard isn't installed yet, the server offers one tool, `hildegard_install`, that tells
Claude how to install it; run `/mcp` to reconnect afterwards. Hildegard somewhere unusual: set `HILDEGARD_BIN` to its
`hildegard` command. With the plugin on, `hildegard connect claude-code` leaves Claude Code alone, so tools aren't
listed twice.

Without the plugin: `hildegard connect claude-code` and `hildegard skills install`.

## Claude Desktop

1. `hildegard connect claude-desktop`, then quit and reopen Claude.
2. For the skills, download `hildegard.plugin` from the [latest release](https://github.com/baney75/hildegard/releases/latest)
   and add it in Claude: Settings › Plugins (or Customize › Plugins) › Upload. It carries the skills only, since
   step 1 linked the tools.

## claude.ai, Cowork and Claude on your phone

1. `hildegard host --funnel --json` on the computer Hildegard runs on, and copy `mcpUrl`.
2. claude.ai › Settings › Connectors › Add custom connector, with that address. Sign in on Hildegard's page. The
   connector then works in Cowork and the phone apps too.
3. Skills (optional, they also come over MCP): download the `skill-*.zip` files from the
   [latest release](https://github.com/baney75/hildegard/releases/latest) and upload each in Settings › Capabilities ›
   Skills. Start with `skill-hildegard.zip`, `skill-hildegard-3d.zip` and `skill-hildegard-loop.zip`.

## ChatGPT

1. `hildegard host --funnel --json`, and copy `mcpUrl`.
2. ChatGPT › Settings › Apps › Advanced settings › Developer mode on, then **Create app**, with that address and OAuth.
   Sign in on Hildegard's page. Developer mode needs Plus or higher.
3. In a chat, pick Hildegard from the tools menu. Ask it to read the `hildegard` skill first, or upload the skills:
   on Business, Enterprise and Edu, Skills › Create › Upload from your computer takes the `skill-*.zip` files.

## Grok

1. `hildegard host --funnel --json`, and copy `mcpUrl`.
2. grok.com › Connectors › New connector › Custom, with that address. Sign in on Hildegard's page.

## Grok Bot

Grok Bot runs on its own cloud computer, so it needs the public link even when it's installed on yours. Paste this
into a chat with it, with your address in place of the example:

```text
Add a custom MCP server named "hildegard" at https://your-computer.your-tailnet.ts.net/mcp (Streamable HTTP, OAuth).
I'll sign in on its page myself. Then call list_skills and read the "hildegard" skill before you make anything.
```

Hildegard's MCP is stateless, so it also answers the requests Grok Bot sends on a reused session without the
`MCP-Protocol-Version` header. To keep a skill in Grok Bot itself, add `skill-hildegard.zip`'s `SKILL.md` as a private
skill.

## Coding agents and other apps on this computer

```sh
hildegard connect --all        # every app Hildegard finds: Codex, Cursor, VS Code, Gemini CLI, OpenCode, …
hildegard skills install       # the skills, where Claude Code, Codex and OMP read them
```

An app on another of your devices: `docs/agents.md`, section F (a key from `hildegard host key`, kept in that
device's keychain).

## The loop, from any of them

Ask for a piece that needs several tries ("a heron finial for my printer, 120 mm"), and the app runs Hildegard's loop:
`loop_start` with the brief and targets, `loop_submit` for each version (Hildegard measures it and draws a contact
sheet), `loop_critique` with every question answered from the sheet, and `loop_finish` with the best round. The
**hildegard-loop** and **hildegard-3d** skills say how; **hildegard-print** for a part to print (measured, fitted,
sliced, with a print sheet) and **hildegard-web** for a website ([make.md](make.md)). A whole loop can also go to a coding agent on your computer,
within each provider's terms ([agent-terms.md](agent-terms.md)):

```sh
hildegard loop run codex "a standing heron finial, 120 mm tall, for an FDM print" --kind model --print --size 40x40x120
hildegard loop show <id>
```
