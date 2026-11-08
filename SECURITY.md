# Security

Hildegard runs on your own computers and can be shared at a link, so a security problem in it can reach people's
machines and their work. Please report one privately.

## Reporting

Use [Report a vulnerability](https://github.com/baney75/hildegard/security/advisories/new) on this repository's
Security tab, or email donovan@dbaney.com. Say what an attacker can do, and how. You’ll get an answer as soon as possible,
and a fix ships in a signed release, which every install picks up on its own.

Please don't open a public issue, and don't test against computers that aren't yours.

## What's in scope

- The server, the Studio, the CLI and the desktop app in this repository, and the installers in each release.
- Hildegard at a link (`hildegard host`): sign-in, invites, keys, the MCP endpoint and OAuth for chatbots.
- Choir pairing between computers, and the update path (signatures, checksums).
- Go live ([docs/streaming.md](docs/streaming.md)): a way to read a stream key or an OBS password, or for an AI app to start a stream.
- The safety layers in [docs/safety.md](docs/safety.md), and voice consent in [docs/voice.md](docs/voice.md).
- The skills, and the way suggestions to them are checked and shipped ([docs/skill-suggestions.md](docs/skill-suggestions.md)):
  a way to get a hostile instruction into a skill people install is a vulnerability.

Models, ComfyUI and other projects Hildegard runs have their own maintainers; report problems in them there too.

## Supported versions

Only the latest release. Hildegard updates itself, and `hildegard update` brings any install up to date.

## Local secret scan

`.githooks/pre-commit` runs `scripts/secret-scan.py` on what you staged. The script
flags token prefixes, PEM headers, basic-auth URLs and a short list of other shapes,
and prints the file, line number and pattern name (never the matched value). Enable it
once per checkout:

```sh
git config core.hooksPath .githooks
```

When a test needs a fake credential, assemble it at runtime (`"gh" + "p_" + "x" * 36`)
so this scan and GitGuardian never see a contiguous token. End a look-alike line with
`secret-scan: allow` if you must keep one.
