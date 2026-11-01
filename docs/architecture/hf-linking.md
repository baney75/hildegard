# Linking Hugging Face securely (researched 2026-10-19)

**Decision (default):** sign in with HF OAuth, public client (no secret), scopes `openid profile gated-repos`.
- Desktop: authorization code + PKCE S256, system browser, loopback redirect `http://127.0.0.1:<port>/api/hf/callback` on an ephemeral port (HF accepts any port for loopback hosts), `state` checked.
- Headless/SSH: device flow (RFC 8628): `POST https://huggingface.co/oauth/device`, poll `/oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`.
- Fallback: paste a fine-grained token with only "Read access to contents of all public gated repos you can access" ticked (`https://huggingface.co/settings/tokens/new`, choose Custom).
- Endpoints from `https://huggingface.co/.well-known/openid-configuration`: authorize `/oauth/authorize`, token `/oauth/token`, userinfo `/oauth/userinfo`, device `/oauth/device`. No revocation endpoint.
- Storage: OS keychain via `@napi-rs/keyring` (Rust later: `keyring`). Linux without Secret Service: 0600 file under `$XDG_CONFIG_HOME/hildegard/`, clearly labelled; also accept `HF_TOKEN` from the service env (systemd `LoadCredential=`).
- Use: inject `HF_TOKEN` only into child processes (ComfyUI, downloads) and set `HF_TOKEN_PATH` to a nonexistent path. Never call `hf auth login` (writes plaintext).
- Gated check: `GET /api/models/{repo}` → `gated` false/"auto"/"manual"; access check by `HEAD /{repo}/resolve/{rev}/{file}` with the bearer token (200/302 = granted, 401/403 = accept the license at `https://huggingface.co/{repo}`).
- Client ID (2026-10-24): no registered app needed. Hildegard uses a Client ID Metadata Document at `https://dbaney.com/hildegard/oauth/hf-client.json` (served from the dbaney.com repo, commit 6682b81) as its client ID; HF accepts it for both the browser and device-code flows. `HILDEGARD_HF_CLIENT_ID` overrides it. HF's first-ever call for a new CIMD can return `invalid_client`; Hildegard retries once. The token exchange still needs one real sign-in to confirm.
- One click when this computer already ran `hf auth login`: Settings and `hildegard hf login` offer to reuse that token (copied into the keychain; the hf CLI's own file is left as is).
- To verify live: token `expires_in` and whether a `refresh_token` comes back.
Sources: huggingface.co/docs/hub/oauth, /docs/hub/security-tokens, /changelog/token-presets, /docs/huggingface_hub env vars.
