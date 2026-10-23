// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hashPassphrase,
  Limiter,
  People,
  PeopleError,
  passphraseProblem,
  SESSION,
  verifyPassphrase,
} from '../src/people.ts';

const PASS = 'correct horse battery';
const clock = (start = Date.parse('2026-10-01T12:00:00Z')) => {
  const c = { t: start, now: () => c.t, add: (ms: number) => (c.t += ms) };
  return c;
};
const fresh = (now?: () => number) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hg-people-'));
  return { dataDir, people: new People({ dataDir, now }) };
};

describe('passphrases', () => {
  it('hashes with scrypt and a fresh salt, and checks in constant time', async () => {
    const a = await hashPassphrase(PASS);
    const b = await hashPassphrase(PASS);
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(await verifyPassphrase(PASS, a)).toBe(true);
    expect(await verifyPassphrase(`${PASS}!`, a)).toBe(false);
    expect(await verifyPassphrase('', a)).toBe(false);
  });

  it('treats a damaged or hostile hash as no match, without asking for huge memory', async () => {
    const good = await hashPassphrase(PASS);
    const parts = good.split('$');
    for (const bad of [
      '',
      'plain',
      `bcrypt$${parts.slice(1).join('$')}`,
      ['scrypt', 2 ** 30, 8, 1, parts[4], parts[5]].join('$'),
      ['scrypt', 1000, 8, 1, parts[4], parts[5]].join('$'),
      ['scrypt', 32768, 8, 1, parts[4], 'AAAA'].join('$'),
    ])
      expect(await verifyPassphrase(PASS, bad)).toBe(false);
  });

  it('asks for at least ten characters', () => {
    expect(passphraseProblem('short')).toMatch(/at least 10/);
    expect(passphraseProblem(PASS)).toBeNull();
    expect(passphraseProblem('x'.repeat(300))).toMatch(/under 256/);
  });
});

describe('the owner and invites', () => {
  it('makes the owner once, and lets the same name set a new passphrase, signing them out', async () => {
    const { people } = fresh();
    expect(people.hasOwner()).toBe(false);
    expect((await people.setOwner('Donovan', PASS)).created).toBe(true);
    await expect(people.setOwner('Someone else', PASS)).rejects.toThrow(/already has an owner, Donovan/);
    const s = (await people.signIn('donovan', PASS))!;
    expect(people.authenticate(s.token)?.person.name).toBe('Donovan');
    expect((await people.setOwner('Donovan', 'a brand new passphrase')).created).toBe(false);
    expect(people.authenticate(s.token)).toBeNull();
    expect(await people.signIn('Donovan', PASS)).toBeNull();
    expect(await people.signIn('Donovan', 'a brand new passphrase')).not.toBeNull();
  });

  it('uses an invite once, and never after it expires', async () => {
    const c = clock();
    const { people } = fresh(c.now);
    await people.setOwner('Owner', PASS);
    const { invite, token } = people.invite('director', 2);
    expect(invite.expiresAt).toBe(new Date(c.t + 2 * 3600_000).toISOString());
    expect(people.checkInvite(token)).toMatchObject({ role: 'director' });
    expect(people.checkInvite(`${token.slice(0, -1)}A`)).toBeNull();
    const r = await people.acceptInvite(token, 'Ada', PASS);
    expect(r.person).toMatchObject({ name: 'Ada', role: 'director' });
    expect(people.authenticate(r.token)?.person.name).toBe('Ada');
    await expect(people.acceptInvite(token, 'Ada again', PASS)).rejects.toThrow(/used or has expired/);

    const late = people.invite('owner', 1);
    c.add(3600_000 + 1);
    expect(people.checkInvite(late.token)).toBeNull();
    await expect(people.acceptInvite(late.token, 'Late', PASS)).rejects.toThrow(/used or has expired/);
    expect(people.invites()).toEqual([]);
  });

  it('refuses a taken name without spending the invite', async () => {
    const { people } = fresh();
    await people.setOwner('Owner', PASS);
    const { token } = people.invite('director');
    await expect(people.acceptInvite(token, 'owner', PASS)).rejects.toThrow(/already called/);
    await expect(people.acceptInvite(token, 'Bad<name>', PASS)).rejects.toBeInstanceOf(PeopleError);
    await expect(people.acceptInvite(token, 'Grace', 'short')).rejects.toThrow(/at least 10/);
    expect((await people.acceptInvite(token, 'Grace', PASS)).person.name).toBe('Grace');
  });

  it('keeps only hashes, in files only the owner can read', async () => {
    const { people, dataDir } = fresh();
    await people.setOwner('Owner', PASS);
    const { token } = people.invite('director');
    const s = (await people.signIn('Owner', PASS))!;
    const files = ['people.json', 'sessions.json'].map((f) => join(dataDir, 'people', f));
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      expect(text).not.toContain(token);
      expect(text).not.toContain(s.token);
      expect(text).not.toContain(PASS);
      if (process.platform !== 'win32') expect(statSync(f).mode & 0o077).toBe(0);
    }
  });
});

describe('sessions', () => {
  it('rotates the token hourly, keeps the old one a moment for requests in flight, then refuses it', async () => {
    const c = clock();
    const { people } = fresh(c.now);
    await people.setOwner('Owner', PASS);
    const first = (await people.signIn('Owner', PASS))!.token;
    expect(people.authenticate(first)?.rotated).toBeNull();
    c.add(SESSION.rotateMs);
    const r = people.authenticate(first)!;
    expect(r.rotated).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Still good within the grace period, and it doesn't rotate twice.
    expect(people.authenticate(first)?.rotated).toBeNull();
    expect(people.authenticate(r.rotated!)?.person.name).toBe('Owner');
    c.add(SESSION.graceMs);
    expect(people.authenticate(first)).toBeNull();
    expect(people.authenticate(r.rotated!)?.person.name).toBe('Owner');
    // One device, one session, however often its token changed.
    expect(people.list()[0]!.sessions).toBe(1);
    // An event stream opened with the first token still stands, as the session does.
    expect(people.session(people.authenticate(r.rotated!)!.session)?.name).toBe('Owner');
    const opened = (await people.signIn('Owner', PASS))!.token;
    const id = people.authenticate(opened)!.session;
    c.add(SESSION.rotateMs);
    people.authenticate(opened);
    c.add(SESSION.graceMs);
    expect(people.session(id)?.name).toBe('Owner');
    people.signOut(opened);
    expect(people.session(id)).toBeNull();
  });

  it('ends after a week unused, and after thirty days whatever happens', async () => {
    const c = clock();
    const { people } = fresh(c.now);
    await people.setOwner('Owner', PASS);
    const idle = (await people.signIn('Owner', PASS))!.token;
    c.add(SESSION.idleMs);
    expect(people.authenticate(idle)).toBeNull();

    let token = (await people.signIn('Owner', PASS))!.token;
    for (let d = 0; d < 29; d++) {
      c.add(24 * 3600_000);
      token = people.authenticate(token)?.rotated ?? token;
    }
    expect(people.authenticate(token)).not.toBeNull();
    c.add(24 * 3600_000);
    expect(people.authenticate(token)).toBeNull();
  });

  it('signs out, and removing someone ends every session they have', async () => {
    const { people } = fresh();
    await people.setOwner('Owner', PASS);
    const { token } = people.invite('director');
    const ada = await people.acceptInvite(token, 'Ada', PASS);
    const second = (await people.signIn('Ada', PASS))!.token;
    let changes = 0;
    people.on(() => changes++);
    people.signOut(ada.token);
    expect(people.authenticate(ada.token)).toBeNull();
    expect(people.authenticate(second)).not.toBeNull();
    people.revoke(ada.person.id, null);
    expect(people.authenticate(second)).toBeNull();
    expect(await people.signIn('Ada', PASS)).toBeNull();
    expect(changes).toBe(2);
  });

  it('never leaves this Hildegard without an owner', async () => {
    const { people } = fresh();
    const owner = await people.setOwner('Owner', PASS);
    expect(() => people.revoke(owner.id, null)).toThrow(/only owner/);
    expect(() => people.setRole(owner.id, 'director', null)).toThrow(/only owner/);
    const { token } = people.invite('owner');
    const second = await people.acceptInvite(token, 'Second', PASS);
    expect(() => people.revoke(second.person.id, second.person.id)).toThrow(/yourself/);
    expect(() => people.setRole(second.person.id, 'director', second.person.id)).toThrow(/own role/);
    expect(people.setRole(owner.id, 'director', second.person.id).role).toBe('director');
  });

  it('refuses tokens that aren’t tokens', () => {
    const { people } = fresh();
    for (const t of ['', 'x', 'a'.repeat(43), '../../etc/passwd']) expect(people.authenticate(t)).toBeNull();
  });
});

describe('rate limits', () => {
  it('blocks a key after its failures, says how long, and forgets as the window slides', () => {
    const c = clock();
    const l = new Limiter(3, 60_000, c.now);
    for (let i = 0; i < 3; i++) {
      expect(l.wait('a')).toBe(0);
      l.fail('a');
      c.add(1000);
    }
    expect(l.wait('a')).toBe(57);
    expect(l.wait('b')).toBe(0);
    c.add(57_000);
    expect(l.wait('a')).toBe(0);
    l.fail('a');
    expect(l.wait('a')).toBeGreaterThan(0);
    l.clear('a');
    expect(l.wait('a')).toBe(0);
  });
});
