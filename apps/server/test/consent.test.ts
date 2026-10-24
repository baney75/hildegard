// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConsentSigner, checkCertificate, consentLine, cosine, heardLine, words } from '../src/consent.ts';

describe('the consent line', () => {
  const line = consentLine('Zoë Ann', () => 0);

  it('names the speaker and ends with four random words', () => {
    expect(line.text).toBe(
      'My name is Zoë Ann. I agree that Hildegard may make a copy of my voice. amber anchor apple arrow.',
    );
    expect(line.challenge).toEqual(['amber', 'anchor', 'apple', 'arrow']);
  });

  it('is heard when Whisper writes it with other punctuation and casing, or a name spelled its own way', () => {
    const h = heardLine(
      line,
      'My name is Zoe Anne, I agree that Hildegard may make a copy of my voice: Amber, anchor, apple, arrow!',
    );
    expect(h.missing).toEqual([]);
    expect(h.score).toBeGreaterThan(0.85);
  });

  it('isn’t heard without every random word, or in another order', () => {
    expect(
      heardLine(
        line,
        'My name is Zoë Ann. I agree that Hildegard may make a copy of my voice. amber anchor apple.',
      ).missing,
    ).toEqual(['arrow']);
    const shuffled = heardLine(
      line,
      'arrow apple anchor amber voice my of copy a make may Hildegard that agree I Ann Zoë is name My',
    );
    expect(shuffled.score).toBeLessThan(0.3);
  });

  it('compares words without accents or punctuation', () => {
    expect(words('Zoë, ÉCOLE—café!')).toEqual(['zoe', 'ecole', 'cafe']);
  });
});

describe('speaker likeness', () => {
  it('is 1 for the same direction and 0 for none', () => {
    expect(cosine([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([], [])).toBe(0);
  });
});

describe('certificates', () => {
  it('are signed by a key the install keeps to itself, and anyone can check them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hg-cert-'));
    const s = new ConsentSigner(dir);
    if (process.platform !== 'win32')
      expect(statSync(join(dir, 'voice', 'consent-key.pem')).mode & 0o077).toBe(0);
    // The same key next time.
    expect(new ConsentSigner(dir).fingerprint).toBe(s.fingerprint);
    const c = s.sign({
      voice: 'clone-1',
      speaker: 'Ada',
      relation: 'self',
      line: 'x',
      via: 'here',
      recordedAt: '2026-10-24T00:00:00Z',
      until: null,
      consentSha256: 'a'.repeat(64),
      samplesSha256: [],
      match: 0.9,
      heard: 1,
    });
    expect(checkCertificate(c, s.fingerprint)).toEqual({ valid: true, ours: true });
    expect(
      checkCertificate(c, new ConsentSigner(mkdtempSync(join(tmpdir(), 'hg-cert-'))).fingerprint),
    ).toEqual({
      valid: true,
      ours: false,
    });
    expect(
      checkCertificate({ ...c, signature: c.signature.replace(/^./, (x) => (x === 'A' ? 'B' : 'A')) }).valid,
    ).toBe(false);
  });
});
