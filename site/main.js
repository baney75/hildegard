// SPDX-License-Identifier: AGPL-3.0-only
// The install page: picks the visitor's computer, keeps every set of OS tabs in step, and copies commands.

// Where the release files live. The short dbaney.com/hildegard/install.sh and install.ps1 links redirect here.
const RELEASE = 'https://github.com/baney75/hildegard/releases/latest/download/';

// The desktop app's file for each computer. Fix the names here once the desktop build settles them.
const DESKTOP = {
  windows: 'Hildegard_x64.msi',
  mac: 'Hildegard_aarch64.dmg',
  linux: 'Hildegard_amd64.AppImage',
  omarchy: 'Hildegard_amd64.AppImage',
};

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

fillLinks();
wireTabs();
wireCopy();
select(current);
sayDetected();
window.addEventListener('hashchange', () => {
  const os = fromHash();
  if (os) select(os);
});
