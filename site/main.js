// SPDX-License-Identifier: AGPL-3.0-only
// The install page: shows the work, picks the visitor's computer, keeps every set of OS tabs in step, and copies
// commands.

// Where the release files live. The short dbaney.com/hildegard/install.sh and install.ps1 links redirect here.
const RELEASE = 'https://github.com/baney75/hildegard/releases/latest/download/';

// The desktop app's file for each computer. Fix the names here once the desktop build settles them.
const DESKTOP = {
  windows: 'Hildegard_x64-setup.exe',
  mac: 'Hildegard_aarch64.dmg',
  linux: 'Hildegard_amd64.AppImage',
  omarchy: 'Hildegard_amd64.AppImage',
};

// The stills on the page, each a frame from a real take. The file sits in img/work/. Every caption is what Hildegard
// recorded for that take: the prompt word for word as the director wrote it, the rig, the model, the GPU and the
// render time in seconds. Never write a caption for a render that didn't happen. The first one marked hero leads the
// page (its file is also preloaded in index.html); the rest fill the gallery in this order.
const WORK = [
  {
    file: 'illuminator-quill.webp',
    hero: true,
    film: 'The Illuminator',
    shot: 2,
    prompt:
      'Close on the parchment: a quill pen paints deep blue and red ink into an ornate illuminated capital letter bordered with gold leaf',
    rig: ['Full-frame cinema', 'Vintage anamorphic', '50mm', 'f/2.0'],
    model: 'Wan 2.2 5B',
    gpu: 'RTX 4080 Laptop GPU',
    take: '5 s at 24 fps',
    seconds: 730,
  },
  {
    file: 'lighthouse-headland.webp',
    film: 'The Lighthouse Keeper',
    shot: 1,
    prompt:
      'A weathered white lighthouse alone on an empty rocky headland at dusk, its great lamp glowing, waves breaking white on the rocks below, wide static landscape with no people',
    rig: ['Vintage 16mm', 'Clean modern', '35mm', 'f/2.8'],
    model: 'Wan 2.2 5B',
    gpu: 'RTX 4080 Laptop GPU',
    take: '5 s at 24 fps',
    seconds: 725,
  },
  {
    file: 'lighthouse-keeper.webp',
    width: 1440,
    film: 'The Lighthouse Keeper',
    shot: 4,
    prompt:
      'An old bearded lighthouse keeper in a wool sweater stands at the iron railing of the lighthouse balcony at dusk, looking out at the dark sea as the lamp beam sweeps overhead',
    rig: ['Vintage 16mm', 'Clean modern', '35mm', 'f/2.8'],
    model: 'Wan 2.2 5B',
    gpu: 'RTX 4080 Laptop GPU',
    take: '5 s at 24 fps',
    seconds: 727,
  },
  {
    file: 'neon-raincoat.webp',
    film: 'Neon Rain',
    shot: 2,
    prompt:
      'A woman in a red raincoat walks past a glowing noodle shop window, steam rising from the kitchen, rain falling',
    rig: ['DV camcorder', 'Clean modern', '24mm', 'f/2.8'],
    model: 'Wan 2.2 5B',
    gpu: 'RTX 4080 Laptop GPU',
    take: '5 s at 24 fps',
    seconds: 735,
  },
  {
    file: 'caravan-dune.webp',
    film: 'Caravan',
    shot: 1,
    prompt:
      'A camel caravan crosses tall rippled sand dunes in single file at sunset, long shadows stretching across the sand',
    rig: ['Super 35', 'Clean modern', '35mm', 'f/4.0'],
    model: 'Wan 2.2 5B',
    gpu: 'RTX 4080 Laptop GPU',
    take: '5 s at 24 fps',
    seconds: 739,
  },
  {
    file: 'golden-hour-sea-stack.webp',
    film: 'Golden Hour',
    shot: 2,
    prompt: 'A lone dark sea stack rises from the surf at golden hour, waves washing white around its base',
    rig: ['Full-frame cinema', 'Clean modern', '35mm', 'f/2.8'],
    model: 'Wan 2.2 5B',
    gpu: 'RTX 4080 Laptop GPU',
    take: '5 s at 24 fps',
    seconds: 731,
  },
];

const NAMES = { windows: 'Windows', mac: 'macOS', linux: 'Linux', omarchy: 'Omarchy' };
const OSES = Object.keys(NAMES);
const KEY = 'hildegard.install.os';

/** The visitor's computer, from the browser. Omarchy looks like any Linux, so it's chosen by hand or by #omarchy. */
function detect() {
  const hint = (navigator.userAgentData?.platform || navigator.platform || '').toLowerCase();
  const ua = navigator.userAgent.toLowerCase();
  if (/android|iphone|ipad|ipod/.test(ua) || (hint === 'macintel' && navigator.maxTouchPoints > 1))
    return null;
  if (hint.startsWith('win') || ua.includes('windows')) return 'windows';
  if (hint.startsWith('mac') || ua.includes('mac os')) return 'mac';
  if (hint.includes('linux') || ua.includes('linux') || ua.includes('x11')) return 'linux';
  return null;
}

function remembered() {
  try {
    const v = localStorage.getItem(KEY);
    return OSES.includes(v) ? v : null;
  } catch {
    return null;
  }
}

function remember(os) {
  try {
    localStorage.setItem(KEY, os);
  } catch {}
}

const fromHash = () => {
  const h = location.hash.slice(1);
  return OSES.includes(h) ? h : null;
};

const detected = detect();
const mobile = detected === null && /android|iphone|ipad|ipod/.test(navigator.userAgent.toLowerCase());
let current = fromHash() || remembered() || detected || 'windows';

/** Shows one computer's commands everywhere on the page. */
function select(os, focus) {
  current = os;
  for (const list of document.querySelectorAll('[data-os-tabs]')) {
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    const match = tabs.find((t) => t.dataset.os.split(' ').includes(os)) || tabs[0];
    for (const t of tabs) {
      const on = t === match;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    }
    if (focus === list) match.focus();
  }
  for (const el of document.querySelectorAll('[data-os-text]'))
    el.hidden = !el.dataset.osText.split(' ').includes(os);
  heroButton(os);
}

/** The hero's big button: the desktop app for this computer. */
function heroButton(os) {
  const a = document.querySelector('.hero [data-desktop]');
  const label = document.querySelector('[data-desktop-label]');
  const meta = document.querySelector('[data-desktop-meta]');
  if (!a || !label || !meta) return;
  if (mobile) {
    a.href = '#install';
    label.textContent = 'Get it for your computer';
    meta.textContent = 'Hildegard runs on a computer with a GPU. Your phone can use it at a link.';
    return;
  }
  const target = os === 'omarchy' ? 'linux' : os;
  a.href = RELEASE + DESKTOP[target];
  label.textContent = `Download for ${target === 'mac' ? 'Mac' : NAMES[target]}`;
  meta.replaceChildren(
    'Free and open source. ',
    Object.assign(document.createElement('span'), { className: 'mono', textContent: DESKTOP[target] }),
  );
}

function wireTabs() {
  for (const list of document.querySelectorAll('[data-os-tabs]')) {
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    list.addEventListener('click', (e) => {
      const tab = e.target.closest('[role="tab"]');
      if (!tab) return;
      const os = tab.dataset.os.split(' ')[0];
      select(os);
      remember(os);
    });
    list.addEventListener('keydown', (e) => {
      const i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      const next = {
        ArrowRight: (i + 1) % tabs.length,
        ArrowDown: (i + 1) % tabs.length,
        ArrowLeft: (i - 1 + tabs.length) % tabs.length,
        ArrowUp: (i - 1 + tabs.length) % tabs.length,
        Home: 0,
        End: tabs.length - 1,
      }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      const os = tabs[next].dataset.os.split(' ')[0];
      select(os, list);
      remember(os);
    });
  }
  for (const a of document.querySelectorAll('[data-go-os]')) {
    a.addEventListener('click', () => {
      select(a.dataset.goOs);
      remember(a.dataset.goOs);
    });
  }
}

function fillLinks() {
  for (const a of document.querySelectorAll('a[data-desktop]:not(.hero [data-desktop])')) {
    a.href = RELEASE + DESKTOP[a.dataset.desktop];
  }
  for (const el of document.querySelectorAll('[data-file]')) el.textContent = DESKTOP[el.dataset.file];
  for (const el of document.querySelectorAll('[data-release-base]'))
    el.textContent = RELEASE.replace(/\/$/, '');
}

const live = () => document.querySelector('[data-live]');

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers, or a page served without a secure context.
    const area = Object.assign(document.createElement('textarea'), { value: text });
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {}
    area.remove();
    return ok;
  }
}

function wireCopy() {
  for (const btn of document.querySelectorAll('button.copy')) {
    const label = btn.querySelector('.copy__label');
    const idle = label?.textContent ?? '';
    const use = btn.querySelector('use');
    btn.addEventListener('click', async () => {
      const target = btn.dataset.copyTarget
        ? document.getElementById(btn.dataset.copyTarget)
        : btn.closest('.cmd')?.querySelector('pre');
      const text = btn.dataset.copy ?? target?.textContent.trim() ?? '';
      const ok = text !== '' && (await copyText(text));
      if (label) label.textContent = ok ? 'Copied' : 'Select and copy';
      if (use && ok) use.setAttribute('href', '#i-check');
      btn.toggleAttribute('data-copied', ok);
      const say = live();
      if (say) say.textContent = ok ? 'Copied.' : 'Couldn’t copy. Select the text and copy it yourself.';
      clearTimeout(btn._t);
      btn._t = setTimeout(() => {
        if (label) label.textContent = idle;
        if (use) use.setAttribute('href', '#i-copy');
        btn.removeAttribute('data-copied');
      }, 1800);
    });
  }
}

function sayDetected() {
  const el = document.querySelector('[data-detected]');
  if (!el) return;
  if (mobile) el.textContent = 'Hildegard runs on a computer. Open this page there, or pick one below.';
  else if (detected === 'linux' && current === 'linux')
    el.textContent = 'We picked Linux from your browser. On Omarchy? It has its own tab.';
  else if (detected && detected === current)
    el.textContent = `We picked ${NAMES[detected]} from your browser.`;
}

// The work: captions, the gallery and the larger view.

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
const slate = (w) => `${w.film}, shot ${ROMAN[w.shot] || w.shot}`;
const minutes = (s) => `${Math.floor(s / 60)} min ${s % 60} s`;
const el = (tag, className, text) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
};
const dot = () => el('span', 'dot');
/** Text pieces with a small dot between each, as the Studio prints settings. */
function dotted(parts, className) {
  const out = [];
  parts.forEach((p, i) => {
    if (i) out.push(dot());
    out.push(typeof p === 'string' ? el('span', className, p) : p);
  });
  return out;
}
const time = (w) => el('span', 'num', minutes(w.seconds));
const metaLine = (w) => dotted([w.model, w.gpu, Object.assign(time(w), { title: `${w.seconds} seconds` })]);
const quoted = (text) => `\u201c${text}\u201d`;

function fillHero() {
  const w = WORK.find((x) => x.hero);
  const fig = w && document.querySelector(`[data-work="${w.file}"]`);
  if (!fig) return;
  fig.querySelector('[data-w-img]').alt = `A frame from ${slate(w)}.`;
  fig.querySelector('[data-w-slate]').textContent = slate(w);
  fig.querySelector('[data-w-take]').textContent = w.take;
  fig.querySelector('[data-w-rig]').replaceChildren(...w.rig.map((r) => el('span', '', r)));
  fig.querySelector('[data-w-prompt]').textContent = quoted(w.prompt);
  fig.querySelector('[data-w-meta]').replaceChildren(...metaLine(w));
}

function fillGallery() {
  const box = document.querySelector('[data-gallery]');
  if (!box) return;
  for (const w of WORK.filter((x) => !x.hero)) {
    const fig = el('figure', 'still reveal');
    const open = el('button', 'still__open');
    open.type = 'button';
    open.dataset.openWork = w.file;
    open.setAttribute('aria-label', `See ${slate(w)} larger`);
    const img = Object.assign(document.createElement('img'), {
      src: `img/work/${w.file}`,
      alt: '',
      width: w.width || 1600,
      height: Math.round(((w.width || 1600) * 704) / 1248),
      loading: 'lazy',
      decoding: 'async',
    });
    const zoom = el('span', 'still__zoom');
    zoom.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-expand"/></svg>';
    open.append(img, zoom);
    const cap = el('figcaption', 'still__cap');
    cap.append(
      el('p', 'still__slate', slate(w)),
      el('p', 'still__prompt', quoted(w.prompt)),
      el('p', 'still__rig'),
      el('p', 'still__meta'),
    );
    cap.children[2].append(...dotted(w.rig));
    cap.children[3].append(...metaLine(w));
    fig.append(open, cap);
    box.append(fig);
  }
}

function wireLightbox() {
  const box = document.querySelector('[data-lightbox]');
  if (!box || typeof box.showModal !== 'function') return;
  const img = box.querySelector('[data-lb-img]');
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-open-work]');
    if (btn) {
      const w = WORK.find((x) => x.file === btn.dataset.openWork);
      if (!w) return;
      img.src = `img/work/${w.file}`;
      img.alt = `A frame from ${slate(w)}.`;
      box.querySelector('[data-lb-title]').textContent = slate(w);
      box.querySelector('[data-lb-prompt]').textContent = quoted(w.prompt);
      box
        .querySelector('[data-lb-meta]')
        .replaceChildren(...dotted([...w.rig, w.model, w.gpu, w.take]), dot(), time(w));
      box.showModal();
      return;
    }
    // A click on the dark surround closes it.
    if (e.target === box) box.close();
  });
}

/** Sections rise in once as they come into view. Without motion, or without IntersectionObserver, they're just there. */
function wireReveal() {
  const items = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window)) return;
  document.documentElement.classList.add('motion');
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add('in');
        io.unobserve(e.target);
      }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
  );
  for (const i of items) io.observe(i);
}

function wireTop() {
  const top = document.querySelector('[data-top]');
  if (!top) return;
  const on = () => top.toggleAttribute('data-scrolled', window.scrollY > 8);
  on();
  window.addEventListener('scroll', on, { passive: true });
}

fillHero();
fillGallery();
wireLightbox();
wireReveal();
wireTop();
fillLinks();
wireTabs();
wireCopy();
select(current);
sayDetected();
window.addEventListener('hashchange', () => {
  const os = fromHash();
  if (os) select(os);
});
