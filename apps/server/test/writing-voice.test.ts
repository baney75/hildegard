// SPDX-License-Identifier: AGPL-3.0-only
// A writer's own voice: per person, 0600 files, history kept, limits, the phrases cut found, and nobody reads or
// changes another person's, over REST and over the remote MCP route.
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { directorMay } from '../src/access.ts';
import { diffPhrases, WRITING_LIMITS, WritingError, WritingStore } from '../src/writing.ts';
import { boot, type Harness, PASS, textOf } from './harness.ts';

let h: Harness;
let ada: { name: string; cookie: string };
let bo: { name: string; cookie: string };
let adaId: string;
let boId: string;

const call = async (
  c: Awaited<ReturnType<Harness['mcpFor']>>,
  name: string,
  args: Record<string, unknown> = {},
) => (await c.callTool({ name, arguments: args })) as CallToolResult;
const voiceOf = async (cookie?: string, query = '') =>
  (
    await (cookie === undefined
      ? h.local(`/api/writing/voice${query}`)
      : h.as(cookie, `/api/writing/voice${query}`))
  ).json() as Promise<{
    person: string;
    voice: { md: string; versions: number; updatedAt: string | null };
    samples: { id: string; title: string; words: number }[];
    edits: { removed: string[]; added: string[] }[];
    topCut: { phrase: string; count: number }[];
  }>;

beforeAll(async () => {
  h = await boot('voice');
  ada = await h.director('Ada');
  bo = await h.director('Bo');
  const people = (await (await h.local('/api/people')).json()) as { people: { id: string; name: string }[] };
  adaId = people.people.find((p) => p.name === 'Ada')!.id;
  boId = people.people.find((p) => p.name === 'Bo')!.id;
}, 30_000);
afterAll(() => h.close());

describe('the phrases cut', () => {
  it('finds whole sentences cut and the words inside a rewrite', () => {
    const got = diffPhrases(
      'We will delve into the rich tapestry of local history. The harbour opens at six. It is a testament to the town. Come early.',
      'We will look at the history of local people. The harbour opens at six. Come early. Bring a coat.',
    );
    expect(got.removed).toEqual(
      expect.arrayContaining(['delve into', 'rich tapestry', 'It is a testament to the town']),
    );
    expect(got.added).toEqual(expect.arrayContaining(['look at', 'Bring a coat']));
    expect(got.removed).not.toContain('The harbour opens at six');
  });
  it('finds nothing when nothing changed, and keeps phrases short and distinct', () => {
    expect(diffPhrases('Same words here. Again.', 'Same words here. Again.')).toEqual({
      removed: [],
      added: [],
    });
    const long = diffPhrases(`${'word '.repeat(60)}.`, 'Gone.');
    expect(long.removed[0]!.split(' ').length).toBeLessThanOrEqual(12);
    expect(new Set(long.removed.map((x) => x.toLowerCase())).size).toBe(long.removed.length);
  });
});

describe('the size of an edit', () => {
  const LINES = (n: number, tag: string) =>
    Array.from({ length: n }, (_, i) => `${tag} line ${i}.`).join('\n');
  /** The least CPU time of three runs, in ms: a busy computer delays a run, it doesn't make the work bigger. */
  const timed = <T>(f: () => T) => {
    let best = Number.POSITIVE_INFINITY;
    let out!: T;
    for (let i = 0; i < 3; i++) {
      const t = process.cpuUsage();
      out = f();
      const d = process.cpuUsage(t);
      best = Math.min(best, (d.user + d.system) / 1000);
    }
    return { out, ms: best };
  };

  it('finishes quickly on a draft and a final at the limits', () => {
    const cap = WRITING_LIMITS.editSentences;
    // Every sentence different: the worst case for the sentence comparison.
    const draft = LINES(cap, 'draft');
    const final = LINES(cap, 'final');
    expect(draft.length).toBeLessThanOrEqual(WRITING_LIMITS.editChars);
    const { out, ms } = timed(() => diffPhrases(draft, final));
    expect(ms).toBeLessThan(200);
    expect(out.removed.length).toBeGreaterThan(0);
    // One long rewritten stretch of words, at the character limit.
    const wordy = (tag: string) =>
      `${Array.from({ length: 4500 }, (_, i) => `${tag}${i}`).join(' ')}.`.slice(0, 29_000);
    const long = timed(() => diffPhrases(wordy('a'), wordy('b')));
    expect(long.ms).toBeLessThan(200);
  });

  it('refuses a draft or a final past the limits, before comparing anything', () => {
    const refused = (draft: string, final: string) =>
      timed(() => {
        try {
          diffPhrases(draft, final);
        } catch (e) {
          expect(e).toBeInstanceOf(WritingError);
          expect((e as WritingError).status).toBe(413);
          expect((e as WritingError).message).toMatch(/Cut it into|Send/);
          return true;
        }
        throw new Error('was not refused');
      }).ms;
    const big = 'x'.repeat(WRITING_LIMITS.editChars + 1);
    expect(refused(big, 'ok.')).toBeLessThan(50);
    expect(refused('ok.', big)).toBeLessThan(50);
    // Under the character limit but too many sentences.
    const many = 'a. '.repeat(WRITING_LIMITS.editSentences + 1);
    expect(many.length).toBeLessThan(WRITING_LIMITS.editChars);
    expect(refused(many, 'ok.')).toBeLessThan(50);
    expect(refused('ok.', many)).toBeLessThan(50);
    // 50,000 one-word sentences.
    expect(refused('a. '.repeat(50_000), 'b. '.repeat(50_000))).toBeLessThan(50);
  });

  it('tells the agent over REST what to do', async () => {
    const res = await h.as(bo.cookie, '/api/writing/edits', 'POST', {
      draft: 'a. '.repeat(50_000),
      final: 'b. '.repeat(50_000),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: 'size', error: expect.stringMatching(/30,000|1,500/) });
  });
});

describe('the store', () => {
  const fresh = (limits?: { editLines?: number }) => {
    const dir = mkdtempSync(join(tmpdir(), 'hg-writing-store-'));
    let t = Date.parse('2026-11-07T12:00:00Z');
    return {
      dir,
      store: new WritingStore(
        dir,
        () => {
          t += 1000;
          return new Date(t);
        },
        limits,
      ),
    };
  };

  it('keeps every replaced voice in history, the last 20', () => {
    const { dir, store } = fresh();
    store.setVoice('p1', 'one');
    expect(existsSync(join(dir, 'p1', 'history'))).toBe(false);
    store.setVoice('p1', 'two');
    expect(readdirSync(join(dir, 'p1', 'history'))).toHaveLength(1);
    expect(
      readFileSync(join(dir, 'p1', 'history', readdirSync(join(dir, 'p1', 'history'))[0]!), 'utf8'),
    ).toBe('one');
    for (let i = 3; i <= 30; i++) store.setVoice('p1', `v${i}`);
    const kept = readdirSync(join(dir, 'p1', 'history')).sort();
    expect(kept).toHaveLength(WRITING_LIMITS.history);
    expect(kept.every((f) => /^voice-\d{4}-\d{2}-\d{2}T[\d-]+Z(-\d+)?\.md$/.test(f))).toBe(true);
    // The oldest were dropped: the newest kept is the version before the current one.
    expect(readFileSync(join(dir, 'p1', 'history', kept.at(-1)!), 'utf8')).toBe('v29');
    expect(store.voice('p1')).toMatchObject({ md: 'v30', versions: 20 });
  });

  it('keeps folders 0700 and files 0600', () => {
    const { dir, store } = fresh();
    store.setVoice('p1', 'a');
    store.setVoice('p1', 'b');
    store.addSample('p1', { title: 'T', text: 'Some words of mine.' });
    store.recordEdit('p1', { draft: 'A draft.', final: 'A final.' });
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? [join(d, e.name), ...walk(join(d, e.name))] : [join(d, e.name)],
      );
    if (process.platform !== 'win32') {
      for (const p of [join(dir, 'p1'), ...walk(join(dir, 'p1'))]) {
        const mode = statSync(p).mode & 0o777;
        expect(mode, p).toBe(statSync(p).isDirectory() ? 0o700 : 0o600);
      }
    }
    expect(readdirSync(join(dir, 'p1')).sort()).toEqual(['edits.jsonl', 'history', 'samples', 'voice.md']);
  });

  it('limits a sample to 50,000 characters and a person to 200 samples', () => {
    const { store } = fresh();
    expect(() => store.addSample('p1', { title: 'Big', text: 'a'.repeat(50_001) })).toThrow(WritingError);
    expect(store.addSample('p1', { title: 'Edge', text: 'a'.repeat(50_000) }).words).toBe(1);
    for (let i = 1; i < 200; i++) store.addSample('p1', { title: `s${i}`, text: 'words' });
    expect(store.samples('p1')).toHaveLength(200);
    expect(() => store.addSample('p1', { title: 'one more', text: 'words' })).toThrow(/200 samples/);
    expect(store.samples('p2')).toHaveLength(0);
  });

  it('keeps the newest edits when the file is full, and the cap is 2,000 lines', () => {
    expect(WRITING_LIMITS.editLines).toBe(2000);
    const { dir, store } = fresh({ editLines: 5 });
    for (let i = 1; i <= 8; i++)
      store.recordEdit('p1', { draft: `Draft number ${i}.`, final: `Final number ${i}.`, note: `n${i}` });
    const lines = readFileSync(join(dir, 'p1', 'edits.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(5);
    expect(lines.map((l) => (JSON.parse(l) as { note: string }).note)).toEqual([
      'n4',
      'n5',
      'n6',
      'n7',
      'n8',
    ]);
  });

  it('refuses names that could leave the folder', () => {
    const { store } = fresh();
    for (const bad of ['../x', 'a/b', '', '..', 'x'.repeat(65)])
      expect(() => store.voice(bad), bad).toThrow(WritingError);
    expect(() => store.removeSample('p1', '../../etc/passwd')).toThrow(WritingError);
  });
});

describe('one person’s voice over REST', () => {
  it('belongs to the owner on this computer, and to the signed-in person elsewhere', async () => {
    const put = await h.local('/api/writing/voice', 'PUT', { md: '# Alex\nPlain, short.' });
    expect(put.status).toBe(200);
    const mine = await voiceOf();
    expect(mine.voice.md).toBe('# Alex\nPlain, short.');
    // The same owner signed in elsewhere is the same person.
    expect((await voiceOf(h.owner.cookie)).person).toBe(mine.person);
    expect((await voiceOf(h.owner.cookie)).voice.md).toBe('# Alex\nPlain, short.');
    // A director starts empty.
    expect((await voiceOf(ada.cookie)).voice.md).toBe('');
    expect(await h.as(undefined, '/api/writing/voice')).toHaveProperty('status', 401);
  });

  it('keeps samples, edits and the voice of a director out of everyone else’s sight', async () => {
    expect((await h.as(ada.cookie, '/api/writing/voice', 'PUT', { md: 'Ada writes short.' })).status).toBe(
      200,
    );
    const added = (await (
      await h.as(ada.cookie, '/api/writing/samples', 'POST', {
        title: 'Ada’s letter',
        text: 'Dear all, the roof is done.',
      })
    ).json()) as { sample: { id: string } };
    expect(
      (
        await h.as(ada.cookie, '/api/writing/edits', 'POST', {
          draft: 'We delve into the roof.',
          final: 'We fixed the roof.',
        })
      ).status,
    ).toBe(201);

    const boSees = await voiceOf(bo.cookie);
    expect(boSees).toMatchObject({ voice: { md: '' }, samples: [], edits: [], topCut: [] });
    const ownerSees = await voiceOf();
    expect(ownerSees.voice.md).not.toContain('Ada');
    expect(ownerSees.samples).toHaveLength(0);

    // Bo can't name Ada, read her samples or edits, delete her sample, or write her voice.
    for (const path of ['voice', 'samples', 'edits'])
      expect((await h.as(bo.cookie, `/api/writing/${path}?person=${adaId}`)).status, path).toBe(403);
    expect(
      (await h.as(bo.cookie, `/api/writing/voice?person=${adaId}`, 'PUT', { md: 'Bo was here' })).status,
    ).toBe(403);
    expect((await h.as(bo.cookie, `/api/writing/samples/${added.sample.id}`, 'DELETE')).status).toBe(404);
    expect(
      (await h.as(bo.cookie, `/api/writing/edits?person=${adaId}`, 'POST', { draft: 'a', final: 'b' }))
        .status,
    ).toBe(403);
    expect((await voiceOf(ada.cookie)).voice.md).toBe('Ada writes short.');
    expect((await voiceOf(ada.cookie)).samples).toHaveLength(1);

    // The owner may name a person, and only a real one.
    const named = await voiceOf(h.owner.cookie, `?person=${adaId}`);
    expect(named).toMatchObject({ person: adaId, voice: { md: 'Ada writes short.' } });
    expect((await voiceOf(undefined, `?person=${adaId}`)).voice.md).toBe('Ada writes short.');
    expect((await h.as(h.owner.cookie, '/api/writing/voice?person=nobody-here')).status).toBe(404);
    expect((await h.as(h.owner.cookie, '/api/writing/voice?person=../x')).status).toBe(404);
    // Ada naming herself is fine.
    expect((await h.as(ada.cookie, `/api/writing/voice?person=${adaId}`)).status).toBe(200);
  });

  it('gives a person the text of their own sample, and no one else’s', async () => {
    const added = (await (
      await h.as(ada.cookie, '/api/writing/samples', 'POST', {
        title: 'Ada on the bridge',
        text: 'The bridge opens at six. Bring a coat.',
        source: 'her blog',
      })
    ).json()) as { sample: { id: string } };
    const id = added.sample.id;
    const mine = await h.as(ada.cookie, `/api/writing/samples/${id}`);
    expect(mine.status).toBe(200);
    expect(await mine.json()).toMatchObject({
      person: adaId,
      sample: { id, title: 'Ada on the bridge', text: 'The bridge opens at six. Bring a coat.', words: 8 },
    });
    // Bo's own folder has no such sample, and Bo can't name Ada.
    expect((await h.as(bo.cookie, `/api/writing/samples/${id}`)).status).toBe(404);
    expect((await h.as(bo.cookie, `/api/writing/samples/${id}?person=${adaId}`)).status).toBe(403);
    expect((await h.as(undefined, `/api/writing/samples/${id}`)).status).toBe(401);
    // The owner may name Ada, as with everything else here.
    const owner = await h.as(h.owner.cookie, `/api/writing/samples/${id}?person=${adaId}`);
    expect(owner.status).toBe(200);
    expect(((await owner.json()) as { sample: { text: string } }).sample.text).toContain('Bring a coat');
    for (const bad of ['nope', '../voice', 'ffffffffffffffff'])
      expect((await h.as(ada.cookie, `/api/writing/samples/${encodeURIComponent(bad)}`)).status, bad).toBe(
        404,
      );
    expect(directorMay('GET', `/api/writing/samples/${id}`)).toBe(true);
  });

  it('records an edit with the phrases cut and the lint counted', async () => {
    const draft = 'We will delve into the realm of it — and it is robust. The roof is done.';
    const final = 'The roof is done.';
    const res = await h.as(bo.cookie, '/api/writing/edits', 'POST', { draft, final, note: 'Too much.' });
    expect(res.status).toBe(201);
    const { edit } = (await res.json()) as { edit: Record<string, unknown> };
    expect(edit).toMatchObject({ draftWords: 17, finalWords: 4, note: 'Too much.' });
    expect((edit.removed as string[]).join(' | ')).toContain('delve into the realm of it');
    expect((edit.lintBefore as { fails: number }).fails).toBeGreaterThan(0);
    expect(edit.lintAfter).toEqual({ fails: 0, warns: 0 });
    // Twice cut counts twice.
    await h.as(bo.cookie, '/api/writing/edits', 'POST', {
      draft: 'We will delve into the realm of it — and it is robust. Fine.',
      final: 'Fine.',
    });
    const v = await voiceOf(bo.cookie);
    expect(v.edits).toHaveLength(2);
    expect(v.topCut[0]).toMatchObject({ count: 2 });
    const file = join(h.dir, 'writing', boId, 'edits.jsonl');
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('refuses what is too big or empty, and keeps history on every replace', async () => {
    expect(
      (await h.as(bo.cookie, '/api/writing/samples', 'POST', { title: 'Big', text: 'a'.repeat(50_001) }))
        .status,
    ).toBe(422);
    expect((await h.as(bo.cookie, '/api/writing/samples', 'POST', { title: 'Empty', text: '' })).status).toBe(
      422,
    );
    expect((await h.as(bo.cookie, '/api/writing/voice', 'PUT', { md: 'x'.repeat(50_001) })).status).toBe(422);
    await h.as(bo.cookie, '/api/writing/voice', 'PUT', { md: 'first' });
    await h.as(bo.cookie, '/api/writing/voice', 'PUT', { md: 'second' });
    await h.as(bo.cookie, '/api/writing/voice', 'PUT', { md: 'third' });
    expect((await voiceOf(bo.cookie)).voice).toMatchObject({ md: 'third', versions: 2 });
    expect(readdirSync(join(h.dir, 'writing', boId, 'history'))).toHaveLength(2);
  });

  it('lets a director use these and nothing else about the writing routes', () => {
    for (const [m, p] of [
      ['GET', '/api/writing/voice'],
      ['PUT', '/api/writing/voice'],
      ['GET', '/api/writing/samples'],
      ['POST', '/api/writing/samples'],
      ['DELETE', '/api/writing/samples/abc'],
      ['GET', '/api/writing/edits'],
      ['POST', '/api/writing/edits'],
    ] as const)
      expect(directorMay(m, p), `${m} ${p}`).toBe(true);
    expect(directorMay('GET', '/api/writing/lint')).toBe(false);
    expect(directorMay('DELETE', '/api/writing/voice')).toBe(false);
    expect(directorMay('POST', '/api/writing/voice')).toBe(false);
  });
});

describe('the same over the remote MCP route', () => {
  it('gives each person’s agent only that person’s voice', async () => {
    const adaAgent = await h.mcpFor('Ada');
    const boAgent = await h.mcpFor('Bo');
    const added = await call(adaAgent, 'writing_voice_add_sample', {
      title: 'Ada’s MCP sample',
      text: 'A note from Ada about bread.',
    });
    expect(added.isError).toBeFalsy();
    expect(textOf(added)).toContain('Added “Ada’s MCP sample”');
    const rec = await call(adaAgent, 'writing_voice_record_edit', {
      draft: 'We delve into bread. Fine.',
      final: 'Fine.',
      note: 'Plainer',
    });
    expect(textOf(rec)).toContain('delve into bread');
    expect(
      textOf(await call(adaAgent, 'writing_voice_update', { voice_md: 'Ada: bread, short.' })),
    ).toContain('Saved the voice notes');

    const adaRead = textOf(await call(adaAgent, 'writing_voice'));
    expect(adaRead).toContain('Ada: bread, short.');
    expect(adaRead).toContain('Ada’s MCP sample');
    expect(adaRead).toContain('delve into bread');

    const boRead = textOf(await call(boAgent, 'writing_voice'));
    expect(boRead).not.toContain('Ada: bread');
    expect(boRead).not.toContain('Ada’s MCP sample');
    expect(boRead).not.toContain('delve into bread');

    // The owner on this computer sees neither; the samples are on disk in Ada’s folder only.
    expect((await voiceOf()).samples.map((s) => s.title)).not.toContain('Ada’s MCP sample');
    expect(readdirSync(join(h.dir, 'writing', adaId, 'samples')).length).toBeGreaterThan(0);
    expect(
      existsSync(join(h.dir, 'writing', boId, 'samples'))
        ? readdirSync(join(h.dir, 'writing', boId, 'samples')).length
        : 0,
    ).toBe(0);
  });

  it('lets an agent read the text of the saved samples, its own person’s only', async () => {
    const adaAgent = await h.mcpFor('Ada');
    const boAgent = await h.mcpFor('Bo');
    // The index gives ids, so the agent can ask for one.
    const index = textOf(await call(adaAgent, 'writing_voice'));
    expect(index).toMatch(/Ada’s MCP sample.*[a-f0-9]{16}/);
    const all = await call(adaAgent, 'writing_voice_samples');
    expect(all.isError).toBeFalsy();
    const text = textOf(all);
    expect(text).toContain('A note from Ada about bread.');
    expect(text).toContain('The bridge opens at six. Bring a coat.');
    expect(text).not.toMatch(/cut|not shown/i);
    // One by id gets that one only.
    const id = /Ada’s MCP sample.*?([a-f0-9]{16})/.exec(index)![1]!;
    const one = textOf(await call(adaAgent, 'writing_voice_samples', { ids: [id] }));
    expect(one).toContain('A note from Ada about bread.');
    expect(one).not.toContain('Bring a coat');
    // Bo's agent gets nothing of Ada’s, with her id or without.
    expect(textOf(await call(boAgent, 'writing_voice_samples'))).not.toContain('Ada');
    const stolen = await call(boAgent, 'writing_voice_samples', { ids: [id] });
    expect(stolen.isError).toBe(true);
    expect(textOf(stolen)).not.toContain('bread');
  });

  it('gives samples newest first within 20,000 characters, and says what it cut', async () => {
    const cy = await h.director('Cy');
    const agent = await h.mcpFor('Cy');
    for (const [title, tag] of [
      ['Oldest', 'OLDEST'],
      ['Middle', 'MIDDLE'],
      ['Newest', 'NEWEST'],
    ] as const) {
      expect(
        (
          await h.as(cy.cookie, '/api/writing/samples', 'POST', {
            title,
            text: `${tag} ${'Bread rises slowly. '.repeat(750)}`,
          })
        ).status,
      ).toBe(201);
      await new Promise((r) => setTimeout(r, 5));
    }
    const text = textOf(await call(agent, 'writing_voice_samples'));
    expect(text.length).toBeLessThan(21_500);
    expect(text.indexOf('NEWEST')).toBeGreaterThan(-1);
    expect(text.indexOf('NEWEST')).toBeLessThan(text.indexOf('MIDDLE'));
    expect(text).not.toContain('OLDEST');
    expect(text).toMatch(/cut|not shown/i);
    expect(text).toMatch(/writing_voice_samples/);
  });

  it('lists the tools with titles and hints, each saying when to call it', async () => {
    const c = await h.mcpFor('Bo');
    const { tools } = await c.listTools();
    for (const name of [
      'writing_voice',
      'writing_voice_samples',
      'writing_voice_add_sample',
      'writing_voice_record_edit',
      'writing_voice_update',
    ]) {
      const t = tools.find((x) => x.name === name)!;
      expect(t, name).toBeDefined();
      expect(t.annotations?.title, name).toBeTruthy();
      expect(typeof t.annotations?.readOnlyHint, name).toBe('boolean');
      expect(t.description, name).toMatch(/^Call this/);
    }
    expect(tools.find((x) => x.name === 'writing_voice')!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((x) => x.name === 'writing_voice_samples')!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((x) => x.name === 'writing_voice_update')!.annotations?.destructiveHint).toBe(true);
  });
});

describe('a computer with no account yet', () => {
  it('keeps what was written, and gives it to the owner once there is one', async () => {
    const solo = await boot('voice-solo', { owner: false });
    try {
      expect((await solo.local('/api/writing/voice', 'PUT', { md: 'Before any account.' })).status).toBe(200);
      expect(existsSync(join(solo.dir, 'writing', 'local', 'voice.md'))).toBe(true);
      expect((await solo.local('/api/people/owner', 'POST', { name: 'Alex', passphrase: PASS })).status).toBe(
        201,
      );
      const after = (await (await solo.local('/api/writing/voice')).json()) as {
        person: string;
        voice: { md: string };
      };
      expect(after.voice.md).toBe('Before any account.');
      expect(after.person).not.toBe('local');
      expect(existsSync(join(solo.dir, 'writing', 'local'))).toBe(false);
    } finally {
      await solo.close();
    }
  });
});
