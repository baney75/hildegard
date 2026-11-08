// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  clip,
  composeText,
  DISCLOSURE,
  lengthOf,
  loadPostSites,
  POST_PLATFORM_IDS,
  POST_TARGETS,
  type PostFacts,
  parsePostSites,
  planPost,
  slug,
  weightedLength,
} from '../src/index.ts';

const ratio = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5 };

describe('what each platform takes', () => {
  it('gives every target the shape it claims, even sizes, and a safe area inside the frame', () => {
    for (const t of POST_TARGETS) {
      expect(t.width / t.height, t.id).toBeCloseTo(ratio[t.aspect], 2);
      expect(t.width % 2 === 0 && t.height % 2 === 0, t.id).toBe(true);
      const s = t.safeArea;
      expect(t.width - s.left - s.right, t.id).toBeGreaterThan(t.width * 0.5);
      expect(t.height - s.top - s.bottom, t.id).toBeGreaterThan(t.height * 0.25);
      expect(t.thumbnail.width / t.thumbnail.height, t.id).toBeCloseTo(t.width / t.height, 2);
    }
  });

  it('matches the specs the platforms publish', () => {
    const t = (id: string) => POST_TARGETS.find((x) => x.id === id)!;
    // YouTube: 16:9 1080p; Shorts, Reels and TikTok: 1080×1920; Instagram feed 4:5; X 16:9 or 1:1 with its limits.
    expect([t('youtube').width, t('youtube').height]).toEqual([1920, 1080]);
    for (const id of ['youtube-shorts', 'instagram-reels', 'tiktok'])
      expect([t(id).width, t(id).height], id).toEqual([1080, 1920]);
    expect([t('instagram-feed').width, t('instagram-feed').height]).toEqual([1080, 1350]);
    expect(t('x').aspect).toBe('16:9');
    expect(t('x-square').aspect).toBe('1:1');
    for (const id of ['x', 'x-square']) {
      expect(t(id).maxSeconds).toBe(140);
      expect(t(id).maxBytes).toBe(512 * 1024 * 1024);
      expect(t(id).text.captionMax).toBe(280);
    }
    expect(t('youtube').text.titleMax).toBe(100);
    expect(t('youtube').thumbnail.maxBytes).toBe(2 * 1024 * 1024);
  });

  it('puts Shorts, Reels and TikTok text clear of the buttons that sit over the bottom of the frame', () => {
    for (const id of ['youtube-shorts', 'instagram-reels', 'tiktok'])
      expect(POST_TARGETS.find((t) => t.id === id)!.safeArea.bottom, id).toBeGreaterThanOrEqual(380);
  });

  it('plans X by the picture’s shape, and says which platforms don’t take pictures', () => {
    const ids = (p: ReturnType<typeof planPost>) => p.targets.map((t) => t.id);
    expect(ids(planPost(['x'], { kind: 'video', width: 1920, height: 1080 }))).toEqual(['x']);
    expect(ids(planPost(['x'], { kind: 'video', width: 1080, height: 1920 }))).toEqual(['x-square']);
    const image = planPost(['youtube', 'instagram', 'x'], { kind: 'image', width: 1024, height: 1024 });
    expect(ids(image)).toEqual(['instagram-feed', 'x-square']);
    expect(image.skipped).toEqual([{ platform: 'youtube', why: 'YouTube takes video here, not pictures.' }]);
    expect(ids(planPost(['youtube', 'instagram'], { kind: 'video', width: 1920, height: 1080 }))).toEqual([
      'youtube',
      'instagram-reels',
    ]);
    expect(
      ids(
        planPost(
          ['youtube', 'instagram'],
          { kind: 'video', width: 1920, height: 1080 },
          { formats: ['youtube-shorts', 'instagram-feed'] },
        ),
      ),
    ).toEqual(['youtube-shorts', 'instagram-feed']);
    const uhd = planPost(['youtube'], { kind: 'video', width: 3840, height: 2160 }, { youtube4k: true });
    expect([uhd.targets[0]!.width, uhd.targets[0]!.height]).toEqual([3840, 2160]);
  });
});

describe('counting characters', () => {
  it('counts as X does: a link is 23, wide characters are 2', () => {
    expect(weightedLength('hello')).toBe(5);
    expect(weightedLength('see https://example.com/a/very/long/path?x=1 now')).toBe(4 + 23 + 4);
    expect(weightedLength('日本')).toBe(4);
    expect(lengthOf('😀', false)).toBe(1);
  });

  it('cuts at a word and ends in an ellipsis, within the limit', () => {
    const out = clip('the quick brown fox jumps over the lazy dog', 20);
    expect(out).toBe('the quick brown fox…');
    expect(lengthOf(out)).toBeLessThanOrEqual(20);
    expect(clip('short', 20)).toBe('short');
    expect(lengthOf(clip('x'.repeat(100), 10))).toBeLessThanOrEqual(10);
  });
});

describe('the words', () => {
  const long = 'A very long line about the film. '.repeat(400);
  const facts: PostFacts = {
    title: 'Morning on the river, a short film about patience and a heron that waits for the light',
    about: long,
    tags: ['#river', 'heron life', 'short film', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
    link: 'https://example.com/film',
  };

  it('stays inside every platform’s limits, whatever the person gave', () => {
    for (const t of POST_TARGETS) {
      const text = composeText(facts, t);
      expect(text.length, t.id).toBeLessThanOrEqual(t.text.captionMax);
      expect(lengthOf(text.caption, t.text.weighted), t.id).toBeLessThanOrEqual(t.text.captionMax);
      if (t.text.titleMax != null) expect(lengthOf(text.title!), t.id).toBeLessThanOrEqual(t.text.titleMax);
      else expect(text.title, t.id).toBeNull();
      expect(text.hashtags.length, t.id).toBeLessThanOrEqual(t.text.hashtagsMax);
    }
  });

  it('cuts the description before the title, the AI note or the link, and says so', () => {
    const x = composeText(facts, POST_TARGETS.find((t) => t.id === 'x')!);
    expect(x.caption).toContain(DISCLOSURE);
    expect(x.caption).toContain('https://example.com/film');
    expect(x.caption.startsWith('Morning on the river')).toBe(true);
    expect(x.notes.join(' ')).toMatch(/X.*description/);
  });

  it('uses only what the person gave: their tags, their words, one note that it is AI-made', () => {
    const t = POST_TARGETS.find((x) => x.id === 'instagram-reels')!;
    const bare = composeText({ title: 'Dawn' }, t);
    expect(bare.caption).toBe(`Dawn\n\n${DISCLOSURE}\n\n#AIGenerated`);
    expect(bare.hashtags).toEqual(['AIGenerated']);
    const own = composeText({ title: 'Dawn', tags: ['#Lighthouse', 'lighthouse', 'sea side!'] }, t);
    expect(own.hashtags).toEqual(['Lighthouse', 'seaside', 'AIGenerated']);
    const off = composeText({ title: 'Dawn', disclose: false }, t);
    expect(off.caption).toBe('Dawn');
  });

  it('gives YouTube and Reddit a separate title, and Reddit no hashtags', () => {
    const yt = composeText(
      { title: 'Dawn', about: 'Light on the sea.' },
      POST_TARGETS.find((t) => t.id === 'youtube')!,
    );
    expect(yt.title).toBe('Dawn');
    expect(yt.caption).toBe(`Light on the sea.\n\n${DISCLOSURE}\n\n#AIGenerated`);
    const rd = composeText({ title: 'Dawn', tags: ['sea'] }, POST_TARGETS.find((t) => t.id === 'reddit')!);
    expect(rd.hashtags).toEqual([]);
    expect(rd.notes.join(' ')).toMatch(/doesn’t use hashtags|doesn't use hashtags/);
  });

  it('makes file names from titles', () => {
    expect(slug('Morning on the river!')).toBe('morning-on-the-river');
    expect(slug('Café, été')).toBe('cafe-ete');
    expect(slug('日本')).toBe('post');
  });
});

describe('the sites', () => {
  it('names every platform once, with its pages on its own domains', () => {
    const sites = loadPostSites();
    expect(sites.map((s) => s.id).sort()).toEqual([...POST_PLATFORM_IDS].sort());
  });

  it('opens YouTube in the system browser and the others in the app', () => {
    const sites = loadPostSites();
    expect(sites.filter((s) => s.opensIn === 'browser').map((s) => s.id)).toEqual(['youtube']);
  });

  it('refuses a page that is off its own domains, and a site named twice', () => {
    const base = {
      id: 'x',
      name: 'X',
      home: 'https://x.com/',
      post: 'https://evil.example/',
      domains: ['x.com'],
      auth: [],
      opensIn: 'app',
    };
    expect(() => parsePostSites(JSON.stringify({ sites: [base] }))).toThrow(/not on its domains/);
    expect(() =>
      parsePostSites(
        JSON.stringify({
          sites: [
            { ...base, post: 'https://x.com/p' },
            { ...base, post: 'https://x.com/p' },
          ],
        }),
      ),
    ).toThrow(/defined twice/);
    expect(() => parsePostSites(JSON.stringify({ sites: [{ ...base, post: 'http://x.com/' }] }))).toThrow();
  });

  it('takes a sign-in entry as a domain, or a host and a path ending in /', () => {
    const base = {
      id: 'x',
      name: 'X',
      home: 'https://x.com/',
      post: 'https://x.com/p',
      domains: ['x.com'],
      opensIn: 'app',
    };
    const parse = (auth: string[]) => parsePostSites(JSON.stringify({ sites: [{ ...base, auth }] }));
    expect(parse(['hcaptcha.com', 'www.google.com/recaptcha/'])[0]!.auth).toHaveLength(2);
    for (const bad of [
      'www.google.com/recaptcha',
      'www.google.com/',
      'www.google.com/../x/',
      'https://www.google.com/recaptcha/',
      'www.google.com/recaptcha/?x/',
      'localhost',
    ])
      expect(() => parse([bad]), bad).toThrow();
  });
});
