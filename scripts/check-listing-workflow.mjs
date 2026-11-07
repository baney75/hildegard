// SPDX-License-Identifier: AGPL-3.0-only
// Checks .github/workflows/listing.yml for the one mistake that would hand the listing repository's deploy key to
// code from a pull request:
//
//   node scripts/check-listing-workflow.mjs [workflow.yml]
//
// A job that can run on a pull request has no secret and no write permission; a job that uses a secret runs only on a
// push to main, in a protected environment, from the pushed commit; the secret appears only as a step's `env` value;
// every action is pinned by commit SHA. CI runs this in the build job, and apps/cli/test/listing-workflow.test.ts
// mutates the workflow to prove each rule fails.
//
// There is no YAML library in this repository (everything is pinned), so this reads the small subset a workflow uses:
// block mappings and sequences, quoted and plain scalars, `[a, b]` lists of scalars and `|` / `>` block scalars. It
// throws on anything else (anchors, `{}` maps, multi-line plain scalars, tabs) rather than guess.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export const WORKFLOW = `${root}.github/workflows/listing.yml`;

const indentOf = (l) => l.length - l.trimStart().length;
const blank = (l) => /^\s*(#.*)?$/.test(l);

function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

function scalar(s) {
  const t = s.trim();
  if (t === '' || t === '~' || t === 'null') return '';
  if (t[0] === '"' || t[0] === "'") {
    const q = t[0];
    if (t.length < 2 || t.at(-1) !== q) throw new Error(`Unterminated quoted scalar: ${t}`);
    return q === "'" ? t.slice(1, -1).replaceAll("''", "'") : JSON.parse(t);
  }
  if (t[0] === '[') {
    if (t.at(-1) !== ']') throw new Error(`Unsupported flow list: ${t}`);
    const inner = t.slice(1, -1).trim();
    return inner ? inner.split(',').map(scalar) : [];
  }
  if (/^[{&*!]/.test(t)) throw new Error(`Unsupported YAML: ${t}`);
  return t;
}

function splitKey(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === ':' && (i === s.length - 1 || s[i + 1] === ' '))
      return [scalar(s.slice(0, i)), s.slice(i + 1)];
  }
  return null;
}

/** Parses the workflow subset described above into plain objects, arrays and strings. */
export function parseYaml(text) {
  if (/^ *\t/m.test(text)) throw new Error('Tabs are not YAML indentation');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  const skip = () => {
    while (i < lines.length && blank(lines[i])) i++;
  };

  function blockScalar(parent, style) {
    const out = [];
    let ind = -1;
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() !== '' && indentOf(l) <= parent) break;
      if (l.trim() !== '' && ind < 0) ind = indentOf(l);
      out.push(l.trim() === '' ? '' : l.slice(ind));
      i++;
    }
    while (out.length && out.at(-1) === '') out.pop();
    const body = style.startsWith('>') ? out.join(' ') : out.join('\n');
    return style.endsWith('-') ? body : `${body}\n`;
  }

  function value(rest, parent) {
    const r = stripComment(rest).trim();
    if (/^[|>][+-]?$/.test(r)) return blockScalar(parent, r);
    if (r === '') {
      skip();
      if (
        i < lines.length &&
        (indentOf(lines[i]) > parent || (indentOf(lines[i]) === parent && /^\s*-( |$)/.test(lines[i])))
      )
        return block(indentOf(lines[i]));
      return '';
    }
    const v = scalar(r);
    skip();
    if (i < lines.length && indentOf(lines[i]) > parent)
      throw new Error(`Multi-line plain scalars are not supported: ${r}`);
    return v;
  }

  function block(indent) {
    skip();
    if (/^\s*-( |$)/.test(lines[i])) {
      const seq = [];
      while (i < lines.length) {
        skip();
        if (i >= lines.length || indentOf(lines[i]) !== indent || !/^\s*-( |$)/.test(lines[i])) break;
        const after = lines[i].slice(indent + 1);
        const gap = after.length - after.trimStart().length;
        const rest = after.trimStart();
        if (rest === '') {
          i++;
          skip();
          seq.push(i < lines.length && indentOf(lines[i]) > indent ? block(indentOf(lines[i])) : '');
        } else if (splitKey(stripComment(rest)) && !/^["']/.test(rest.split(':')[0])) {
          lines[i] = ' '.repeat(indent + 1 + gap) + rest;
          seq.push(block(indent + 1 + gap));
        } else {
          i++;
          seq.push(scalar(stripComment(rest)));
        }
      }
      return seq;
    }
    const map = {};
    while (i < lines.length) {
      skip();
      if (i >= lines.length || indentOf(lines[i]) !== indent) break;
      const kv = splitKey(stripComment(lines[i].trim()));
      if (!kv) throw new Error(`Expected "key: value" at line ${i + 1}: ${lines[i].trim()}`);
      i++;
      map[kv[0]] = value(kv[1], indent);
    }
    return map;
  }

  skip();
  const doc = block(indentOf(lines[i] ?? ''));
  skip();
  if (i < lines.length) throw new Error(`Unexpected content at line ${i + 1}: ${lines[i].trim()}`);
  return doc;
}

function* strings(node, path = []) {
  if (typeof node === 'string') yield [path, node];
  else if (Array.isArray(node)) for (const [k, v] of node.entries()) yield* strings(v, [...path, String(k)]);
  else if (node && typeof node === 'object')
    for (const [k, v] of Object.entries(node)) {
      yield [[...path, k, '(key)'], k];
      yield* strings(v, [...path, k]);
    }
}

const PUSH_TO_MAIN =
  /^\s*(\$\{\{\s*)?github\.event_name\s*==\s*'push'\s*&&\s*github\.ref\s*==\s*'refs\/heads\/main'\s*(\}\})?\s*$/;
// The expression for the commit that was pushed.
const PUSHED_SHA = `\${{ github.sha }}`;
const SECRET = /\bsecrets\./i;
const PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;

/** Problems with a listing workflow's text; empty when it keeps the key away from pull requests. */
export function checkListingWorkflow(text) {
  const bad = [];
  let wf;
  try {
    wf = parseYaml(text);
  } catch (e) {
    return [`the workflow can't be read: ${e.message}`];
  }
  const on = wf.on ?? {};
  const triggers = Array.isArray(on) ? on : typeof on === 'string' ? [on] : Object.keys(on);
  for (const t of ['pull_request_target', 'workflow_run', 'issue_comment'])
    if (triggers.includes(t))
      bad.push(`the workflow runs on ${t}, which runs with secrets for code it didn't review`);
  if (!triggers.includes('pull_request')) bad.push('the workflow no longer builds and checks pull requests');

  if (wf.env && [...strings(wf.env)].some(([, s]) => SECRET.test(s)))
    bad.push('a secret is set in the workflow-level env, so every job (and every pull request) gets it');
  const top = wf.permissions;
  if (
    !top ||
    typeof top !== 'object' ||
    top.contents !== 'read' ||
    Object.values(top).some((v) => v === 'write')
  )
    bad.push('the workflow-level permissions must be contents: read and nothing writable');

  const jobs = wf.jobs ?? {};
  let deploys = 0;
  for (const [name, job] of Object.entries(jobs)) {
    const onlyOnMainPush = PUSH_TO_MAIN.test(job.if ?? '');
    const uses = [...strings(job)].filter(([, s]) => SECRET.test(s));
    if (!onlyOnMainPush) {
      for (const [p] of uses)
        bad.push(`job ${name} can run on a pull request and uses a secret (${p.join('.')})`);
      const perms = job.permissions;
      if (perms && Object.values(perms).some((v) => v === 'write'))
        bad.push(`job ${name} can run on a pull request and has write permission`);
      if (job.environment) bad.push(`job ${name} can run on a pull request but names an environment`);
    }
    if (uses.length) {
      deploys++;
      if (!onlyOnMainPush)
        bad.push(
          `job ${name}: its if must be exactly github.event_name == 'push' && github.ref == 'refs/heads/main'`,
        );
      if (!job.environment) bad.push(`job ${name} uses a secret outside a protected environment`);
      if (job.permissions?.contents !== 'read') bad.push(`job ${name} must set permissions: contents: read`);
      for (const [p, s] of uses) {
        const isStepEnv = p.length === 4 && p[0] === 'steps' && p[2] === 'env';
        if (!isStepEnv)
          bad.push(
            `job ${name}: a secret may only be a step's env value, not ${p.join('.')} = ${s.slice(0, 40)}`,
          );
      }
      for (const [k, step] of (job.steps ?? []).entries()) {
        const run = typeof step.run === 'string' ? step.run : '';
        for (const line of run.split('\n').filter((l) => /LISTING_DEPLOY_KEY/.test(l))) {
          const guard = /\[\s+-[nz]\s+"\$\{LISTING_DEPLOY_KEY:-\}"\s+\]/.test(line);
          const agent = /^\s*printf\s+'%s\\n'\s+"\$LISTING_DEPLOY_KEY"\s*\|[^>]*ssh-add\s+-\s*$/.test(line);
          if (!guard && !agent && !/^\s*unset LISTING_DEPLOY_KEY\s*$/.test(line))
            bad.push(
              `job ${name} step ${k}: the key may only go to ssh-agent, never anywhere else: ${line.trim()}`,
            );
        }
        if (/\bset\s+-\w*x/.test(run)) bad.push(`job ${name} step ${k}: set -x would print the key`);
        if (/^actions\/checkout@/.test(step.uses ?? '') && step.with?.ref !== PUSHED_SHA)
          bad.push(`job ${name}: checkout must take ref: \${{ github.sha }}, the pushed commit`);
      }
    }
    for (const [k, step] of (job.steps ?? []).entries()) {
      if (
        /^actions\/checkout@/.test(step.uses ?? '') &&
        /pull_request|head\.(ref|sha)/.test(step.with?.ref ?? '')
      )
        bad.push(`job ${name} step ${k}: checkout of a pull request's ref`);
    }
  }
  if (!deploys) bad.push('no job publishes the listing');

  for (const [p, s] of strings(jobs)) {
    if (p.at(-1) === 'uses' && !s.startsWith('./') && !PINNED.test(s))
      bad.push(`${p.join('.')}: ${s} isn't pinned by a 40-character commit SHA`);
  }
  return bad;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = process.argv[2] ?? WORKFLOW;
  const problems = checkListingWorkflow(readFileSync(file, 'utf8'));
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log(`${file}: no secret reaches a pull request, every action is pinned.`);
}
