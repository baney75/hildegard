// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef } from 'react';
import markGreen from './assets/mark-green.svg';
import markVellum from './assets/mark-vellum.svg';
import { Icon, Toasts } from './components/ui.tsx';
import { reconcile } from './lib/draft.ts';
import { type LayoutMode, useHashRoute, useLocal, useWindowClass } from './lib/hooks.ts';
import { allowedIn, isOwner, useStore } from './lib/store.ts';
import { useTheme } from './lib/theme.ts';
import { Agents } from './pages/Agents.tsx';
import { Cinema } from './pages/Cinema.tsx';
import { Queue } from './pages/Queue.tsx';
import { Settings } from './pages/Settings.tsx';
import { AcceptInvite, SignIn } from './pages/SignIn.tsx';
import { Voice } from './pages/Voice.tsx';
import { ConsentPhone } from './pages/voice/ConsentPhone.tsx';
import { Welcome } from './pages/Welcome.tsx';

const NAV = [
  { to: '/', match: /^\/($|film)/, label: 'Cinema', icon: 'film' },
  { to: '/voice', match: /^\/voice/, label: 'Voice', icon: 'voice' },
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
  const auth = useStore((s) => s.auth);
  const busy = useStore((s) => {
    // Paired devices' renders count too: they hold the GPU just the same.
    let n = s.guests.length;
    for (const t of s.takes.values()) if (t.status === 'queued' || t.status === 'running') n++;
    return n;
  });
  const [route, go] = useHashRoute();
  const [layout] = useLocal<LayoutMode>('hildegard.layout', 'auto');
  const [welcomed, setWelcomed] = useLocal('hildegard.welcomed', false);
  const app = useRef<HTMLDivElement>(null);
  const { wc, forced } = useWindowClass(app, layout);
  // The mark is drawn in vellum on dark grounds and in green on vellum.
  const mark = useTheme().theme === 'light' ? markGreen : markVellum;

  useEffect(() => {
    if (catalog) reconcile(catalog);
  }, [catalog]);

  useEffect(() => {
    if (/^\/consent\//.test(route)) {
      document.title = 'Your consent · Hildegard';
      return;
    }
    const page =
      auth && !auth.local && /^\/invite\//.test(route)
        ? 'Your invite'
        : auth && !allowedIn(auth)
          ? 'Sign in'
          : (NAV.find((n) => n.match.test(route))?.label ?? 'Cinema');
    document.title = busy ? `(${busy}) ${page} · Hildegard` : `${page} · Hildegard`;
  }, [route, busy, auth]);

  // A consent link, opened on the speaker's own phone: it needs no account and shows nothing else.
  const consent = /^\/consent\/([A-Za-z0-9_-]{20,64})$/.exec(route)?.[1];
  if (consent) return <ConsentPhone token={consent} />;
  // An invite link, opened on another device: it signs up whoever opens it, so it comes before anything else.
  const invite = /^\/invite\/([A-Za-z0-9_-]{43})$/.exec(route)?.[1];
  if (invite && auth && !auth.local) return <AcceptInvite token={invite} go={go} />;
  if (auth && !allowedIn(auth)) return <SignIn />;

  if (!ready || !catalog) {
    return (
      <div className="hg-boot" role="status" aria-live="polite">
        <img src={mark} alt="" width={56} height={56} />
        <span>{loadError ? `${loadError} Trying again…` : 'Opening Hildegard…'}</span>
      </div>
    );
  }

  // The welcome sets up models, which is the owner's to do.
  const firstRun =
    isOwner(auth) &&
    !welcomed &&
    projects.size === 0 &&
    !models.some((m) => m.installed || m.downloading) &&
    !engine?.fake;
  // Linked AI apps and voices run on the computer Hildegard runs on: the owner's.
  const nav = isOwner(auth) ? NAV : NAV.filter((n) => n.to !== '/agents' && n.to !== '/voice');
  if (firstRun) return <Welcome catalog={catalog} onDone={() => setWelcomed(true)} go={go} />;

  const parts = route.split('/').filter(Boolean);
  let page: React.ReactNode;
  if (parts[0] === 'queue') page = <Queue catalog={catalog} wc={wc} go={go} />;
  else if (parts[0] === 'agents' && isOwner(auth)) page = <Agents wc={wc} />;
  else if (parts[0] === 'voice' && isOwner(auth)) page = <Voice parts={parts} wc={wc} go={go} />;
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
          {nav.slice(0, -1).map((n) => item(n, 'hg-nav-item'))}
          <div className="hg-app__navfoot">{item(nav.at(-1)!, 'hg-nav-item')}</div>
        </nav>
        {page}
        <nav className="hg-tabbar" aria-label="Main">
          {nav.map((n) => item(n, 'hg-tab', 22))}
        </nav>
      </div>
      {conn === 'down' ? (
        <div className="hg-offline" role="alert">
          <Icon name="alert" size={18} />
          {auth?.local ? 'Lost touch with Hildegard on this computer.' : 'Lost touch with Hildegard.'}{' '}
          Reconnecting…
        </div>
      ) : null}
      <Toasts />
    </div>
  );
}
