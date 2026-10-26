// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The canvas's helper inside a previewed page. The Studio shows a site's pages in frames at phone, tablet and desktop
 * width; this script, added to those previews only, outlines what the pointer is over, tells the Studio what was
 * clicked (its tag, classes, words and computed styles), and applies token changes at once while the file is being
 * saved. It runs in the page's sandbox, which has no address of its own and can't reach Hildegard's API; it talks to
 * the Studio only by postMessage, and the Studio checks every message comes from its own frame.
 */
export const CANVAS_SCRIPT = `(() => {
  if (window.parent === window) return;
  const post = (m) => window.parent.postMessage(Object.assign({ hildegard: 'canvas' }, m), '*');
  const box = document.createElement('div');
  box.setAttribute('aria-hidden', 'true');
  box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #d6249f;border-radius:2px;display:none;box-sizing:border-box';
  const pick = document.createElement('div');
  pick.setAttribute('aria-hidden', 'true');
  pick.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;outline:2px solid #2f6fed;outline-offset:1px;display:none';
  const mount = () => document.body && !box.isConnected && document.body.append(box, pick);
  const place = (el, b) => {
    if (!el) { b.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    Object.assign(b.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  };
  const path = (el) => {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && e !== document.documentElement && parts.length < 6; e = e.parentElement) {
      let s = e.tagName.toLowerCase();
      if (e.id) { parts.unshift(s + '#' + e.id); break; }
      const cls = [...e.classList].slice(0, 2);
      if (cls.length) s += '.' + cls.join('.');
      parts.unshift(s);
    }
    return parts.join(' > ');
  };
  const KEYS = ['font-family','font-size','font-weight','line-height','letter-spacing','color','background-color','padding','margin','gap','width','height','border-radius','display','grid-template-columns','flex-direction'];
  let chosen = null;
  const describe = (el) => {
    const cs = getComputedStyle(el);
    const styles = {};
    for (const k of KEYS) styles[k] = cs.getPropertyValue(k);
    const own = [...el.childNodes].every((n) => n.nodeType === 3 || (n.nodeType === 1 && /^(B|STRONG|EM|I|SPAN|A|BR|SMALL|ABBR|CODE)$/.test(n.tagName)));
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(), id: el.id || null, classes: [...el.classList].slice(0, 8), path: path(el),
      text: own ? el.textContent.replace(/\\s+/g, ' ').trim().slice(0, 2000) : null,
      alt: el.tagName === 'IMG' ? el.getAttribute('alt') : null,
      src: el.tagName === 'IMG' ? el.getAttribute('src') : null,
      size: [Math.round(r.width), Math.round(r.height)], styles,
    };
  };
  document.addEventListener('mousemove', (e) => { mount(); place(e.target === document.documentElement ? null : e.target, box); }, true);
  document.addEventListener('mouseleave', () => place(null, box));
  document.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    chosen = e.target;
    mount(); place(chosen, pick);
    post({ type: 'select', page: location.pathname.split('/').slice(4).join('/') || 'index.html', element: describe(chosen) });
  }, true);
  document.addEventListener('submit', (e) => e.preventDefault(), true);
  addEventListener('scroll', () => { place(chosen, pick); }, true);
  addEventListener('resize', () => { place(chosen, pick); });
  addEventListener('message', (e) => {
    if (e.source !== window.parent || !e.data || e.data.hildegard !== 'studio') return;
    const m = e.data;
    if (m.type === 'token' && /^--[\\w-]{1,80}$/.test(m.name) && typeof m.value === 'string' && !/[;{}<>]/.test(m.value))
      document.documentElement.style.setProperty(m.name, m.value);
    if (m.type === 'clear') { chosen = null; place(null, pick); }
  });
  post({ type: 'ready', title: document.title });
})();`;
