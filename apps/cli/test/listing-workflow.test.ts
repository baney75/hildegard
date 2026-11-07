// SPDX-License-Identifier: AGPL-3.0-only
// .github/workflows/listing.yml (scripts/check-listing-workflow.mjs): the deploy key never reaches code that a pull
// request can change, and every action is pinned. Each rule is proven by breaking the real workflow and watching the
// check fail.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the workflow's own ${{ }} expressions are the text under test
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkListingWorkflow,
  parseYaml,
  // @ts-expect-error: plain JavaScript, run by Node with no build
} from '../../../scripts/check-listing-workflow.mjs';

const text = readFileSync(
  join(import.meta.dirname, '..', '..', '..', '.github', 'workflows', 'listing.yml'),
  'utf8',
);
const problems = (t: string): string => (checkListingWorkflow(t) as string[]).join('\n');
const swap = (from: string, to: string) => {
  expect(text, `the workflow has “${from}”`).toContain(from);
  return text.replace(from, to);
};
type Job = { steps: { uses?: string }[] };
const MAIN_PUSH = "github.event_name == 'push' && github.ref == 'refs/heads/main'";
const CHECKOUT = 'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2';

describe('the workflow reader', () => {
  it('reads mappings, sequences, quoted scalars, lists and block scalars', () => {
    const doc = parseYaml(
      [
        'name: x # a comment',
        'on:',
        '  push:',
        '    branches: [main, dev]',
        'jobs:',
        '  a:',
        "    if: github.ref == 'refs/heads/main'",
        '    steps:',
        '      - uses: o/r@v1',
        '        with:',
        '          k: "v: 1"',
        '      - name: n',
        '        run: |',
        '          one',
        '',
        '          two',
        '      - plain',
      ].join('\n'),
    );
    expect(doc.name).toBe('x');
    expect(doc.on.push.branches).toEqual(['main', 'dev']);
    expect(doc.jobs.a.if).toBe("github.ref == 'refs/heads/main'");
    expect(doc.jobs.a.steps[0]).toEqual({ uses: 'o/r@v1', with: { k: 'v: 1' } });
    expect(doc.jobs.a.steps[1].run).toBe('one\n\ntwo\n');
    expect(doc.jobs.a.steps[2]).toBe('plain');
  });

  it('refuses YAML it would have to guess at', () => {
    expect(() => parseYaml('a: {b: 1}')).toThrow(/Unsupported/);
    expect(() => parseYaml('a: &x 1')).toThrow(/Unsupported/);
    expect(() => parseYaml('a: one\n  two')).toThrow(/Multi-line/);
    expect(() => parseYaml('a:\n\tb: 1')).toThrow(/Tabs/);
  });
});

describe('listing.yml', () => {
  it('passes: no secret in a job a pull request can run, the publish job only on a push to main, all pinned', () => {
    expect(problems(text)).toBe('');
    const wf = parseYaml(text);
    expect(Object.keys(wf.on)).toContain('pull_request');
    expect(Object.keys(wf.on)).not.toContain('pull_request_target');
    // The jobs that can run on a pull request hold no secret at all.
    for (const [name, job] of Object.entries<Job>(wf.jobs))
      if (name !== 'publish') expect(JSON.stringify(job), name).not.toMatch(/secrets\./i);
    expect(wf.jobs.publish.if).toBe(MAIN_PUSH);
    expect(wf.jobs.publish.environment).toBe('listing');
    expect(wf.jobs.publish.needs).toBe('build');
    for (const j of Object.values<Job>(wf.jobs))
      for (const s of j.steps) if (s.uses) expect(s.uses).toMatch(/@[0-9a-f]{40}$/);
  });

  it('fails the original shape: the key in the workflow env, where every pull request reads it', () => {
    const t = swap('jobs:\n', 'env:\n  LISTING_DEPLOY_KEY: ${{ secrets.LISTING_DEPLOY_KEY }}\n\njobs:\n');
    expect(problems(t)).toContain('workflow-level env');
  });

  it('fails a secret on a step of the build job, which pull requests run', () => {
    const t = swap(
      '      - name: Build the listings\n        run:',
      '      - name: Build the listings\n        env:\n          LISTING_DEPLOY_KEY: ${{ secrets.LISTING_DEPLOY_KEY }}\n        run:',
    );
    expect(problems(t)).toContain('job build can run on a pull request and uses a secret');
  });

  it('fails a publish job that is not limited to a push to main', () => {
    expect(problems(swap(`    if: ${MAIN_PUSH}\n`, ''))).toContain('its if must be exactly');
    expect(problems(swap(MAIN_PUSH, "github.event_name != 'x'"))).toContain('its if must be exactly');
    expect(problems(swap(MAIN_PUSH, "github.event_name == 'push'"))).toContain('its if must be exactly');
  });

  it('fails a publish job outside a protected environment', () => {
    expect(problems(swap('    environment: listing\n', ''))).toContain('outside a protected environment');
  });

  it('fails pull_request_target and workflow_run triggers', () => {
    expect(
      problems(swap('  workflow_dispatch:\n', '  workflow_dispatch:\n  pull_request_target:\n')),
    ).toContain('pull_request_target');
    expect(problems(swap('  workflow_dispatch:\n', '  workflow_dispatch:\n  workflow_run:\n'))).toContain(
      'workflow_run',
    );
  });

  it('fails a checkout of a pull request’s ref, or of anything but the pushed commit in the publish job', () => {
    expect(
      problems(swap('ref: ${{ github.sha }}', 'ref: ${{ github.event.pull_request.head.sha }}')),
    ).toContain('checkout must take ref');
    expect(problems(swap('ref: ${{ github.sha }}', 'ref: main'))).toContain('checkout must take ref');
    const t = swap(
      `      - uses: ${CHECKOUT}\n        with:\n          persist`,
      `      - uses: ${CHECKOUT}\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n          persist`,
    );
    expect(problems(t)).toContain("checkout of a pull request's ref");
  });

  it('fails an action that is not pinned by commit SHA', () => {
    expect(
      problems(swap('actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020', 'actions/setup-node@v4')),
    ).toContain("isn't pinned");
    expect(
      problems(
        swap(
          'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
          'actions/upload-artifact@ea165f8',
        ),
      ),
    ).toContain("isn't pinned");
  });

  it('fails a key that goes anywhere but ssh-agent, or a secret expanded into the script text', () => {
    const send = "          printf '%s\\n' \"$LISTING_DEPLOY_KEY\" | tr -d '\\r' | ssh-add -\n";
    expect(problems(swap(send, '          printf \'%s\\n\' "$LISTING_DEPLOY_KEY" > ~/.ssh/key\n'))).toContain(
      'only go to ssh-agent',
    );
    expect(
      problems(
        swap(
          '          set -euo pipefail\n          if [ -z',
          '          set -euxo pipefail\n          if [ -z',
        ),
      ),
    ).toContain('set -x');
    expect(
      problems(
        swap('          unset LISTING_DEPLOY_KEY\n', '          echo "${{ secrets.LISTING_DEPLOY_KEY }}"\n'),
      ),
    ).toContain("a secret may only be a step's env value");
  });

  it('fails write permission in a job a pull request can run', () => {
    const t = swap(
      '  build:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read',
      '  build:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: write',
    );
    expect(problems(t)).toContain('write permission');
  });

  it('fails the workflow this one replaced', () => {
    const old = `name: Listing
on:
  pull_request:
    paths:
      - 'skills/**'
permissions:
  contents: read
env:
  LISTING_DEPLOY_KEY: \${{ secrets.LISTING_DEPLOY_KEY }}
jobs:
  listing:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build the listings
        run: node scripts/pack-listing.mjs "$RUNNER_TEMP/plugin"
      - name: Publish
        if: github.event_name == 'push' && github.ref == 'refs/heads/main' && env.LISTING_DEPLOY_KEY != ''
        run: echo hi
`;
    const bad = problems(old);
    expect(bad).toContain('workflow-level env');
    expect(bad).toContain("isn't pinned");
  });
});
