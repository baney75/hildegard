// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef } from 'react';
import mark from './assets/mark-vellum.svg';
import { Icon, Toasts } from './components/ui.tsx';
import { reconcile } from './lib/draft.ts';
import { type LayoutMode, useHashRoute, useLocal, useWindowClass } from './lib/hooks.ts';
import { useStore } from './lib/store.ts';
import { Agents } from './pages/Agents.tsx';
import { Cinema } from './pages/Cinema.tsx';
import { Queue } from './pages/Queue.tsx';
import { Settings } from './pages/Settings.tsx';
import { Welcome } from './pages/Welcome.tsx';

const NAV = [
  { to: '/', match: /^\/($|film)/, label: 'Cinema', icon: 'film' },
  { to: '/agents', match: /^\/agents/, label: 'Agents', icon: 'agent' },
  { to: '/queue', match: /^\/queue/, label: 'Queue', icon: 'queue' },
  { to: '/settings', match: /^\/settings/, label: 'Settings', icon: 'settings' },
];

export function App() {
  const ready = useStore((s) => s.ready);
  const loadError = useStore((s) => s.loadError);
  const catalog = useStore((s) => s.catalog);
  const conn = useStore((s) => s.conn);
  const engine = useStore((s) => s.engine);
  const projects = useStore((s) => s.projects);
  const models = useStore((s) => s.models);
  const busy = useStore((s) => {
    let n = 0;
    for (const t of s.takes.values()) if (t.status === 'queued' || t.status === 'running') n++;
    return n;
  });
  const [route, go] = useHashRoute();
  const [layout] = useLocal<LayoutMode>('hildegard.layout', 'auto');
  const [welcomed, setWelcomed] = useLocal('hildegard.welcomed', false);
  const app = useRef<HTMLDivElement>(null);
  const { wc, forced } = useWindowClass(app, layout);

  useEffect(() => {
    if (catalog) reconcile(catalog);
  }, [catalog]);

  useEffect(() => {
    const page = NAV.find((n) => n.match.test(route))?.label ?? 'Cinema';
    document.title = busy ? `(${busy}) ${page} · Hildegard` : `${page} · Hildegard`;
  }, [route, busy]);

  if (!ready || !catalog) {
    return (
      <div className="hg-boot" role="status" aria-live="polite">
        <img src={mark} alt="" width={56} height={56} />
        <span>{loadError ? `${loadError} Trying again…` : 'Opening Hildegard…'}</span>
      </div>
    );
  }

  const firstRun =
    !welcomed && projects.size === 0 && !models.some((m) => m.installed || m.downloading) && !engine?.fake;
  if (firstRun) return <Welcome catalog={catalog} onDone={() => setWelcomed(true)} go={go} />;

  const parts = route.split('/').filter(Boolean);
  let page: React.ReactNode;
  if (parts[0] === 'queue') page = <Queue catalog={catalog} wc={wc} go={go} />;
  else if (parts[0] === 'agents') page = <Agents wc={wc} />;
  else if (parts[0] === 'settings')
    page = <Settings catalog={catalog} wc={wc} section={parts[1] ?? null} go={go} />;
  else
    page = (
      <Cinema
        catalog={catalog}
        wc={wc}
        go={go}
        projectParam={parts[0] === 'film' ? (parts[1] ?? null) : null}
        takeParam={parts[2] === 'take' ? (parts[3] ?? null) : null}
      />
    );

  const item = (n: (typeof NAV)[number], cls: string, size?: 22) => (
    <a key={n.to} className={cls} href={`#${n.to}`} aria-current={n.match.test(route) ? 'page' : undefined}>
      <Icon name={n.icon} size={size} />
      <span>{n.label}</span>
      {n.to === '/queue' && busy ? (
        <>
          <span className="hg-nav-item__badge" aria-hidden="true">
            {busy}
          </span>
          <span className="sr">, {busy} in the queue</span>
        </>
      ) : null}
    </a>
  );

  return (
    <div className="hg-root">
      <a className="hg-skip" href="#main">
        Skip to content
      </a>
      <div ref={app} className="hg-app cs-v2" data-wc={wc} data-forced={forced ? '' : undefined}>
        <nav className="hg-app__nav st-nav" aria-label="Main">
          <div className="hg-app__brand">
            <img src={mark} alt="Hildegard" height={30} />
          </div>
          {NAV.slice(0, 3).map((n) => item(n, 'hg-nav-item'))}
          <div className="hg-app__navfoot">{item(NAV[3]!, 'hg-nav-item')}</div>
        </nav>
        {page}
        <nav className="hg-tabbar" aria-label="Main">
          {NAV.map((n) => item(n, 'hg-tab', 22))}
        </nav>
      </div>
      {conn === 'down' ? (
        <div className="hg-offline" role="alert">
          <Icon name="alert" size={18} />
          Lost touch with Hildegard on this computer. Reconnecting…
        </div>
      ) : null}
      <Toasts />
    </div>
  );
}
