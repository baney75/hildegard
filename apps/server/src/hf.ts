import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { HfState } from '@hildegard/presets';

const HF = 'https://huggingface.co';
/** Enough to download public and gated repos you have accepted; nothing private, nothing that writes. */
export const HF_SCOPES = 'openid profile gated-repos';

export interface HfToken {
  access_token: string;
  refresh_token?: string;
  /** Epoch ms. */
  expires_at?: number;
  user: string;
}

/** Where a secret lives. The keychain is preferred; a 0600 file is the fallback where no keychain runs. */
export interface SecretStore {
  readonly kind: 'keychain' | 'file';
  get(): string | null;
  set(value: string): void;
  delete(): void;
}

export async function keychainStore(): Promise<SecretStore | null> {
  try {
    const { Entry } = await import('@napi-rs/keyring');
    const entry = new Entry('Hildegard', 'huggingface');
    // Probe: a Linux box without a Secret Service throws here, not later.
    entry.getPassword();
    return {
      kind: 'keychain',
      get: () => entry.getPassword() ?? null,
      set: (v) => entry.setPassword(v),
      delete: () => {
        try {
          entry.deletePassword();
        } catch {}
      },
    };
  } catch {
    return null;
  }
}

export function fileStore(path: string): SecretStore {
  return {
    kind: 'file',
    get: () => (existsSync(path) ? readFileSync(path, 'utf8') : null),
    set: (v) => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, v, { mode: 0o600 });
      chmodSync(path, 0o600);
    },
    delete: () => rmSync(path, { force: true }),
  };
}

const b64url = (b: Buffer) => b.toString('base64url');

export interface DeviceStart {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
}

/**
 * Links a Hugging Face account. Three ways in, most secure first: sign in with the browser on this computer (OAuth
 * with PKCE, no secret, nothing to copy), sign in from any other device with a short code (device flow, for headless
 * machines), or paste a fine-grained read token. The token is kept in the OS keychain and only ever handed to child
 * processes in their environment; it is never written to ~/.cache/huggingface.
 */
export class HfLink {
  private token: HfToken | null = null;
  private pending = new Map<string, { verifier: string; redirect: string; at: number }>();
  private device: { code: string; interval: number; until: number; timer?: NodeJS.Timeout } | null = null;
  private readonly onChange: (s: HfState) => void;
  private readonly clientId: string | null;
  private readonly store: SecretStore;
  private readonly fetchFn: typeof fetch;

  constructor(opts: {
    store: SecretStore;
    clientId: string | null;
    onChange: (s: HfState) => void;
    fetch?: typeof fetch;
  }) {
    this.store = opts.store;
    this.clientId = opts.clientId;
    this.onChange = opts.onChange;
    this.fetchFn = opts.fetch ?? fetch;
    const raw = (() => {
      try {
        return this.store.get();
      } catch {
        return null;
      }
    })();
    if (raw) {
      try {
        this.token = JSON.parse(raw) as HfToken;
      } catch {
        this.token = null;
      }
    }
  }

  private fromEnv(): string | null {
    return process.env.HF_TOKEN?.trim() || null;
  }

  state(): HfState {
    const env = this.fromEnv();
    if (env && !this.token) return { linked: true, user: null, storage: 'env', oauth: !!this.clientId };
    return {
      linked: !!this.token,
      user: this.token?.user ?? null,
      storage: this.token ? this.store.kind : null,
      oauth: !!this.clientId,
    };
  }

  private save(t: HfToken | null) {
    this.token = t;
    if (t) this.store.set(JSON.stringify(t));
    else this.store.delete();
    this.onChange(this.state());
  }

  async whoami(token: string): Promise<string> {
    const res = await this.fetchFn(`${HF}/api/whoami-v2`, { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 401) throw new Error('Hugging Face did not accept that token.');
    if (!res.ok) throw new Error(`Hugging Face answered ${res.status}. Try again in a moment.`);
    const body = (await res.json()) as { name?: string };
    return body.name ?? 'your account';
  }

  /** Paste a token: checked with Hugging Face before it is kept. */
  async setToken(raw: string): Promise<HfState> {
    const token = raw.trim();
    if (!/^hf_[A-Za-z0-9]{20,}$/.test(token))
      throw new Error('That does not look like a Hugging Face token (they start with hf_).');
    const user = await this.whoami(token);
    this.save({ access_token: token, user });
    return this.state();
  }

  unlink(): HfState {
    this.save(null);
    return this.state();
  }

  /** Step 1 of browser sign-in: the URL to open. `redirect` is this server's own callback on a loopback address. */
  beginOAuth(redirect: string): string {
    if (!this.clientId)
      throw new Error('Sign in with Hugging Face is not set up in this build; paste a token instead.');
    const verifier = b64url(randomBytes(48));
    const state = b64url(randomBytes(24));
    for (const [k, v] of this.pending) if (Date.now() - v.at > 10 * 60_000) this.pending.delete(k);
    this.pending.set(state, { verifier, redirect, at: Date.now() });
    const u = new URL(`${HF}/oauth/authorize`);
    u.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirect,
      response_type: 'code',
      scope: HF_SCOPES,
      state,
      code_challenge: b64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
    }).toString();
    return u.toString();
  }

  /** Step 2: Hugging Face sent the browser back with a code. */
  async finishOAuth(state: string, code: string): Promise<HfState> {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || Date.now() - p.at > 10 * 60_000) throw new Error('That sign-in link expired. Start again.');
    const tok = await this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: p.redirect,
      code_verifier: p.verifier,
    });
    this.save(tok);
    return this.state();
  }

  /** Sign in from another device: shows a short code to enter at huggingface.co. */
  async beginDevice(): Promise<DeviceStart> {
    if (!this.clientId)
      throw new Error('Sign in with Hugging Face is not set up in this build; paste a token instead.');
    const res = await this.fetchFn(`${HF}/oauth/device`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId, scope: HF_SCOPES }),
    });
    if (!res.ok) throw new Error(`Hugging Face answered ${res.status}. Try again in a moment.`);
    const d = (await res.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      verification_uri_complete?: string;
      interval?: number;
      expires_in: number;
    };
    if (this.device?.timer) clearTimeout(this.device.timer);
    this.device = {
      code: d.device_code,
      interval: (d.interval ?? 5) * 1000,
      until: Date.now() + d.expires_in * 1000,
    };
    this.pollDevice();
    return {
      userCode: d.user_code,
      verificationUri: d.verification_uri_complete ?? d.verification_uri,
      expiresIn: d.expires_in,
    };
  }

  private pollDevice() {
    const dev = this.device;
    if (!dev) return;
    dev.timer = setTimeout(async () => {
      if (this.device !== dev || Date.now() > dev.until) return;
      try {
        const tok = await this.tokenRequest({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: dev.code,
        });
        this.device = null;
        this.save(tok);
      } catch (e) {
        const code = (e as { oauth?: string }).oauth;
        if (code === 'slow_down') dev.interval += 5000;
        if (code === 'authorization_pending' || code === 'slow_down') this.pollDevice();
        else this.device = null;
      }
    }, dev.interval);
    dev.timer.unref?.();
  }

  private async tokenRequest(params: Record<string, string>): Promise<HfToken> {
    const res = await this.fetchFn(`${HF}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId!, ...params }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !body.access_token) {
      const err = new Error(body.error_description ?? 'Hugging Face did not finish the sign-in.') as Error & {
        oauth?: string;
      };
      err.oauth = body.error;
      throw err;
    }
    const user = await this.userinfo(body.access_token);
    return {
      access_token: body.access_token,
      refresh_token: body.refresh_token ?? params.refresh_token,
      expires_at: body.expires_in ? Date.now() + body.expires_in * 1000 : undefined,
      user,
    };
  }

  private async userinfo(token: string): Promise<string> {
    const res = await this.fetchFn(`${HF}/oauth/userinfo`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return 'your account';
    const u = (await res.json()) as { preferred_username?: string; name?: string };
    return u.preferred_username ?? u.name ?? 'your account';
  }

  /** A usable token for a download, refreshed if it is about to expire. */
  async accessToken(): Promise<string | null> {
    if (!this.token) return this.fromEnv();
    const t = this.token;
    if (t.expires_at && t.expires_at - Date.now() < 60_000 && t.refresh_token && this.clientId) {
      try {
        this.save(await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token }));
      } catch {
        this.save(null);
        return null;
      }
    }
    return this.token?.access_token ?? null;
  }

  /** Can this account read this file? 'ok', 'needs-license' (gated, not accepted), or 'needs-login'. */
  async access(
    repo: string,
    revision: string,
    path: string,
  ): Promise<'ok' | 'needs-license' | 'needs-login' | 'missing'> {
    const token = await this.accessToken();
    const res = await this.fetchFn(
      `${HF}/${repo}/resolve/${revision}/${path.split('/').map(encodeURIComponent).join('/')}`,
      {
        method: 'HEAD',
        redirect: 'manual',
        headers: token ? { authorization: `Bearer ${token}` } : {},
      },
    );
    if (res.status === 200 || (res.status >= 300 && res.status < 400)) return 'ok';
    if (res.status === 401) return token ? 'needs-license' : 'needs-login';
    if (res.status === 403) return 'needs-license';
    return 'missing';
  }
}
