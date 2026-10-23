// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HfLink, keychainStore, secretStores } from '../src/hf.ts';
import { fakeFetch, memoryStore } from './helpers.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const TOKEN = 'hf_abcdefghijklmnopqrstuvwxyz123456';

describe('HfLink', () => {
  it('checks a pasted token with Hugging Face before keeping it', async () => {
    const store = memoryStore();
    const fetch = fakeFetch([['GET /api/whoami-v2', () => json({ name: 'donovan' })]]);
    const onChange = vi.fn();
    const hf = new HfLink({ store, clientId: null, onChange, fetch });
    const s = await hf.setToken(`  ${TOKEN}\n`);
    expect(s).toEqual({ linked: true, user: 'donovan', storage: 'keychain', oauth: false });
    expect(JSON.parse(store.value!).access_token).toBe(TOKEN);
    expect(fetch.calls[0]!.init.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
    expect(onChange).toHaveBeenCalledOnce();
    expect(await hf.accessToken()).toBe(TOKEN);
  });

  it('refuses something that is not a token, and a token Hugging Face rejects', async () => {
    const fetch = fakeFetch([['GET /api/whoami-v2', () => json({}, 401)]]);
    const hf = new HfLink({ store: memoryStore(), clientId: null, onChange: () => {}, fetch });
    await expect(hf.setToken('password123')).rejects.toThrow(/start with hf_/);
    await expect(hf.setToken(TOKEN)).rejects.toThrow(/did not accept/);
    expect(hf.state().linked).toBe(false);
  });

  it('unlinks and forgets the token', async () => {
    const store = memoryStore(JSON.stringify({ access_token: TOKEN, user: 'd' }));
    const hf = new HfLink({ store, clientId: null, onChange: () => {} });
    expect(hf.state().user).toBe('d');
    hf.unlink();
    expect(store.value).toBeNull();
    expect(hf.state().linked).toBe(false);
  });

  it('signs in with PKCE: the verifier matches the challenge, and the state is single-use', async () => {
    let sentVerifier = '';
    const fetch = fakeFetch([
      [
        'POST /oauth/token',
        (_u, init) => {
          const body = new URLSearchParams(String(init.body));
          sentVerifier = body.get('code_verifier')!;
          expect(body.get('grant_type')).toBe('authorization_code');
          expect(body.get('redirect_uri')).toBe('http://127.0.0.1:7341/api/hf/callback');
          return json({ access_token: 'hf_oauth_access', refresh_token: 'r1', expires_in: 3600 });
        },
      ],
      ['GET /oauth/userinfo', () => json({ preferred_username: 'donovan' })],
    ]);
    const hf = new HfLink({ store: memoryStore(), clientId: 'client-1', onChange: () => {}, fetch });
    const url = new URL(hf.beginOAuth('http://127.0.0.1:7341/api/hf/callback'));
    expect(url.origin + url.pathname).toBe('https://huggingface.co/oauth/authorize');
    expect(url.searchParams.get('scope')).toBe('openid profile gated-repos');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const state = url.searchParams.get('state')!;
    const s = await hf.finishOAuth(state, 'code-1');
    expect(s.user).toBe('donovan');
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(sentVerifier).digest('base64url')).toBe(
      url.searchParams.get('code_challenge'),
    );
    await expect(hf.finishOAuth(state, 'code-1')).rejects.toThrow(/expired/);
  });

  it('refreshes an access token that is about to expire', async () => {
    const store = memoryStore(
      JSON.stringify({ access_token: 'old', refresh_token: 'r1', expires_at: Date.now() + 1000, user: 'd' }),
    );
    const fetch = fakeFetch([
      [
        'POST /oauth/token',
        (_u, init) => {
          expect(new URLSearchParams(String(init.body)).get('grant_type')).toBe('refresh_token');
          return json({ access_token: 'new', expires_in: 3600 });
        },
      ],
      ['GET /oauth/userinfo', () => json({ preferred_username: 'd' })],
    ]);
    const hf = new HfLink({ store, clientId: 'client-1', onChange: () => {}, fetch });
    expect(await hf.accessToken()).toBe('new');
    expect(JSON.parse(store.value!).refresh_token).toBe('r1');
  });

  it('signs in from another device with a code, waiting while the person approves', async () => {
    vi.useFakeTimers();
    try {
      let polls = 0;
      const fetch = fakeFetch([
        [
          'POST /oauth/device',
          () =>
            json({
              device_code: 'dc',
              user_code: 'ABCD-EFGH',
              verification_uri: 'https://huggingface.co/oauth/device',
              interval: 1,
              expires_in: 600,
            }),
        ],
        [
          'POST /oauth/token',
          () =>
            ++polls < 3
              ? json({ error: 'authorization_pending' }, 400)
              : json({ access_token: 'hf_dev', expires_in: 3600 }),
        ],
        ['GET /oauth/userinfo', () => json({ preferred_username: 'donovan' })],
      ]);
      const onChange = vi.fn();
      const hf = new HfLink({ store: memoryStore(), clientId: 'client-1', onChange, fetch });
      const start = await hf.beginDevice();
      expect(start.userCode).toBe('ABCD-EFGH');
      await vi.advanceTimersByTimeAsync(3500);
      expect(polls).toBe(3);
      expect(hf.state()).toMatchObject({ linked: true, user: 'donovan' });
      expect(onChange).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('says why a gated file cannot be read', async () => {
    const fetch = fakeFetch([
      ['HEAD /resolve/', (u) => new Response(null, { status: u.includes('open') ? 302 : 403 })],
    ]);
    const hf = new HfLink({
      store: memoryStore(JSON.stringify({ access_token: TOKEN, user: 'd' })),
      clientId: null,
      onChange: () => {},
      fetch,
    });
    expect(await hf.access('org/open', 'main', 'a.safetensors')).toBe('ok');
    expect(await hf.access('org/gated', 'main', 'a.safetensors')).toBe('needs-license');
  });
});

describe('secret stores', () => {
  // A keyring whose reads work and writes fail, as on a Linux box whose Secret Service has no unlocked collection.
  const keyring = (writes: boolean) => async () =>
    ({
      Entry: class {
        getPassword() {
          return null;
        }
        setPassword() {
          if (!writes) throw new Error("Couldn't access platform storage: KeyRevoked");
        }
        deletePassword() {}
      },
    }) as never;

  it('use files when the keychain reads but won’t take a write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hg-secrets-'));
    expect(await keychainStore('huggingface', {}, keyring(false))).toBeNull();
    const store = (await secretStores(dir, {}, keyring(false)))('choir-parish1');
    expect(store.kind).toBe('file');
    store.set('key');
    expect(store.get()).toBe('key');
  });

  it('use the keychain when it takes writes', async () => {
    expect((await keychainStore('huggingface', {}, keyring(true)))?.kind).toBe('keychain');
    expect((await secretStores('/nowhere', {}, keyring(true)))('choir-parish1').kind).toBe('keychain');
  });
});
