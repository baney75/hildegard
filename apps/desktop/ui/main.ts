// SPDX-License-Identifier: AGPL-3.0-only
// The app's start-up page: it asks the app to find or start Hildegard (the app then shows the Studio in this window),
// and when Hildegard isn't set up here yet, runs the install with its progress.
import { Channel, invoke } from '@tauri-apps/api/core';
import markGreenUrl from '../../studio/src/assets/mark-green.svg';
import markUrl from '../../studio/src/assets/mark-vellum.svg';
import wordmarkGreenUrl from '../../studio/src/assets/wordmark-green.svg';
import wordmarkUrl from '../../studio/src/assets/wordmark-vellum.svg';
import {
  blocker,
  cause,
  clock,
  type InstallEvent,
  type Launch,
  nowLine,
  type Outcome,
  type Progress,
  progress,
  report,
  type Step,
  splitLog,
} from './model.ts';
import './app.css';

type Child = Node | string | null | false | undefined;
type Attrs = Record<string, string | boolean | ((e: Event) => void)>;

/** A tiny element builder. Text always goes in as text, never as HTML. */
function h(tag: string, attrs: Attrs = {}, ...kids: Child[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false) el.setAttribute(k, v);
  }
  for (const k of kids) if (k) el.append(k);
  return el;
}

function svg(tag: string, attrs: Record<string, string> = {}, ...kids: SVGElement[]) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
}

const root = document.documentElement;
const main = document.getElementById('main')!;
const stagesEl = document.getElementById('stages')!;

// ── Theme ────────────────────────────────────────────────────────────────────────────────────────────────────────
// Follows the computer: dark unless it's set to light. Light is warm vellum, with the green logo.


function applyTheme() {
  const forced = root.dataset.previewTheme;
  // Dark, like the Studio it hands over to, so the window doesn't flip themes when the Studio opens.
  const theme = forced === 'light' ? 'light' : 'dark';
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  const light = theme === 'light';
  document.querySelector<HTMLImageElement>('.hd-brand img[data-mark]')!.src = light ? markGreenUrl : markUrl;
  document.querySelector<HTMLImageElement>('.hd-brand img[data-wordmark]')!.src = light
    ? wordmarkGreenUrl
    : wordmarkUrl;
  for (const img of main.querySelectorAll<HTMLImageElement>('img[data-mark]'))
    img.src = light ? markGreenUrl : markUrl;
}
const mark = (cls: string) => {
  const img = h('img', { alt: '', class: cls, 'data-mark': true }) as HTMLImageElement;
  img.src = root.dataset.theme === 'light' ? markGreenUrl : markUrl;
  return img;
};

// ── Screens ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Ends with the screen it belongs to: its timers and listeners stop when the next screen shows. */
let screen = new AbortController();

function show(kind: string, ...kids: Child[]) {
  screen.abort();
  screen = new AbortController();
  main.dataset.screen = kind;
  main.replaceChildren(h('div', { class: 'hd-page' }, ...kids));
  main.scrollTop = 0;
  main.querySelector<HTMLElement>('[data-go]')?.focus();
  return screen.signal;
}

function every(ms: number, fn: () => void, signal: AbortSignal) {
  const t = setInterval(fn, ms);
  signal.addEventListener('abort', () => clearInterval(t));
}

function after(ms: number, fn: () => void, signal: AbortSignal) {
  const t = setTimeout(fn, ms);
  signal.addEventListener('abort', () => clearTimeout(t));
}

/** The first run's three stages, on the side panel. `null` hides them: an everyday start has no stages. */
function stages(current: 0 | 1 | 2 | null, stopped = false) {
  document.body.classList.toggle('is-working', current === 1 && !stopped);
  stagesEl.hidden = current === null;
  if (current === null) return;
  const names = ['Welcome', 'Set up Hildegard', 'Open the Studio'];
  stagesEl.replaceChildren(
    ...names.map((name, i) => {
      const state = i < current ? 'done' : i === current ? (stopped ? 'stop' : 'cur') : '';
      return h(
        'li',
        { class: state, ...(i === current ? { 'aria-current': 'step' } : {}) },
        h(
          'i',
          { 'aria-hidden': 'true' },
          i < current ? h('span', { class: 'i i-check s14' }) : String(i + 1),
        ),
        name,
        i < current && h('span', { class: 'hd-sr' }, ', done'),
      );
    }),
  );
}

/** Hildegard's ring: the outer gold ring is the install, the inner green ring the computer working. */
function ring(size: number, value: number | null, label = '') {
  const bar = svg('circle', { class: 'bar', cx: '24', cy: '24', r: '21', pathLength: '100' });
  const el = h('div', {
    class: `hg-ring ${value === null ? 'hg-ring--busy' : 'hg-ring--live'}`,
    'aria-hidden': 'true',
  });
  el.style.setProperty('--size', `${size}px`);
  el.append(
    svg(
      'svg',
      { viewBox: '0 0 48 48' },
      svg('circle', { class: 'track', cx: '24', cy: '24', r: '21' }),
      bar,
      svg('circle', { class: 'inner', cx: '24', cy: '24', r: '14', pathLength: '100' }),
      svg('circle', { class: 'core', cx: '24', cy: '24', r: '3' }),
    ),
  );
  const text = h('span', { class: 'hg-ring__label' }, label);
  if (label) el.append(text);
  const set = (v: number, l = '') => {
    bar.style.strokeDasharray = `${Math.max(0.5, Math.min(100, v * 100)).toFixed(2)} 100`;
    text.textContent = l;
  };
  if (value !== null) set(value, label);
  return { el, set };
}

const button = (label: Child, onclick: () => void, kind = '', attrs: Attrs = {}) =>
  h('button', { type: 'button', class: `hg-btn ${kind}`.trim(), onclick, ...attrs }, label);

const primary = (label: string, onclick: () => void) =>
  button(label, onclick, 'hg-btn--primary hg-btn--lg', { 'data-go': true });

const openLogs = () => void invoke('open_logs').catch(() => {});
const logsButton = () => button('Open the logs folder', openLogs, 'hg-btn--ghost hg-btn--lg');

function copyButton(text: string) {
  const label = h('span', { 'aria-live': 'polite' }, 'Copy');
  const copied = () => {
    label.textContent = 'Copied';
    setTimeout(() => {
      label.textContent = 'Copy';
    }, 2000);
  };
  return h(
    'button',
    {
      type: 'button',
      class: 'hg-btn hg-btn--sm hg-btn--ghost hd-copy',
      title: `Copy ${text}`,
      onclick: () => void navigator.clipboard?.writeText(text).then(copied, () => {}),
    },
    h('span', { class: 'i i-copy s16', 'aria-hidden': 'true' }),
    label,
  );
}

/** A command or path to read and copy: the words, and a Copy button beside them. */
const codeLine = (text: string) => h('div', { class: 'hd-code' }, h('code', {}, text), copyButton(text));

/** Text with `backticks` around commands, as the CLI writes them: the commands set as code. */
function rich(text: string) {
  const out = document.createDocumentFragment();
  text.split(/`([^`]+)`/).forEach((part, i) => {
    out.append(i % 2 ? h('code', {}, part) : part);
  });
  return out;
}

const heading = (overline: string | null, title: string, lead?: Child) => [
  overline && h('p', { class: 'ovl' }, overline),
  h('h1', { class: 'hd-h1' }, title),
  lead && h('p', { class: 'hd-lead' }, lead),
];

// ── Finding Hildegard ────────────────────────────────────────────────────────────────────────────────────────────

/** An everyday start: quiet, since most of the time the Studio shows a moment later. */
async function launch(anyway = false) {
  stages(null);
  const started = Date.now();
  const note = h('p', { class: 'hd-wait__note' });
  const signal = show(
    'opening',
    h(
      'div',
      { class: 'hd-wait', role: 'status' },
      ring(56, null).el,
      h('p', { class: 'hd-wait__t' }, 'Opening Hildegard…'),
      note,
    ),
  );
  after(
    6000,
    () => {
      note.textContent =
        'Starting it can take a minute: it checks ComfyUI and your graphics card before the Studio opens.';
      every(1000, () => note.setAttribute('data-clock', clock(Date.now() - started)), signal);
    },
    signal,
  );
  await connect(anyway);
}

async function connect(anyway: boolean) {
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
  stages(null);
  const said = message.replace(/^Hildegard didn[’']t start[.:]?\s*/, '').trim();
  show(
    'failed',
    ...heading(
      'Something went wrong',
      'Hildegard didn’t start.',
      said || 'It stopped before the Studio could open.',
    ),
    h(
      'div',
      { class: 'hd-card' },
      h('p', { class: 'hd-card__t' }, 'What to try'),
      h(
        'ul',
        { class: 'hd-tips' },
        h(
          'li',
          {},
          /answer within/.test(said)
            ? 'Try again. A slow start, the first after an update say, can take longer than the app waits.'
            : 'Try again.',
        ),
        h('li', {}, 'If you just updated a graphics driver, restart the computer first.'),
        log && h('li', {}, 'Still stuck? What Hildegard said is in its log:'),
      ),
      log && codeLine(log),
    ),
    h(
      'div',
      { class: 'hd-acts' },
      primary('Try again', () => launch()),
      logsButton(),
    ),
  );
}

function stopped() {
  stages(null);
  show(
    'stopped',
    mark('hd-mark hd-mark--sm'),
    ...heading(
      null,
      'Hildegard stopped.',
      'It was stopped on this computer, so the Studio closed. Your films are all still here.',
    ),
    h(
      'div',
      { class: 'hd-acts' },
      primary('Start Hildegard', () => launch()),
    ),
  );
}

// ── First run ────────────────────────────────────────────────────────────────────────────────────────────────────

function welcome(data: string, partly: boolean) {
  stages(0);
  const cpu = h('input', { type: 'checkbox', id: 'cpu' }) as HTMLInputElement;
  const promise = (icon: string, text: string) =>
    h('li', {}, h('span', { class: `i i-${icon} s18`, 'aria-hidden': 'true' }), text);
  show(
    'welcome',
    mark('hd-mark'),
    ...heading(
      null,
      partly ? 'Finish setting up Hildegard.' : 'Welcome to Hildegard.',
      partly
        ? 'The hildegard command is here, but ComfyUI and PyTorch aren’t set up yet. This finishes the install, and keeps what’s already done.'
        : 'Your own film studio, on your own graphics card. Hildegard sets up ComfyUI and PyTorch for it, then opens the Studio.',
    ),
    h(
      'ul',
      { class: 'hd-promises' },
      promise('desktop', 'Runs on this computer'),
      promise('privacy', 'Your work stays private'),
      promise('costs', 'Nothing costs money per shot'),
    ),
    h(
      'dl',
      { class: 'hd-facts' },
      h('dt', {}, 'It installs'),
      h('dd', {}, 'ComfyUI and PyTorch for your graphics card, with no admin rights.'),
      h('dt', {}, 'It downloads'),
      h('dd', {}, 'A few gigabytes, mostly PyTorch. Often 5 to 20 minutes.'),
      h('dt', {}, 'Where it goes'),
      h('dd', {}, h('code', {}, data)),
    ),
    h(
      'div',
      { class: 'hd-acts hd-acts--go' },
      h(
        'button',
        { type: 'button', class: 'hd-go', 'data-go': true, onclick: () => install(cpu.checked) },
        h('b', {}, partly ? 'Finish setting up' : 'Install Hildegard'),
        h('small', {}, 'You can close the window while it works'),
      ),
      partly && button('Open the Studio without it', () => launch(true), 'hg-btn--ghost hg-btn--lg'),
    ),
    h(
      'details',
      { class: 'hd-more' },
      h('summary', {}, 'Options'),
      h(
        'label',
        { class: 'hd-check', for: 'cpu' },
        cpu,
        h(
          'span',
          {},
          h('b', {}, 'Use the CPU build of PyTorch'),
          h(
            'small',
            {},
            'For a computer without a graphics card Hildegard can use. Much slower, but it works.',
          ),
        ),
      ),
    ),
  );
}

const WORD: Record<string, string> = {
  done: 'Done',
  skipped: 'Already here',
  'needs-owner': 'Needs you',
  failed: 'Stopped',
  running: 'Working',
  waiting: 'Waiting',
};

/** The install's steps as a list: a glyph and a word for each, so no state rests on colour. */
function stepList(p: Progress) {
  return h(
    'ol',
    { class: 'hd-steps' },
    ...p.rows.map((r, i) => {
      const state = r.status ?? (r.id === p.current ? 'running' : 'waiting');
      const ok = state === 'done' || state === 'skipped';
      const bad = state === 'failed' || state === 'needs-owner';
      const detail = r.status ? splitLog(r.detail).text : '';
      return h(
        'li',
        { class: `hd-step is-${state}`, ...(state === 'running' ? { 'aria-current': 'step' } : {}) },
        h(
          'span',
          { class: 'hd-step__g', 'aria-hidden': 'true' },
          ok
            ? h('span', { class: 'i i-check s14' })
            : bad
              ? h('span', { class: 'i i-alert s14' })
              : state === 'running'
                ? ''
                : String(i + 1),
        ),
        h('span', { class: 'hd-step__t' }, r.title),
        h('span', { class: 'hd-step__d', ...(detail ? { title: detail } : {}) }, detail),
        h('span', { class: 'hd-step__s' }, WORD[state]!),
      );
    }),
  );
}

async function install(cpu: boolean) {
  stages(1);
  let steps: Step[] = [];
  let now = '';
  const started = Date.now();
  const hero = ring(64, 0);
  const title = h('p', { class: 'hd-now__t' });
  const line = h('p', { class: 'hd-now__l' });
  const meta = h('p', { class: 'hd-now__m' });
  const bar = h('div', {
    class: 'hd-now',
    role: 'progressbar',
    'aria-label': 'Install progress',
    'aria-valuemin': '0',
    'aria-valuemax': '100',
    'aria-valuenow': '0',
  });
  bar.append(hero.el, h('div', { class: 'hd-now__words' }, title, line, meta));
  const list = h('div', { class: 'hd-card hd-card--list' });
  const tick = () => {
    const p = progress(steps);
    const pct = Math.round(p.fraction * 100);
    meta.textContent = `${pct}% · ${p.done} of ${p.total} steps · ${clock(Date.now() - started)} so far`;
  };
  const draw = () => {
    const p = progress(steps);
    const pct = Math.round(p.fraction * 100);
    hero.set(p.fraction);
    bar.setAttribute('aria-valuenow', String(pct));
    const cur = p.rows.find((r) => r.id === p.current);
    title.textContent = cur ? cur.title : 'Finishing up';
    line.textContent = now || 'Getting started';
    list.replaceChildren(stepList(p));
    tick();
  };
  const signal = show(
    'installing',
    ...heading('Step 2 of 3', 'Setting up Hildegard.'),
    bar,
    list,
    h(
      'p',
      { class: 'hd-note' },
      'You can close this window. The install carries on, and Hildegard waits in the tray (the menu bar on a Mac).',
    ),
  );
  draw();
  every(1000, tick, signal);

  const events = new Channel<InstallEvent>();
  events.onmessage = (e) => {
    if (e.kind === 'step') {
      steps = report(steps, e.step);
      now = '';
    } else now = nowLine(e.line) ?? now;
    draw();
  };
  let outcome: Outcome;
  try {
    outcome = await invoke<Outcome>('install', { cpu, onEvent: events });
  } catch (e) {
    outcome = { ok: false, needsOwner: false, steps: [], message: String(e) };
  }
  for (const s of outcome.steps) steps = report(steps, s);
  const took = Date.now() - started;
  if (outcome.ok && !outcome.needsOwner) return ready(steps, took);
  const step = blocker(outcome);
  if (cause(`${step?.detail ?? ''} ${outcome.message}`) === 'offline' || navigator.onLine === false)
    return offline(cpu, steps);
  problem(outcome, cpu, steps);
}

/** The install finished: say so, then open the Studio (the install has usually started Hildegard already). */
function ready(steps: Step[], took: number) {
  stages(2);
  const p = progress(steps);
  const note = h('p', { class: 'hd-wait__note' });
  const signal = show(
    'ready',
    ...heading(
      'Step 3 of 3',
      'Hildegard is set up.',
      `All ${p.total} steps done in ${clock(took)}. Everything it needs is on this computer now.`,
    ),
    h(
      'div',
      { class: 'hd-now hd-now--ready', role: 'status' },
      ring(56, null).el,
      h('div', { class: 'hd-now__words' }, h('p', { class: 'hd-now__t' }, 'Opening the Studio…'), note),
    ),
    h(
      'details',
      { class: 'hd-more' },
      h('summary', {}, 'What it set up'),
      h('div', { class: 'hd-card hd-card--list' }, stepList(p)),
    ),
  );
  after(
    6000,
    () => {
      note.textContent = 'The first start checks ComfyUI and your graphics card, so it can take a minute.';
    },
    signal,
  );
  void connect(false);
}

function problem(o: Outcome, cpu: boolean, steps: Step[]) {
  const step = blocker(o);
  const owner = step?.status === 'needs-owner';
  const why = cause(step?.detail ?? o.message);
  const { text, log } = splitLog(step?.detail ?? o.message);
  stages(1, true);
  const lead =
    why === 'disk'
      ? 'The disk is full. Free up a few gigabytes, then try again.'
      : why === 'permission'
        ? 'Hildegard wasn’t allowed to write to its folder. Check you can write to it, then try again.'
        : owner
          ? rich(text)
          : 'It stopped partway through. Trying again picks up where it left off, and keeps what’s already set up.';
  show(
    owner ? 'needs-owner' : 'install-failed',
    ...heading(
      owner ? 'One thing for you' : 'The install stopped',
      owner ? 'Hildegard needs you for this.' : 'The install didn’t finish.',
      lead,
    ),
    h(
      'div',
      { class: `hd-card ${owner ? 'is-owner' : 'is-error'}` },
      h(
        'p',
        { class: 'hd-card__t' },
        h('span', { class: 'i i-alert s16', 'aria-hidden': 'true' }),
        step && step.id !== 'error' ? step.title : 'What happened',
      ),
      !owner && text && h('p', { class: 'hd-card__d' }, rich(text)),
      step?.command &&
        h(
          'p',
          { class: 'hd-card__k' },
          owner ? 'Then press Try again, or run this in a terminal:' : 'This fixes it:',
        ),
      step?.command && codeLine(step.command),
      log && h('p', { class: 'hd-card__k' }, 'The full log:'),
      log && codeLine(log),
    ),
    h(
      'div',
      { class: 'hd-acts' },
      primary('Try again', () => install(cpu)),
      owner && button('Open the Studio anyway', () => launch(true), 'hg-btn--lg'),
      logsButton(),
    ),
    h(
      'details',
      { class: 'hd-more' },
      h('summary', {}, 'Every step'),
      h('div', { class: 'hd-card hd-card--list' }, stepList(progress(steps))),
    ),
  );
}

/** No connection: the install waits for one, and starts again on its own when it's back. */
function offline(cpu: boolean, steps: Step[]) {
  stages(1, true);
  const off = navigator.onLine === false;
  const signal = show(
    'offline',
    ...heading(
      'No connection',
      off ? 'You’re offline.' : 'Hildegard couldn’t connect.',
      'The first install downloads ComfyUI and PyTorch, so it needs the internet for a little while. What’s already set up is kept.',
    ),
    h(
      'div',
      { class: 'hd-card hd-card--wait' },
      h('span', { class: 'hg-status hg-status--queued' }, 'Waiting for a connection'),
      h(
        'p',
        { class: 'hd-card__d' },
        off
          ? 'It starts again on its own when you’re back online.'
          : 'Check your connection, or a firewall or VPN that blocks downloads, then try again.',
      ),
    ),
    h(
      'div',
      { class: 'hd-acts' },
      primary('Try again', () => install(cpu)),
      logsButton(),
    ),
    h(
      'details',
      { class: 'hd-more' },
      h('summary', {}, 'Every step'),
      h('div', { class: 'hd-card hd-card--list' }, stepList(progress(steps))),
    ),
  );
  window.addEventListener('online', () => install(cpu), { once: true, signal });
}

// ── The page ─────────────────────────────────────────────────────────────────────────────────────────────────────

applyTheme();
if (location.hash === '#stopped') stopped();
else void launch();
