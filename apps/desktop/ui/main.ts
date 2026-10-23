// SPDX-License-Identifier: AGPL-3.0-only
// The app's start-up page: it asks the app to find or start Hildegard (the app then shows the Studio in this window),
// and when Hildegard isn't set up here yet, runs the install with its progress.
import { Channel, invoke } from '@tauri-apps/api/core';
import markUrl from '../../studio/src/assets/mark-vellum.svg';
import wordmarkUrl from '../../studio/src/assets/wordmark-vellum.svg';
import {
  blocker,
  type InstallEvent,
  type Launch,
  type Outcome,
  progress,
  report,
  type Step,
  shortLine,
} from './model.ts';
import './app.css';

type Child = Node | string | null | false | undefined;

/** A tiny element builder. Text always goes in as text, never as HTML. */
function h(
  tag: string,
  attrs: Record<string, string | boolean | ((e: Event) => void)> = {},
  ...kids: Child[]
) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false) el.setAttribute(k, v);
  }
  for (const k of kids) if (k) el.append(k);
  return el;
}

const main = document.getElementById('main')!;

function show(...kids: Child[]) {
  main.replaceChildren(...kids.filter((k): k is Node | string => !!k));
  main.querySelector<HTMLElement>('[data-autofocus]')?.focus();
}

const button = (label: string, onclick: () => void, kind = '') =>
  h('button', { type: 'button', class: `hg-btn ${kind}`.trim(), onclick }, label);

const openLogs = () => void invoke('open_logs').catch(() => {});

// ── Finding Hildegard ────────────────────────────────────────────────────────────────────────────────────────────

async function launch(anyway = false) {
  show(
    h(
      'div',
      { class: 'hd-wait', role: 'status' },
      h('span', { class: 'hd-ring', 'aria-hidden': 'true' }),
      'Opening Hildegard…',
    ),
  );
  let r: Launch;
  try {
    r = await invoke<Launch>('launch', { anyway });
  } catch (e) {
    r = { kind: 'failed', message: String(e), log: '' };
  }
  if (r.kind === 'install') welcome(r.data, r.partly);
  else if (r.kind === 'failed') failed(r.message, r.log);
  // 'studio': the app is already taking this window to the Studio.
}

function failed(message: string, log: string) {
  show(
    h('p', { class: 'ovl' }, 'Something went wrong'),
    h('h1', { class: 'hd-h1' }, 'Hildegard didn’t start.'),
    h('p', { class: 'hd-lead' }, message),
    log && h('p', { class: 'hd-note' }, 'What it said is in ', h('code', {}, log), '.'),
    h(
      'div',
      { class: 'hd-acts' },
      h(
        'button',
        {
          type: 'button',
          class: 'hg-btn hg-btn--primary hg-btn--lg',
          'data-autofocus': true,
          onclick: () => launch(),
        },
        'Try again',
      ),
      button('Open the logs folder', openLogs, 'hg-btn--ghost'),
    ),
  );
}

function stopped() {
  show(
    h('h1', { class: 'hd-h1' }, 'Hildegard stopped.'),
    h(
      'p',
      { class: 'hd-lead' },
      'It was stopped on this computer, so the Studio closed. Your films are all still here.',
    ),
    h(
      'div',
      { class: 'hd-acts' },
      h(
        'button',
        {
          type: 'button',
          class: 'hg-btn hg-btn--primary hg-btn--lg',
          'data-autofocus': true,
          onclick: () => launch(),
        },
        'Start Hildegard',
      ),
    ),
  );
}

// ── First run ────────────────────────────────────────────────────────────────────────────────────────────────────

function welcome(data: string, partly: boolean) {
  const cpu = h('input', { type: 'checkbox', id: 'cpu' }) as HTMLInputElement;
  show(
    h('img', { src: markUrl, alt: '', height: '88', class: 'hd-mark' }),
    h('h1', { class: 'hd-h1' }, partly ? 'Finish setting up Hildegard.' : 'Welcome to Hildegard.'),
    h(
      'p',
      { class: 'hd-lead' },
      partly
        ? 'The hildegard command is here, but ComfyUI and PyTorch aren’t set up yet. This finishes the install.'
        : 'Your own film studio, on your own GPU. Hildegard sets up ComfyUI and PyTorch for your graphics card, then opens the Studio. Your work stays private, and nothing costs money per shot.',
    ),
    h(
      'dl',
      { class: 'hd-facts' },
      h('dt', {}, 'Where it goes'),
      h('dd', {}, h('code', {}, data)),
      h('dt', {}, 'What it needs'),
      h('dd', {}, 'No admin rights. It downloads a few gigabytes, so it can take a while.'),
    ),
    h(
      'details',
      { class: 'hd-more' },
      h('summary', {}, 'Options'),
      h(
        'label',
        { class: 'hd-check', for: 'cpu' },
        cpu,
        'Install the CPU build of PyTorch, for a computer without a graphics card Hildegard can use',
      ),
    ),
    h(
      'div',
      { class: 'hd-acts' },
      h(
        'button',
        {
          type: 'button',
          class: 'hg-btn hg-btn--primary hg-btn--lg',
          'data-autofocus': true,
          onclick: () => install(cpu.checked),
        },
        partly ? 'Finish setting up' : 'Install Hildegard',
      ),
      partly && button('Open the Studio without it', () => launch(true), 'hg-btn--ghost'),
    ),
  );
}

const STATUS: Record<string, [string, string]> = {
  done: ['hg-status--done', 'Done'],
  skipped: ['hg-status--done', 'Already here'],
  'needs-owner': ['hg-status--error', 'Needs you'],
  failed: ['hg-status--error', 'Failed'],
  running: ['hg-status--running', 'Working'],
  waiting: ['hg-status--queued', 'Waiting'],
};

async function install(cpu: boolean) {
  let steps: Step[] = [];
  let line = '';
  const bar = h('div', {
    class: 'hd-bar',
    role: 'progressbar',
    'aria-label': 'Install progress',
    'aria-valuemin': '0',
    'aria-valuemax': '100',
  });
  const fill = h('span');
  bar.append(fill);
  const list = h('ol', { class: 'hd-steps' });
  const log = h('p', { class: 'hd-log', 'aria-live': 'off' });
  const draw = () => {
    const p = progress(steps);
    fill.style.width = `${Math.round(p.fraction * 100)}%`;
    bar.setAttribute('aria-valuenow', String(Math.round(p.fraction * 100)));
    list.replaceChildren(
      ...p.rows.map((r) => {
        const state = r.status ?? (r.id === p.current ? 'running' : 'waiting');
        const [cls, word] = STATUS[state]!;
        return h(
          'li',
          { class: r.status ? 'is-reported' : r.id === p.current ? 'is-current' : '' },
          h('span', { class: `hg-status ${cls}` }, word),
          h('b', {}, r.title),
          r.detail && h('small', {}, r.detail),
        );
      }),
    );
    log.textContent = line;
  };
  show(
    h('p', { class: 'ovl' }, 'Installing'),
    h('h1', { class: 'hd-h1' }, 'Setting up Hildegard.'),
    h(
      'p',
      { class: 'hd-lead' },
      'You can close this window: the install carries on, and Hildegard waits in the tray (the menu bar on a Mac).',
    ),
    bar,
    list,
    log,
  );
  draw();

  const events = new Channel<InstallEvent>();
  events.onmessage = (e) => {
    if (e.kind === 'step') steps = report(steps, e.step);
    else line = shortLine(e.line);
    draw();
  };
  let outcome: Outcome;
  try {
    outcome = await invoke<Outcome>('install', { cpu, onEvent: events });
  } catch (e) {
    outcome = { ok: false, needsOwner: false, steps: [], message: String(e) };
  }
  for (const s of outcome.steps) steps = report(steps, s);
  draw();
  if (outcome.ok && !outcome.needsOwner) return launch();
  problem(outcome, cpu, list);
}

function problem(o: Outcome, cpu: boolean, list: HTMLElement) {
  const step = blocker(o);
  const owner = step?.status === 'needs-owner';
  show(
    h('p', { class: 'ovl' }, owner ? 'One thing for you' : 'The install stopped'),
    h('h1', { class: 'hd-h1' }, owner ? 'Hildegard needs you for this.' : 'The install didn’t finish.'),
    h('p', { class: 'hd-lead' }, step ? `${step.title}: ${step.detail}` : o.message),
    step?.command &&
      h(
        'div',
        { class: 'hd-fix' },
        h('span', {}, owner ? 'Do this, then try again:' : 'This fixes it:'),
        h('code', {}, step.command),
      ),
    h(
      'div',
      { class: 'hd-acts' },
      h(
        'button',
        {
          type: 'button',
          class: 'hg-btn hg-btn--primary hg-btn--lg',
          'data-autofocus': true,
          onclick: () => install(cpu),
        },
        'Try again',
      ),
      owner && button('Open the Studio anyway', () => launch(true)),
      button('Open the logs folder', openLogs, 'hg-btn--ghost'),
    ),
    h('details', { class: 'hd-more' }, h('summary', {}, 'Every step'), list),
  );
}

// ── The page ─────────────────────────────────────────────────────────────────────────────────────────────────────

document.querySelector<HTMLImageElement>('.hd-brand img[data-mark]')!.src = markUrl;
document.querySelector<HTMLImageElement>('.hd-brand img[data-wordmark]')!.src = wordmarkUrl;
if (location.hash === '#stopped') stopped();
else void launch();
