/* @ds-bundle: {"format":4,"namespace":"Hildegard","components":[{"name":"Button"},{"name":"Chip"},{"name":"PromptBar"},{"name":"Status"},{"name":"Ring"},{"name":"CostStrip"},{"name":"DeviceCard"},{"name":"JobRow"},{"name":"AppShell"},{"name":"LayoutSwitch"},{"name":"TrayPopover"},{"name":"Icon"}]} */
(function () {
  'use strict';

  /* Interface icons: 24px grid, 1.5px stroke, round caps and joins, drawn in currentColor. */
  var P = {
    studio: '<circle cx="12" cy="12" r="4"/><path d="M12 2.75v2.5M12 18.75v2.5M2.75 12h2.5M18.75 12h2.5M5.46 5.46l1.77 1.77M16.77 16.77l1.77 1.77M5.46 18.54l1.77-1.77M16.77 7.23l1.77-1.77"/>',
    transcribe: '<path d="M4 9.5v5M7 7v10M10 10v4M14 8.5h6M14 12h6M14 15.5h3.5"/>',
    label: '<path d="M3.75 12.1V4.75a1 1 0 0 1 1-1h7.35l8.2 8.2a1.5 1.5 0 0 1 0 2.12l-6.18 6.18a1.5 1.5 0 0 1-2.12 0z"/><circle cx="8.25" cy="8.25" r="1.5"/>',
    image: '<rect x="3.25" y="4.25" width="17.5" height="15.5" rx="2.25"/><path d="M3.5 16.25l4.75-4.75 4.25 4.25 2.5-2.5 5.25 5.25"/><circle cx="15.5" cy="8.75" r="1.5"/>',
    voice: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6"/>',
    music: '<path d="M9 18V5.75l11-2.25V16"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
    video: '<rect x="3" y="6" width="13" height="12" rx="2.25"/><path d="M16 10.5l5-3v9l-5-3"/>',
    model3d: '<path d="M12 2.75l8.25 4.6v9.3L12 21.25l-8.25-4.6v-9.3zM12 12l8.25-4.65M12 12v9.25M12 12L3.75 7.35"/>',
    choir: '<circle cx="12" cy="12" r="8.25"/><circle cx="12" cy="12" r="2.25"/><circle cx="12" cy="3.75" r="1.75" fill="currentColor"/><circle cx="4.85" cy="16.1" r="1.75" fill="currentColor"/><circle cx="19.15" cy="16.1" r="1.75" fill="currentColor"/>',
    queue: '<path d="M4 6.5h16M4 12h16M4 17.5h9"/><path d="M16.5 15.25l3 2.25-3 2.25z" fill="currentColor"/>',
    models: '<path d="M12 3.25l8.75 4.75L12 12.75 3.25 8zM3.25 12.25l8.75 4.75 8.75-4.75M3.25 16.25L12 21l8.75-4.75"/>',
    costs: '<ellipse cx="12" cy="6.25" rx="7.25" ry="2.75"/><path d="M4.75 6.25v5.5c0 1.52 3.25 2.75 7.25 2.75s7.25-1.23 7.25-2.75v-5.5M4.75 11.75v5.5C4.75 18.77 8 20 12 20s7.25-1.23 7.25-2.75v-5.5"/>',
    key: '<circle cx="8" cy="15.5" r="4.25"/><path d="M11 12.5l8.75-8.75M16.25 7.25l2.5 2.5M13.75 9.75l2 2"/>',
    settings: '<path d="M4 7h9M18 7h2M4 17h3M12 17h8"/><circle cx="15.5" cy="7" r="2.25"/><circle cx="9.5" cy="17" r="2.25"/>',
    privacy: '<path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6z"/><path d="M9 12l2.1 2.1L15.25 10"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>',
    pause: '<path d="M8.5 5.5v13M15.5 5.5v13"/>',
    force: '<path d="M5 5.5l6.5 6.5L5 18.5M12.5 5.5L19 12l-6.5 6.5"/>',
    close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
    chevron: '<path d="M6.5 9.5l5.5 5.5 5.5-5.5"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    alert: '<path d="M12 4l9 15.5H3z"/><path d="M12 10v4.25M12 17v.25"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.25 4.25"/>',
    more: '<circle cx="5.5" cy="12" r="1.25" fill="currentColor"/><circle cx="12" cy="12" r="1.25" fill="currentColor"/><circle cx="18.5" cy="12" r="1.25" fill="currentColor"/>',
    desktop: '<rect x="3" y="4.25" width="18" height="12.25" rx="1.75"/><path d="M8.5 20h7M12 16.5V20"/>',
    tablet: '<rect x="4.75" y="2.75" width="14.5" height="18.5" rx="2.5"/><path d="M10.75 18h2.5"/>',
    phone: '<rect x="7" y="2.75" width="10" height="18.5" rx="2.5"/><path d="M10.75 18.25h2.5"/>',
    auto: '<rect x="2.75" y="5" width="12.5" height="9.5" rx="1.5"/><rect x="16.5" y="8.5" width="4.75" height="10.5" rx="1.25"/><path d="M6.5 18.5h6"/>',
    laptop: '<rect x="5" y="5" width="14" height="10" rx="1.5"/><path d="M2.75 18.5h18.5"/>',
    server: '<rect x="4" y="3.75" width="16" height="7" rx="1.5"/><rect x="4" y="13.25" width="16" height="7" rx="1.5"/><path d="M7.5 7.25h.01M7.5 16.75h.01"/>',
    download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M4.5 19.5h15"/>',
    upload: '<path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M4.5 19.5h15"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v1.5M12 19.5V21M3 12h1.5M19.5 12H21M5.6 5.6l1.06 1.06M17.34 17.34l1.06 1.06M5.6 18.4l1.06-1.06M17.34 6.66l1.06-1.06"/>',
    moon: '<path d="M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10z"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    qr: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5zM14 19.5h1M19.5 14v1"/>'
  };

  function icon(name, size, label) {
    var s = size || 20;
    var body = P[name] || P.more;
    var a11y = label ? 'role="img" aria-label="' + String(label).replace(/"/g, '&quot;') + '"' : 'aria-hidden="true"';
    return '<svg class="hg-icon" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' +
      (s <= 16 ? 2 : 1.5) + '" stroke-linecap="round" stroke-linejoin="round" ' + a11y + '>' + body + '</svg>';
  }

  /* Replace every <i data-icon="name" data-size="20"></i> under root with the inline icon. */
  function hydrate(root) {
    var nodes = (root || document).querySelectorAll('i[data-icon]');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var tmp = document.createElement('span');
      tmp.innerHTML = icon(n.getAttribute('data-icon'), +n.getAttribute('data-size') || 20, n.getAttribute('aria-label'));
      n.parentNode.replaceChild(tmp.firstChild, n);
    }
  }

  /* Window classes. Breakpoints mirror tokens bp-medium, bp-expanded, bp-wide. */
  var BP = { medium: 600, expanded: 840, wide: 1280 };
  function classFor(w) { return w >= BP.wide ? 'wide' : w >= BP.expanded ? 'expanded' : w >= BP.medium ? 'medium' : 'compact'; }
  var FORCED = { phone: 'compact', tablet: 'medium', desktop: 'expanded' };
  var KEY = 'hildegard.layout';

  function readMode() { try { return localStorage.getItem(KEY) || 'auto'; } catch (e) { return 'auto'; } }
  function saveMode(m) { try { localStorage.setItem(KEY, m); } catch (e) { /* storage blocked: mode lasts this visit */ } }

  /* Desktop layout on a phone or tablet browser: widen the viewport like "Request desktop site", keep pinch zoom. */
  function setViewport(mode) {
    var meta = document.querySelector('meta[name="viewport"]');
    if (!meta || window.parent !== window) return;
    var narrow = Math.min(screen.width, screen.height) < 1024;
    meta.setAttribute('content', mode === 'desktop' && narrow
      ? 'width=1280, viewport-fit=cover'
      : 'width=device-width, initial-scale=1, viewport-fit=cover');
  }

  function apply(app) {
    var mode = app.getAttribute('data-layout') || 'auto';
    /* Measure the space the app may fill, not the app: a forced Phone layout narrows the app itself. */
    var w = app.parentElement ? app.parentElement.clientWidth : app.clientWidth;
    var natural = classFor(w);
    var wc = mode === 'auto' ? natural : mode === 'desktop' ? (natural === 'wide' ? 'wide' : 'expanded') : FORCED[mode];
    app.setAttribute('data-wc', wc);
    if (mode !== 'auto' && wc !== natural) app.setAttribute('data-forced', ''); else app.removeAttribute('data-forced');
  }

  /* opts.app limits the change to one app (side-by-side previews); otherwise every app on the page follows. */
  function setLayout(mode, opts) {
    opts = opts || {};
    var apps = opts.app ? [opts.app] : document.querySelectorAll('.hg-app');
    for (var i = 0; i < apps.length; i++) { apps[i].setAttribute('data-layout', mode); apply(apps[i]); }
    if (opts.persist !== false) saveMode(mode);
    if (!opts.app) setViewport(mode);
    syncSwitches();
  }

  function syncSwitches() {
    var groups = document.querySelectorAll('[data-hg-layout-switch]');
    for (var g = 0; g < groups.length; g++) {
      var app = groups[g].closest('.hg-app') || document.querySelector('.hg-app');
      var mode = app ? app.getAttribute('data-layout') || 'auto' : readMode();
      var bs = groups[g].querySelectorAll('[data-mode]');
      for (var i = 0; i < bs.length; i++) bs[i].setAttribute('aria-checked', String(bs[i].getAttribute('data-mode') === mode));
    }
  }

  function watch(app, opts) {
    if (!app.hasAttribute('data-layout')) app.setAttribute('data-layout', (opts && opts.mode) || readMode());
    apply(app);
    syncSwitches();
    if (window.ResizeObserver) new ResizeObserver(function () { apply(app); }).observe(app.parentElement || app);
  }

  /* Layout switch clicks, anywhere on the page. */
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-hg-layout-switch] [data-mode]');
    if (!b) return;
    var group = b.closest('[data-hg-layout-switch]');
    var own = group.closest('.hg-app');
    var scoped = group.getAttribute('data-hg-layout-switch') === 'local' || (own && document.querySelectorAll('.hg-app').length > 1);
    setLayout(b.getAttribute('data-mode'), scoped && own ? { app: own, persist: false } : {});
  });

  function boot() {
    hydrate(document);
    var apps = document.querySelectorAll('.hg-app');
    for (var i = 0; i < apps.length; i++) watch(apps[i]);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.Hildegard = {
    icons: P, icon: icon, hydrate: hydrate,
    breakpoints: BP, windowClass: classFor,
    setLayout: setLayout, watch: watch,
    Button: 'hg-btn', Chip: 'hg-chip', PromptBar: 'hg-prompt', Status: 'hg-status', Ring: 'hg-ring',
    CostStrip: 'hg-strip', DeviceCard: 'hg-device', JobRow: 'hg-job', AppShell: 'hg-app',
    LayoutSwitch: 'hg-layout-switch', TrayPopover: 'hg-tray', Icon: 'hg-icon'
  };
})();
