// SPDX-License-Identifier: AGPL-3.0-only
// .github/workflows/listing.yml: the deploy key never meets code a pull request can change. A job that can run on a pull
// request names no secret; the one job that names LISTING_DEPLOY_KEY runs only on a push to main, in the `listing`
// environment; every action is pinned to a commit.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the workflow's own ${{ }} expressions are the text under test
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = join(import.meta.dirname, '..', '..', '..');
// A Windows checkout has CRLF line endings; the rules below are about lines, so read the file with LF.
const live = readFileSync(join(repo, '.github', 'workflows', 'listing.yml'), 'utf8').replace(/\r\n/g, '\n');

/** What the workflow looked like in the round-1 review (fce5cbf), cut to the lines that mattered. */
const OLD = `name: Listing
on:
  push:
    branches: [main]
  pull_request:
env:
  LISTING_DEPLOY_KEY: \${{ secrets.LISTING_DEPLOY_KEY }}
jobs:
  listing:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: node scripts/pack-listing.mjs "$RUNNER_TEMP/plugin"
      - name: Publish the Claude plugin to baney75/hildegard-plugin
        if: github.event_name == 'push' && github.ref == 'refs/heads/main' && env.LISTING_DEPLOY_KEY != ''
        run: printf '%s\\n' "$LISTING_DEPLOY_KEY" > ~/.ssh/listing_deploy_key
`;

const MAIN_ONLY =
  /^ {4}if: \(?github\.event_name == 'push'(?: \|\| github\.event_name == 'workflow_dispatch'\))? && github\.ref == 'refs\/heads\/main'/m;

function problems(yml: string): string[] {
  const [head = '', body = ''] = yml.split(/^jobs:\s*$/m);
  const jobs = body.split(/^(?= {2}[\w-]+:\s*$)/m).filter((j) => j.trim());
  const bad: string[] = [];
  if (/pull_request_target|secrets\./.test(head)) bad.push('the trigger or top-level env names a secret');
  for (const m of yml.matchAll(/\buses:\s*(\S+)/g))
    if (!/@[0-9a-f]{40}$/.test(m[1] ?? '')) bad.push(`${m[1]} isn’t pinned to a commit`);
  const keyed = jobs.filter((j) => j.includes('LISTING_DEPLOY_KEY'));
  if (keyed.length !== 1) bad.push(`${keyed.length} jobs name the deploy key; exactly one may`);
  for (const job of jobs) {
    const name = job.trim().split(':')[0];
    const onMainOnly = MAIN_ONLY.test(job);
    if (!onMainOnly && /secrets\.|LISTING_DEPLOY_KEY/.test(job))
      bad.push(`${name} can run on a pull request and names a secret`);
    if (!/LISTING_DEPLOY_KEY/.test(job)) continue;
    if (!/^ {4}environment: listing\s*$/m.test(job)) bad.push(`${name} isn’t in the listing environment`);
    const steps = job.split(/^ {6}- /m).filter((s) => s.includes('secrets.'));
    if (steps.length !== 1 || /\buses:/.test(steps[0] ?? ''))
      bad.push(`${name}: the key must reach one run step only`);
  }
  return bad;
}

describe('the listing workflow', () => {
  it('names an environment secret, and the docs limit that environment to main before the key goes in', () => {
    const yml = readFileSync(join(repo, '.github/workflows/listing.yml'), 'utf8');
    expect(yml).not.toMatch(/repository secret/);
    expect(yml).toMatch(/environment secret LISTING_DEPLOY_KEY/);
    const docs = readFileSync(join(repo, 'docs/listings.md'), 'utf8');
    const step = docs.slice(docs.indexOf('**Before pressing submit**'));
    const branches = step.indexOf('Deployment branches and tags');
    expect(branches).toBeGreaterThan(-1);
    expect(step.slice(branches, branches + 200)).toMatch(/`main`/);
    expect(branches).toBeLessThan(step.indexOf('Environment secrets'));
  });

  it('keeps the deploy key away from pull requests and pins every action', () => {
    expect(problems(live)).toEqual([]);
  });

  it('fails the workflow as it stood in the round-1 review', () => {
    const bad = problems(OLD).join('\n');
    expect(bad).toContain('top-level env names a secret');
    expect(bad).toContain('can run on a pull request and names a secret');
    expect(bad).toContain('actions/checkout@v4 isn’t pinned');
  });

  it('fails when the publish job is open to pull requests, loses its environment or has an unpinned action', () => {
    const swap = (from: RegExp | string, to: string) => {
      expect(live).toMatch(from);
      return live.replace(from, to);
    };
    expect(problems(swap(/^ {4}if: .*main'\n/m, '')).join('\n')).toContain('pull request');
    expect(problems(swap(/^ {4}environment: listing\n/m, '')).join('\n')).toContain('listing environment');
    expect(problems(swap(/(setup-node)@[0-9a-f]{40}/, '$1@v4')).join('\n')).toContain('isn’t pinned');
  });
});
