// SPDX-License-Identifier: AGPL-3.0-only
// Every skill works when it is the only one there. claude.ai and ChatGPT take one skill folder per zip, so this packs
// the skills the way scripts/pack-skills.mjs does, opens each skill-<name>.zip on its own, and fails when anything the
// skill names (a link, a scripts/ or references/ file, a script another skill ships) is not inside that zip, when a
// file shared between skills differs from its source (skills/SHARED.json), or when a skill names a Hildegard tool and
// never says what to do without Hildegard. It covers every folder in skills/, so a new skill is held to it at once.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  mcpToolNames,
  packedSkills,
  shippedScripts,
  standaloneProblems,
  // @ts-expect-error: plain JavaScript, run by Node with no build
} from '../../../scripts/skill-standalone.mjs';
// @ts-expect-error: plain JavaScript, run by Node with no build
import { copies, drift, sync, syncAll } from '../../../scripts/sync-skill-shared.mjs';

const root = join(import.meta.dirname, '..', '..', '..');
const zips: Map<string, Map<string, Buffer>> = packedSkills(root);
const others: Set<string> = shippedScripts(zips);
const tools: Set<string> = mcpToolNames(root);
const entries = (skill: string, extra: Record<string, string> = {}) =>
  new Map<string, Buffer>(
    Object.entries({
      'demo/SKILL.md': `---\nname: demo\ndescription: ${'Use for a demo thing that exists only to test the checker, with words enough to pass 80 chars.'}\n---\n\n# Demo\n`,
      ...extra,
    }).map(([k, v]) => [k.replace(/^demo\//, `${skill}/`), Buffer.from(v)]),
  );

describe('each skill, opened alone from its own zip', () => {
  it('has a zip for every skill folder, with the skills the plugin names', () => {
    expect([...zips.keys()]).toEqual(
      expect.arrayContaining([
        'hildegard',
        'hildegard-blog',
        'hildegard-design',
        'hildegard-sound',
        'hildegard-video-edit',
      ]),
    );
    for (const [skill, files] of zips) expect(files.has(`${skill}/SKILL.md`)).toBe(true);
  });

  it('names nothing that is not inside it', () => {
    const problems = [...zips].flatMap(([skill, files]) => standaloneProblems(skill, files, others, tools));
    expect(problems).toEqual([]);
  });

  it('hildegard-loop carries every web check of hildegard-web, so the loop works alone', () => {
    const web = zips.get('hildegard-web')?.get('hildegard-web/SKILL.md')?.toString('utf8') ?? '';
    const loop = zips.get('hildegard-loop')?.get('hildegard-loop/SKILL.md')?.toString('utf8') ?? '';
    const table = web.slice(
      web.indexOf('| Check | What fails it |'),
      web.indexOf('Then critique with the web questions'),
    );
    const ids = [...table.matchAll(/`([a-z][a-z-]*)`/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(20);
    for (const id of ids) expect(loop, `check ${id} in hildegard-loop`).toContain(`\`${id}\``);
  });

  it('knows the Hildegard tools, so the "Without Hildegard" rule has something to find', () => {
    expect(tools.has('loop_start')).toBe(true);
    expect(tools.has('hildegard_status')).toBe(true);
  });
});

describe('the files shared between skills (skills/SHARED.json)', () => {
  it('equal their source, in the repository and inside each skill’s zip', () => {
    expect(drift(root)).toEqual([]);
    const { copies: list, problems } = copies(root);
    expect(problems).toEqual([]);
    expect(list.length).toBeGreaterThan(0);
    for (const { source, dest, skill } of list as {
      source: string;
      dest: string;
      skill: string;
    }[]) {
      const inZip = zips.get(skill)?.get(dest.replace(/^skills\//, ''));
      expect(inZip, `${dest} in the ${skill} zip`).toBeDefined();
      expect(inZip?.equals(readFileSync(join(root, source))), `${dest} equals ${source}`).toBe(true);
    }
  });

  it('are the scripts the skills tell a model to run', () => {
    const blog = zips.get('hildegard-blog');
    expect(blog?.has('hildegard-blog/scripts/prose_lint.py')).toBe(true);
    expect(blog?.has('hildegard-blog/scripts/prose_rules.json')).toBe(true);
    expect(zips.get('hildegard-video-edit')?.has('hildegard-video-edit/scripts/duck_mix.py')).toBe(true);
  });

  it('are copied by the sync, and the check fails on a missing or edited copy', () => {
    const repo = mkdtempSync(join(tmpdir(), 'hg-shared-'));
    for (const skill of ['a', 'b']) {
      mkdirSync(join(repo, 'skills', skill), { recursive: true });
      writeFileSync(join(repo, 'skills', skill, 'SKILL.md'), '---\nname: x\n---\n');
    }
    mkdirSync(join(repo, 'tools'), { recursive: true });
    writeFileSync(join(repo, 'tools', 'x.py'), 'print(1)\n');
    const manifest = (c: object) =>
      writeFileSync(join(repo, 'skills', 'SHARED.json'), JSON.stringify({ copies: [c] }));
    manifest({ source: 'tools/x.py', skills: ['a', 'b'] });
    expect(drift(repo)).toEqual([
      expect.stringMatching(/skills\/a\/scripts\/x\.py is missing/),
      expect.stringMatching(/skills\/b\/scripts\/x\.py is missing/),
    ]);
    expect(sync(repo)).toEqual(['skills/a/scripts/x.py', 'skills/b/scripts/x.py']);
    expect(drift(repo)).toEqual([]);
    expect(sync(repo)).toEqual([]);
    writeFileSync(join(repo, 'skills', 'b', 'scripts', 'x.py'), 'print(2)\n');
    expect(drift(repo)).toEqual([
      expect.stringMatching(/skills\/b\/scripts\/x\.py differs from tools\/x\.py/),
    ]);
    expect(sync(repo)).toEqual(['skills/b/scripts/x.py']);
    expect(drift(repo)).toEqual([]);
    manifest({ source: 'tools/nope.py', skills: ['a'] });
    expect(drift(repo).join('\n')).toMatch(/not a file in the repository/);
    manifest({ source: 'tools/x.py', skills: ['nope'] });
    expect(drift(repo).join('\n')).toMatch(/"nope" is not a skill folder/);
    manifest({ source: 'skills/a/SKILL.md', to: '.', skills: ['a'] });
    expect(drift(repo).join('\n')).toMatch(/is its own source/);
    rmSync(repo, { recursive: true, force: true });
  });
});

describe('a manifest that points outside the skills (skills/SHARED.json)', () => {
  it('is refused, and nothing is written outside skills/', () => {
    const parent = mkdtempSync(join(tmpdir(), 'hg-traversal-'));
    const repo = join(parent, 'repo');
    mkdirSync(join(repo, 'skills', 'a'), { recursive: true });
    writeFileSync(join(repo, 'skills', 'a', 'SKILL.md'), '---\nname: a\n---\n');
    mkdirSync(join(repo, 'tools'), { recursive: true });
    writeFileSync(join(repo, 'tools', 'x.py'), 'print(1)\n');
    // A sibling of the repository with a SKILL.md: the old existence check accepted it.
    mkdirSync(join(parent, 'victim'), { recursive: true });
    writeFileSync(join(parent, 'victim', 'SKILL.md'), '---\nname: victim\n---\n');
    mkdirSync(join(repo, 'skills', 'a', 'nested'), { recursive: true });
    writeFileSync(join(repo, 'skills', 'a', 'nested', 'SKILL.md'), 'x');
    const manifest = (c: object) =>
      writeFileSync(join(repo, 'skills', 'SHARED.json'), JSON.stringify({ copies: [c] }));
    for (const skill of ['../../victim', '../skills/a', 'a/nested', '/tmp', 'A', '.', '']) {
      manifest({ source: 'tools/x.py', skills: [skill] });
      expect(drift(repo).join('\n'), `skill "${skill}"`).toMatch(/is not a skill folder/);
      expect(() => sync(repo), `skill "${skill}"`).toThrow(/is not a skill folder/);
    }
    expect(existsSync(join(parent, 'victim', 'scripts'))).toBe(false);
    expect(existsSync(join(parent, 'victim', 'scripts', 'x.py'))).toBe(false);
    expect(existsSync(join(repo, 'skills', 'a', 'nested', 'scripts'))).toBe(false);
    // The source stays inside the repository, even through a symlink.
    symlinkSync(parent, join(repo, 'tools', 'out'));
    writeFileSync(join(parent, 'secret.py'), 'print(2)\n');
    for (const source of ['../secret.py', 'tools/out/secret.py']) {
      manifest({ source, skills: ['a'] });
      expect(drift(repo).join('\n'), `source "${source}"`).toMatch(/not a file in the repository/);
    }
    rmSync(parent, { recursive: true, force: true });
  });
});

describe('the checker itself', () => {
  it('passes a skill that names only what it carries', () => {
    const files = entries('demo', {
      'demo/SKILL.md': `---\nname: demo\ndescription: ${'Use for a demo thing that exists only to test the checker, with words enough to pass 80 chars.'}\n---\n\nRun scripts/go.py, see [the notes](references/notes.md).\n`,
      'demo/scripts/go.py': 'print(1)\n',
      'demo/references/notes.md': '# Notes\n',
    });
    expect(standaloneProblems('demo', files, new Set(), new Set())).toEqual([]);
  });

  it('fails a link, a script, a reference or a template that is not in the zip', () => {
    const files = entries('demo', {
      'demo/SKILL.md': `---\nname: demo\ndescription: ${'Use for a demo thing that exists only to test the checker, with words enough to pass 80 chars.'}\n---\n\nSee [x](references/gone.md), run scripts/gone.py and open templates/gone/index.html.\n`,
    });
    const p = standaloneProblems('demo', files);
    expect(p.join('\n')).toMatch(/link references\/gone\.md/);
    expect(p.join('\n')).toMatch(/names scripts\/gone\.py/);
    expect(p.join('\n')).toMatch(/names templates\/gone\/index\.html/);
  });

  it('fails a path into another skill, out of the folder, or into the repository’s docs', () => {
    const files = entries('demo', {
      'demo/SKILL.md': `---\nname: demo\ndescription: ${'Use for a demo thing that exists only to test the checker, with words enough to pass 80 chars.'}\n---\n\nRead ../hildegard/references/blog.md, skills/other/SKILL.md, docs/agents.md and THIRD_PARTY_NOTICES.md.\n`,
    });
    const p = standaloneProblems('demo', files).join('\n');
    expect(p).toMatch(/\.\.\//);
    expect(p).toMatch(/skills\/<name>\//);
    expect(p).toMatch(/names docs\/agents\.md/);
    expect(p).toMatch(/names THIRD_PARTY_NOTICES\.md/);
    // A URL to the same page is fine.
    const ok = entries('demo', {
      'demo/SKILL.md': `---\nname: demo\ndescription: ${'Use for a demo thing that exists only to test the checker, with words enough to pass 80 chars.'}\n---\n\nSee https://github.com/baney75/hildegard/blob/main/docs/agents.md.\n`,
    });
    expect(standaloneProblems('demo', ok)).toEqual([]);
  });

  it('fails a script another skill ships, named here without a copy', () => {
    const files = entries('demo', {
      'demo/SKILL.md': `---\nname: demo\ndescription: ${'Use for a demo thing that exists only to test the checker, with words enough to pass 80 chars.'}\n---\n\nRun contact_sheet.py on the frames (install: python3 -m pip install pillow numpy av).\n`,
    });
    expect(standaloneProblems('demo', files, new Set(['contact_sheet.py'])).join('\n')).toMatch(
      /contact_sheet\.py/,
    );
    files.set('demo/scripts/contact_sheet.py', Buffer.from('x'));
    expect(standaloneProblems('demo', files, new Set(['contact_sheet.py']))).toEqual([]);
  });

  it('requires the install line wherever a skill names a script that needs Pillow, numpy or PyAV', () => {
    const body = (text: string) =>
      entries('demo', {
        'demo/SKILL.md': `---\nname: demo\ndescription: ${'Use for a demo thing that exists only to test the checker, with words enough to pass 80 chars.'}\n---\n\n${text}\n`,
        'demo/scripts/review_media.py': 'x',
      });
    expect(
      standaloneProblems('demo', body('Run python3 scripts/review_media.py spec.json.')).join('\n'),
    ).toMatch(/review_media\.py, which needs Python packages, but never gives the line/);
    expect(standaloneProblems('demo', body('Run scripts/contact_sheet.py a.png.')).join('\n')).toMatch(
      /contact_sheet\.py, which needs Python packages/,
    );
    // The scripts that need only Python and FFmpeg are not held to it.
    expect(standaloneProblems('demo', body('Run check_video.py on out.mp4.'))).toEqual([]);
    expect(
      standaloneProblems(
        'demo',
        body('Run scripts/review_media.py spec.json (first: `python3 -m pip install pillow numpy av`).'),
      ),
    ).toEqual([]);
  });

  it('fails a dependency on another skill’s check list, reference, template or script', () => {
    const body = (text: string) =>
      entries('demo', {
        'demo/SKILL.md': `---\nname: demo\ndescription: ${'Use for a demo thing that exists only to test the checker, with words enough to pass 80 chars.'}\n---\n\n${text}\n`,
      });
    expect(
      standaloneProblems('demo', body("Go through the **hildegard-web** skill's check list.")).join('\n'),
    ).toMatch(/hildegard-web skill's check list/);
    expect(
      standaloneProblems('demo', body('Read the `hildegard-craft` skill’s references first.')).join('\n'),
    ).toMatch(/hildegard-craft skill's references/);
    // Naming another skill as an extra is fine; so is this skill's own.
    expect(
      standaloneProblems('demo', body('If you have it, the **hildegard-web** skill covers pages.')),
    ).toEqual([]);
    expect(standaloneProblems('demo', body("This skill's checks run first."))).toEqual([]);
  });

  it('holds the description, the name and the length of SKILL.md', () => {
    const long = `---\nname: other\ndescription: ${'x'.repeat(201)}\n---\n${'line\n'.repeat(500)}`;
    const p = standaloneProblems('demo', entries('demo', { 'demo/SKILL.md': long })).join('\n');
    expect(p).toMatch(/not the folder name/);
    expect(p).toMatch(/201 characters/);
    expect(p).toMatch(/under 500/);
    const colon = `---\nname: demo\ndescription: ${'Use for a thing: and the words after a colon break plain YAML, so this must fail the check.'}\n---\n`;
    expect(standaloneProblems('demo', entries('demo', { 'demo/SKILL.md': colon })).join('\n')).toMatch(
      /": "/,
    );
  });

  it('requires "Without Hildegard" wherever a skill names a Hildegard tool', () => {
    const body = (text: string) =>
      entries('demo', {
        'demo/SKILL.md': `---\nname: demo\ndescription: ${'Use for a demo thing that exists only to test the checker, with words enough to pass 80 chars.'}\n---\n\n${text}\n`,
      });
    const toolset = new Set(['loop_start', 'speak']);
    expect(
      standaloneProblems('demo', body('Call `loop_start` first.'), new Set(), toolset).join('\n'),
    ).toMatch(/Without Hildegard/);
    expect(
      standaloneProblems('demo', body('Call `speak` with a script.'), new Set(), toolset).join('\n'),
    ).toMatch(/Without Hildegard/);
    // An ordinary word is not a tool; a tool with its way around passes.
    expect(standaloneProblems('demo', body('Speak plainly.'), new Set(), toolset)).toEqual([]);
    expect(
      standaloneProblems(
        'demo',
        body('With Hildegard linked: `loop_start`. Without Hildegard: do it by hand.'),
        new Set(),
        toolset,
      ),
    ).toEqual([]);
  });
});

// Real links need privileges on Windows; without them these cases cannot be built, so they say so and stop.
const canLink = (() => {
  const d = mkdtempSync(join(tmpdir(), 'hg-canlink-'));
  try {
    symlinkSync(d, join(d, 'l'), 'dir');
    return true;
  } catch {
    console.warn('skipping the symlink cases: this system does not let this user create symlinks');
    return false;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
})();

describe.skipIf(!canLink)('a link in a source or destination path (skills/SHARED.json)', () => {
  const setup = () => {
    const parent = mkdtempSync(join(tmpdir(), 'hg-links-'));
    const repo = join(parent, 'repo');
    const outside = join(parent, 'outside');
    for (const skill of ['a', 'b']) {
      mkdirSync(join(repo, 'skills', skill), { recursive: true });
      writeFileSync(join(repo, 'skills', skill, 'SKILL.md'), `---\nname: ${skill}\n---\n`);
    }
    mkdirSync(join(repo, 'tools'), { recursive: true });
    writeFileSync(join(repo, 'tools', 'x.py'), 'print(1)\n');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'x.py'), 'KEEP\n');
    writeFileSync(
      join(repo, 'skills', 'SHARED.json'),
      JSON.stringify({ copies: [{ source: 'tools/x.py', skills: ['a'] }] }),
    );
    return { parent, repo, outside };
  };

  it('refuses a scripts/ folder that is a link, and writes nothing through it', () => {
    const { parent, repo, outside } = setup();
    symlinkSync(outside, join(repo, 'skills', 'a', 'scripts'), 'dir');
    expect(drift(repo).join('\n')).toMatch(/skills\/a\/scripts is a link/);
    expect(() => sync(repo)).toThrow(/skills\/a\/scripts is a link/);
    expect(readFileSync(join(outside, 'x.py'), 'utf8')).toBe('KEEP\n');
    expect(existsSync(join(repo, 'skills', 'SHARED.lock.json'))).toBe(false);
    rmSync(parent, { recursive: true, force: true });
  });

  it('refuses a destination file that is a link, and leaves what it points at alone', () => {
    const { parent, repo, outside } = setup();
    mkdirSync(join(repo, 'skills', 'a', 'scripts'), { recursive: true });
    symlinkSync(join(outside, 'x.py'), join(repo, 'skills', 'a', 'scripts', 'x.py'));
    expect(drift(repo).join('\n')).toMatch(/skills\/a\/scripts\/x\.py is a link/);
    expect(() => sync(repo)).toThrow(/is a link/);
    expect(readFileSync(join(outside, 'x.py'), 'utf8')).toBe('KEEP\n');
    rmSync(parent, { recursive: true, force: true });
  });

  it('refuses a dangling link as the destination', () => {
    const { parent, repo, outside } = setup();
    mkdirSync(join(repo, 'skills', 'a', 'scripts'), { recursive: true });
    symlinkSync(join(outside, 'gone.py'), join(repo, 'skills', 'a', 'scripts', 'x.py'));
    expect(() => sync(repo)).toThrow(/is a link/);
    expect(existsSync(join(outside, 'gone.py'))).toBe(false);
    rmSync(parent, { recursive: true, force: true });
  });

  it('refuses a source that is a link, or sits under a folder that is one', () => {
    const { parent, repo, outside } = setup();
    writeFileSync(join(outside, 'y.py'), 'print(2)\n');
    symlinkSync(join(outside, 'y.py'), join(repo, 'tools', 'y.py'));
    symlinkSync(outside, join(repo, 'linked'), 'dir');
    for (const source of ['tools/y.py', 'linked/x.py']) {
      writeFileSync(
        join(repo, 'skills', 'SHARED.json'),
        JSON.stringify({ copies: [{ source, skills: ['a'] }] }),
      );
      expect(drift(repo).join('\n'), source).toMatch(/not a file in the repository/);
      expect(() => sync(repo), source).toThrow(/not a file in the repository/);
    }
    expect(existsSync(join(repo, 'skills', 'a', 'scripts'))).toBe(false);
    rmSync(parent, { recursive: true, force: true });
  });

  it('check-skills.mjs fails on a link anywhere under skills/, and on a skills/ that is one', () => {
    const { parent, repo, outside } = setup();
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    mkdirSync(join(repo, 'mcp', 'src'), { recursive: true });
    for (const f of ['scripts/check-skills.mjs', 'scripts/sync-skill-shared.mjs', 'mcp/src/skill-scan.ts'])
      writeFileSync(join(repo, f), readFileSync(join(root, f)));
    const check = () =>
      spawnSync(process.execPath, [join(repo, 'scripts', 'check-skills.mjs')], {
        cwd: repo,
        encoding: 'utf8',
      });
    expect(check().stderr).not.toMatch(/symlink/);
    mkdirSync(join(repo, 'skills', 'a', 'deep'), { recursive: true });
    symlinkSync(outside, join(repo, 'skills', 'a', 'deep', 'out'), 'dir');
    const r = check();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/skills\/a\/deep\/out: symlinks are not allowed/);
    rmSync(join(repo, 'skills', 'a', 'deep'), { recursive: true });
    // The whole skills/ folder as a link.
    const real = join(parent, 'real-skills');
    renameSync(join(repo, 'skills'), real);
    symlinkSync(real, join(repo, 'skills'), 'dir');
    const w = check();
    expect(w.status).toBe(1);
    expect(w.stderr).toMatch(/skills: the folder itself is a symlink/);
    rmSync(parent, { recursive: true, force: true });
  });

  it('refuses a folder as the source', () => {
    const { parent, repo } = setup();
    writeFileSync(
      join(repo, 'skills', 'SHARED.json'),
      JSON.stringify({ copies: [{ source: 'tools', skills: ['a'] }] }),
    );
    expect(drift(repo).join('\n')).toMatch(/not a file in the repository/);
    rmSync(parent, { recursive: true, force: true });
  });
});

describe('a skill taken out of a manifest entry (skills/SHARED.lock.json)', () => {
  const setup = () => {
    const repo = mkdtempSync(join(tmpdir(), 'hg-orphan-'));
    for (const skill of ['a', 'b']) {
      mkdirSync(join(repo, 'skills', skill), { recursive: true });
      writeFileSync(join(repo, 'skills', skill, 'SKILL.md'), `---\nname: ${skill}\n---\n`);
    }
    mkdirSync(join(repo, 'tools'), { recursive: true });
    writeFileSync(join(repo, 'tools', 'x.py'), 'print(1)\n');
    const manifest = (skills: string[]) =>
      writeFileSync(
        join(repo, 'skills', 'SHARED.json'),
        JSON.stringify({ copies: [{ source: 'tools/x.py', skills }] }),
      );
    return { repo, manifest };
  };

  it('is removed by the sync, and --check fails on the old copy until then', () => {
    const { repo, manifest } = setup();
    manifest(['a', 'b']);
    expect(drift(repo).join('\n')).toMatch(/missing/);
    syncAll(repo);
    expect(drift(repo)).toEqual([]);
    expect(JSON.parse(readFileSync(join(repo, 'skills', 'SHARED.lock.json'), 'utf8')).copies).toEqual([
      'skills/a/scripts/x.py',
      'skills/b/scripts/x.py',
    ]);
    manifest(['a']);
    writeFileSync(join(repo, 'tools', 'x.py'), 'print(2)\n');
    const problems = drift(repo);
    expect(problems.join('\n')).toMatch(/skills\/b\/scripts\/x\.py is an orphaned copy/);
    expect(problems.join('\n')).toMatch(/skills\/a\/scripts\/x\.py differs/);
    const done = syncAll(repo);
    expect(done.removed).toEqual(['skills/b/scripts/x.py']);
    expect(existsSync(join(repo, 'skills', 'b', 'scripts', 'x.py'))).toBe(false);
    expect(existsSync(join(repo, 'skills', 'b', 'SKILL.md'))).toBe(true);
    expect(drift(repo)).toEqual([]);
    rmSync(repo, { recursive: true, force: true });
  });

  it('keeps a copy that was edited by hand, and drops it from the lock (first-F1)', () => {
    const { repo, manifest } = setup();
    manifest(['a', 'b']);
    syncAll(repo);
    const forked = join(repo, 'skills', 'b', 'scripts', 'x.py');
    writeFileSync(forked, 'print("b has its own version")\n');
    manifest(['a']);
    expect(drift(repo).join('\n')).toMatch(
      /skills\/b\/scripts\/x\.py is no longer shared and was changed by hand/,
    );
    expect(drift(repo).join('\n')).not.toMatch(/Run node scripts\/sync-skill-shared\.mjs to remove it/);
    const done = syncAll(repo);
    expect(done.removed).toEqual([]);
    expect(done.kept).toEqual(['skills/b/scripts/x.py']);
    expect(readFileSync(forked, 'utf8')).toBe('print("b has its own version")\n');
    expect(JSON.parse(readFileSync(join(repo, 'skills', 'SHARED.lock.json'), 'utf8')).copies).toEqual([
      'skills/a/scripts/x.py',
    ]);
    expect(drift(repo)).toEqual([]);
    rmSync(repo, { recursive: true, force: true });
  });

  it('never removes the file the manifest now names as its source (second-F5)', () => {
    const { repo, manifest } = setup();
    manifest(['a', 'b']);
    syncAll(repo);
    const moved = join(repo, 'skills', 'a', 'scripts', 'x.py');
    writeFileSync(
      join(repo, 'skills', 'SHARED.json'),
      JSON.stringify({ copies: [{ source: 'skills/a/scripts/x.py', skills: ['b'] }] }),
    );
    expect(drift(repo).join('\n')).not.toMatch(/orphaned/);
    const done = syncAll(repo);
    expect(done.removed).toEqual([]);
    expect(existsSync(moved)).toBe(true);
    expect(readFileSync(join(repo, 'skills', 'b', 'scripts', 'x.py'), 'utf8')).toBe('print(1)\n');
    expect(drift(repo)).toEqual([]);
    expect(() => syncAll(repo)).not.toThrow();
    rmSync(repo, { recursive: true, force: true });
  });

  it('never lets a hand-edited lock delete SKILL.md or anything outside a skill folder', () => {
    const { repo, manifest } = setup();
    manifest(['a']);
    syncAll(repo);
    writeFileSync(
      join(repo, 'skills', 'SHARED.lock.json'),
      JSON.stringify({
        copies: ['skills/a/scripts/x.py', 'skills/b/SKILL.md', '../x', 'skills/a/../../tools/x.py'],
      }),
    );
    syncAll(repo);
    expect(existsSync(join(repo, 'skills', 'b', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(repo, 'tools', 'x.py'))).toBe(true);
    expect(drift(repo)).toEqual([]);
    rmSync(repo, { recursive: true, force: true });
  });
});
