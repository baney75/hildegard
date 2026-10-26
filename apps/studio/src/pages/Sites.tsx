// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Sites: websites made here, and the canvas to see and change them. A site starts from a template, a Figma link, a
 * pen.dev file, a live page or a ZIP; the canvas shows its pages live at phone, tablet and desktop width at once, and
 * a click on anything in a frame shows what it is and how it's styled. Words and design tokens change right there;
 * everything else is for a linked AI app, which sees the same site through its tools, and the frames reload as it
 * writes.
 */
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button, Icon, Menu, Modal, Segmented, toast, toastError } from '../components/ui.tsx';
import {
  ApiError,
  api,
  type NewSite,
  type SiteDetail,
  type SiteSummary,
  type SiteTemplate,
  type SiteToken,
} from '../lib/api.ts';
import type { WindowClass } from '../lib/hooks.ts';

type Index = Awaited<ReturnType<typeof api.sites>>;

const SOURCE: Record<SiteSummary['source']['kind'], string> = {
  template: 'From a template',
  figma: 'From Figma',
  pen: 'From pen.dev',
  url: 'From a web page',
  files: 'From files',
  empty: 'Blank',
};
const ago = (iso: string) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
};

export function Sites({
  wc,
  go,
  siteParam,
}: {
  wc: WindowClass;
  go: (to: string) => void;
  siteParam: string | null;
}) {
  return siteParam ? (
    <SiteCanvas key={siteParam} id={siteParam} wc={wc} go={go} />
  ) : (
    <SiteList wc={wc} go={go} />
  );
}

/** A page shown small, as it really lays out at desktop width: the frame is drawn at 1440 and scaled down. */
function Thumb({ src, title }: { src: string; title: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.2);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setScale((e?.contentRect.width ?? 288) / 1440));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="sc-thumb" ref={box} aria-hidden="true">
      <iframe
        src={src}
        title={title}
        tabIndex={-1}
        loading="lazy"
        sandbox="allow-scripts"
        style={{ transform: `scale(${scale})` }}
      />
    </div>
  );
}

function SiteList({ wc, go }: { wc: WindowClass; go: (to: string) => void }) {
  const [data, setData] = useState<Index | null>(null);
  const [making, setMaking] = useState<{ template?: string } | null>(null);
  const refresh = useCallback(() => api.sites().then(setData).catch(toastError), []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const use = async (t: SiteTemplate) => {
    try {
      const s = await api.createSite({ from: 'template', template: t.id });
      go(`/sites/${s.id}`);
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <>
      <header className="hg-app__top">
        <div className="cs-crumb">
          <span className="t">Sites</span>
          <span className="s">
            {data ? `${data.sites.length || 'No'} ${data.sites.length === 1 ? 'site' : 'sites'}` : ''}
          </span>
        </div>
        <div className="hg-app__topactions">
          <Button kind="primary" icon="plus" onClick={() => setMaking({})}>
            {wc === 'compact' ? 'New' : 'New site'}
          </Button>
        </div>
      </header>
      <main className="cs-stage hg-scroll" id="main">
        <div className="st-page">
          <p className="body sec-text hg-measure">
            Websites you make here are plain HTML and CSS you own. Bring one in from Figma, pen.dev or a live
            page, or start from a template; then change it on the canvas, or ask a linked AI app to build it
            out.
          </p>

          {data?.sites.length ? (
            <section className="hg-section" aria-labelledby="sc-yours">
              <h2 id="sc-yours" className="st-h2">
                Your sites
              </h2>
              <ul className="sc-grid">
                {data.sites.map((s) => (
                  <li key={s.id}>
                    <a className="sc-card" href={`#/sites/${s.id}`}>
                      <Thumb
                        src={`${s.preview}${s.pages.includes('index.html') ? 'index.html' : (s.pages[0] ?? '')}`}
                        title={s.title}
                      />
                      <span className="sc-card__t">
                        <b>{s.title}</b>
                        <small className="body-sm muted">
                          {SOURCE[s.source.kind]} · {s.pages.length} {s.pages.length === 1 ? 'page' : 'pages'}{' '}
                          · {ago(s.updatedAt)}
                        </small>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="hg-section" aria-labelledby="sc-templates">
            <h2 id="sc-templates" className="st-h2">
              Start from a template
            </h2>
            <p className="body-sm muted hg-measure">
              Each is a finished site for a made-up business that passes every check Hildegard runs, in light
              and dark, at every width. Its pictures come with prompts, so your GPU can render real ones.
            </p>
            {!data ? (
              <div className="st-tile body-sm muted">Opening the templates…</div>
            ) : (
              <ul className="sc-grid">
                {data.templates.map((t) => (
                  <li key={t.id} className="sc-card sc-card--tpl">
                    <Thumb src={`/preview/template/${t.id}/index.html`} title={t.name} />
                    <span className="sc-card__t">
                      <b>{t.name}</b>
                      <small className="body-sm muted">For {t.for}.</small>
                    </span>
                    <p className="body-sm sec-text">{t.description}</p>
                    <span className="sc-card__acts">
                      <Button
                        kind="primary"
                        size="sm"
                        onClick={() => use(t)}
                        aria-label={`Use this template: ${t.name}`}
                      >
                        Use this
                      </Button>
                      <a
                        className="hg-btn hg-btn--ghost hg-btn--sm"
                        href={`/preview/template/${t.id}/index.html`}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Open ${t.name} in a new tab`}
                      >
                        Open
                      </a>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </main>
      {making && data ? (
        <NewSiteDialog
          index={data}
          onClose={() => setMaking(null)}
          onFigma={(linked) => setData((d) => (d ? { ...d, figma: { linked } } : d))}
          onMade={(s) => {
            setMaking(null);
            go(`/sites/${s.id}`);
          }}
        />
      ) : null}
    </>
  );
}

const base64 = (f: Blob) =>
  new Promise<string>((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => fail(new Error('Couldn’t read that file.'));
    r.readAsDataURL(f);
  });

type Way = 'figma' | 'url' | 'pen' | 'zip' | 'empty';

function NewSiteDialog({
  index,
  onClose,
  onMade,
  onFigma,
}: {
  index: Index;
  onClose: () => void;
  onMade: (s: SiteDetail) => void;
  onFigma: (linked: boolean) => void;
}) {
  const id = useId();
  const [way, setWay] = useState<Way>('figma');
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [token, setToken] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const linkFigma = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.figmaToken(token.trim());
      setToken('');
      onFigma(true);
      toast(r.as ? `Figma linked as ${r.as}.` : 'Figma linked.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      const t = title.trim() || undefined;
      let body: NewSite;
      if (way === 'figma') body = { from: 'figma', url: url.trim(), title: t };
      else if (way === 'url') body = { from: 'url', url: url.trim(), title: t };
      else if (way === 'pen') {
        if (!file) throw new Error('Choose a .pen file.');
        body = { from: 'pen', pen: await file.text(), title: t };
      } else if (way === 'zip') {
        if (!file) throw new Error('Choose a ZIP of the site.');
        body = { from: 'zip', data: await base64(file), title: t ?? file.name.replace(/\.zip$/i, '') };
      } else body = { from: 'empty', title: t ?? 'New site' };
      onMade(await api.createSite(body));
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const needsToken = way === 'figma' && !index.figma.linked;
  const ready =
    way === 'empty' ||
    ((way === 'figma' || way === 'url') && url.trim().length > 3) ||
    ((way === 'pen' || way === 'zip') && !!file);

  return (
    <Modal open onClose={onClose} labelledBy={id} variant="dialog" className="st-dialog sc-new">
      <div className="st-dialog__h">
        <div style={{ flex: 1 }}>
          <h2 id={id}>New site</h2>
          <p>Bring a design in, or start blank. Templates are on the Sites page.</p>
        </div>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (needsToken) void linkFigma();
          else if (ready) void make();
        }}
      >
        <div className="st-dialog__b">
          <Segmented<Way>
            label="Where it comes from"
            value={way}
            onChange={(v) => {
              setWay(v);
              setFile(null);
              setError(null);
            }}
            options={[
              { value: 'figma', label: 'Figma' },
              { value: 'url', label: 'Web page', disabled: !index.urlImport },
              { value: 'pen', label: 'pen.dev' },
              { value: 'zip', label: 'ZIP' },
              { value: 'empty', label: 'Blank' },
            ]}
          />
          {needsToken ? (
            <>
              <p className="body-sm sec-text">
                Link Figma once. In Figma, open Settings → Security → Personal access tokens, make one with{' '}
                <b>File content: read</b>, and paste it here. It stays in this computer’s keychain.
              </p>
              <label className="hg-field hg-field--block">
                Figma token
                <input
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  data-autofocus=""
                />
              </label>
            </>
          ) : way === 'figma' || way === 'url' ? (
            <label className="hg-field hg-field--block">
              {way === 'figma' ? 'Link to the Figma file or frame' : 'Address of the page'}
              <input
                type="url"
                inputMode="url"
                placeholder={way === 'figma' ? 'https://www.figma.com/design/…' : 'https://example.com'}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                data-autofocus=""
              />
            </label>
          ) : way === 'pen' || way === 'zip' ? (
            <label className="hg-field hg-field--block">
              {way === 'pen' ? 'The .pen file' : 'A ZIP of the site'}
              <input
                type="file"
                accept={way === 'pen' ? '.pen,application/json' : '.zip,application/zip'}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
          ) : null}
          {!needsToken ? (
            <label className="hg-field hg-field--block">
              Name {way === 'empty' ? '' : '(optional)'}
              <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
            </label>
          ) : null}
          {way === 'url' ? (
            <p className="body-sm muted">
              Hildegard opens the page in its own browser, keeps its words, styles and pictures, drops its
              scripts, and keeps a screenshot to hold the rebuild to. Only public addresses.
            </p>
          ) : way === 'figma' && !needsToken ? (
            <p className="body-sm muted">
              Frames become pages; auto layout becomes flex, styles become tokens, and a render of each frame
              is kept to compare against.{' '}
              <button
                type="button"
                className="hg-linkbtn"
                onClick={() => api.figmaUnlink().then(() => onFigma(false), toastError)}
              >
                Unlink Figma
              </button>
            </p>
          ) : null}
          {error ? (
            <p className="body-sm hg-err" role="alert">
              <Icon name="alert" size={16} /> {error}
            </p>
          ) : null}
          <button type="submit" hidden />
        </div>
      </form>
      <div className="st-dialog__f">
        <Button kind="ghost" onClick={onClose}>
          Cancel
        </Button>
        {needsToken ? (
          <Button
            kind="primary"
            icon="link"
            busy={busy}
            disabled={token.trim().length < 20}
            onClick={linkFigma}
          >
            Link Figma
          </Button>
        ) : (
          <Button kind="primary" busy={busy} disabled={!ready} onClick={make}>
            {way === 'empty' ? 'Make it' : 'Bring it in'}
          </Button>
        )}
      </div>
    </Modal>
  );
}

const FRAMES = [
  { key: 'phone', label: 'Phone', icon: 'phone', w: 390, h: 844 },
  { key: 'tablet', label: 'Tablet', icon: 'tablet', w: 820, h: 1180 },
  { key: 'desktop', label: 'Desktop', icon: 'desktop', w: 1440, h: 900 },
] as const;
type FrameKey = (typeof FRAMES)[number]['key'];

interface Picked {
  frame: FrameKey;
  page: string;
  tag: string;
  id: string | null;
  classes: string[];
  path: string;
  text: string | null;
  alt: string | null;
  src: string | null;
  size: [number, number];
  styles: Record<string, string>;
}

type Panel = 'element' | 'tokens' | 'about';

function SiteCanvas({ id, wc, go }: { id: string; wc: WindowClass; go: (to: string) => void }) {
  const [site, setSite] = useState<SiteDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [page, setPage] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [zoom, setZoom] = useState<'fit' | '50' | '100'>('fit');
  const [only, setOnly] = useState<FrameKey>('phone');
  const [picked, setPicked] = useState<Picked | null>(null);
  const [panel, setPanel] = useState<Panel>('element');
  const [sheet, setSheet] = useState(false);
  const [stageH, setStageH] = useState(800);
  const frames = useRef(new Map<FrameKey, HTMLIFrameElement>());
  const stage = useRef<HTMLDivElement>(null);
  const seen = useRef<string | null>(null);
  const quietUntil = useRef(0);
  const compact = wc === 'compact' || wc === 'medium';
  const docked = !compact;

  // Watch for changes, from here or from an AI app writing files, and reload the frames when they come.
  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .site(id)
        .then((s) => {
          if (!live) return;
          setSite(s);
          if (seen.current && seen.current !== s.updatedAt && Date.now() > quietUntil.current)
            setVersion((v) => v + 1);
          seen.current = s.updatedAt;
        })
        .catch((e) => {
          if (e instanceof ApiError && e.status === 404) setMissing(true);
          else if (live && !seen.current) toastError(e);
        });
    void load();
    const t = setInterval(load, 2500);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [id]);

  const pages = site?.pages ?? [];
  const current =
    page && pages.includes(page) ? page : pages.includes('index.html') ? 'index.html' : (pages[0] ?? null);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setStageH(e?.contentRect.height ?? 800));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // What a frame says: only from our own frames, only in the canvas's own words.
  useEffect(() => {
    const on = (e: MessageEvent) => {
      const d = e.data as {
        hildegard?: string;
        type?: string;
        page?: string;
        element?: Omit<Picked, 'frame' | 'page'>;
      };
      if (d?.hildegard !== 'canvas' || d.type !== 'select' || !d.element) return;
      const from = [...frames.current].find(([, f]) => f.contentWindow === e.source)?.[0];
      if (!from) return;
      for (const [k, f] of frames.current)
        if (k !== from) f.contentWindow?.postMessage({ hildegard: 'studio', type: 'clear' }, '*');
      setPicked({ ...d.element, frame: from, page: String(d.page ?? current ?? '') });
      setPanel('element');
      if (!docked) setSheet(true);
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, [current, docked]);

  const tell = useCallback((m: Record<string, unknown>) => {
    for (const f of frames.current.values()) f.contentWindow?.postMessage({ hildegard: 'studio', ...m }, '*');
  }, []);

  if (missing)
    return (
      <>
        <header className="hg-app__top">
          <div className="cs-crumb">
            <span className="t">Sites</span>
          </div>
        </header>
        <main className="cs-stage" id="main">
          <div className="hg-empty">
            <Icon name="desktop" size={24} />
            <b>That site isn’t here any more</b>
            <Button onClick={() => go('/sites')}>All sites</Button>
          </div>
        </main>
      </>
    );

  const shown: ReadonlyArray<(typeof FRAMES)[number]> = compact
    ? FRAMES.filter((f) => f.key === only)
    : FRAMES;
  const tallest = Math.max(...shown.map((f) => f.h));
  // Fit: as large as the window's height allows, but small enough that every frame shows side by side.
  const across =
    ((stage.current?.clientWidth ?? 1200) - 56 - 28 * (shown.length - 1)) /
    shown.reduce((n, f) => n + f.w, 0);
  const fit = Math.min(1, (stageH - 72) / tallest, Math.max(0.3, across));
  const scale =
    zoom === 'fit'
      ? compact
        ? Math.min(1, (stage.current?.clientWidth ?? 390) / 420)
        : fit
      : zoom === '50'
        ? 0.5
        : 1;
  const src = site && current ? `${site.preview}${current}?canvas=1&v=${version}` : null;

  const body = site ? (
    <SitePanel
      site={site}
      page={current}
      picked={picked}
      panel={panel}
      setPanel={setPanel}
      tell={tell}
      quiet={() => {
        quietUntil.current = Date.now() + 4000;
      }}
      reload={() => setVersion((v) => v + 1)}
      onClose={docked ? undefined : () => setSheet(false)}
    />
  ) : null;

  return (
    <>
      <header className="hg-app__top">
        <a className="hg-btn hg-btn--icon hg-btn--ghost" href="#/sites" aria-label="All sites">
          <Icon name="chevronl" />
        </a>
        <div className="cs-crumb">
          <span className="t">{site?.title ?? 'Site'}</span>
          <span className="s">
            {site ? `${SOURCE[site.source.kind]} · saved ${ago(site.updatedAt)}` : ''}
          </span>
        </div>
        <div className="hg-app__topactions">
          {pages.length > 1 ? (
            <label className="sc-pagepick">
              <span className="sr">Page</span>
              <select value={current ?? ''} onChange={(e) => setPage(e.target.value)}>
                {pages.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {compact ? (
            <Segmented<FrameKey>
              label="Width"
              value={only}
              onChange={setOnly}
              options={FRAMES.map((f) => ({ value: f.key, label: <Icon name={f.icon} size={18} /> }))}
            />
          ) : (
            <Segmented<'fit' | '50' | '100'>
              label="Zoom"
              value={zoom}
              onChange={setZoom}
              options={[
                { value: 'fit', label: 'Fit' },
                { value: '50', label: '50%' },
                { value: '100', label: '100%' },
              ]}
            />
          )}
          {!docked ? (
            <Button icon="pen" onClick={() => setSheet(true)} aria-label="Inspect and edit" />
          ) : null}
          <Menu
            label="More"
            items={[
              site && current
                ? {
                    label: 'Open the page in a tab',
                    icon: 'link',
                    onSelect: () => window.open(`${site.preview}${current}`, '_blank', 'noopener'),
                  }
                : null,
              {
                label: 'Download as ZIP',
                icon: 'download',
                onSelect: () => window.location.assign(`/api/sites/${id}/zip`),
              },
              {
                label: 'Rename',
                icon: 'text',
                onSelect: () => {
                  const t = window.prompt('Name this site', site?.title ?? '')?.trim();
                  if (t) api.renameSite(id, t).then(setSite, toastError);
                },
              },
              {
                label: 'Delete this site',
                icon: 'trash',
                danger: true,
                onSelect: () => {
                  if (
                    window.confirm(
                      `Delete ${site?.title ?? 'this site'} and all its files? This can’t be undone.`,
                    )
                  )
                    api.deleteSite(id).then(() => go('/sites'), toastError);
                },
              },
            ]}
          />
        </div>
      </header>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the canvas scrolls both ways, so keyboards must be able to reach it. */}
      <main className="cs-stage sc-stage" id="main" ref={stage} tabIndex={0} aria-label="Canvas">
        <div className="sc-frames">
          {src ? (
            shown.map((f) => (
              <figure key={f.key} className="sc-frame" data-picked={picked?.frame === f.key ? '' : undefined}>
                <figcaption>
                  <Icon name={f.icon} size={14} /> {f.label} <span className="num muted">{f.w}</span>
                </figcaption>
                <div className="sc-frame__box" style={{ width: f.w * scale, height: f.h * scale }}>
                  <iframe
                    ref={(el) => {
                      if (el) frames.current.set(f.key, el);
                      else frames.current.delete(f.key);
                    }}
                    src={src}
                    title={`${current} at ${f.label.toLowerCase()} width`}
                    sandbox="allow-scripts allow-forms"
                    style={{ width: f.w, height: f.h, transform: `scale(${scale})` }}
                  />
                </div>
              </figure>
            ))
          ) : (
            <div className="hg-empty">
              <Icon name="desktop" size={24} />
              <b>{site ? 'This site has no pages yet' : 'Opening the site…'}</b>
              {site ? (
                <span className="body-sm muted">
                  Ask a linked AI app to write index.html, and it appears here.
                </span>
              ) : null}
            </div>
          )}
        </div>
      </main>
      {docked && body ? <aside className="hg-insp-dock">{body}</aside> : null}
      {!docked && sheet && body ? (
        <Modal open onClose={() => setSheet(false)} labelledBy="sc-panel-title" variant="bottom">
          {body}
        </Modal>
      ) : null}
    </>
  );
}

const COLOR = /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\(|oklab\(|color-mix\()/i;
const hex6 = (v: string) => {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return null;
  const h = m[1]!;
  return h.length === 3 ? `#${[...h].map((c) => c + c).join('')}` : `#${h}`;
};

function SitePanel({
  site,
  page,
  picked,
  panel,
  setPanel,
  tell,
  quiet,
  reload,
  onClose,
}: {
  site: SiteDetail;
  page: string | null;
  picked: Picked | null;
  panel: Panel;
  setPanel: (p: Panel) => void;
  tell: (m: Record<string, unknown>) => void;
  quiet: () => void;
  reload: () => void;
  onClose?: () => void;
}) {
  return (
    <div className="cs-insp v2 sc-panel" role="region" aria-labelledby="sc-panel-title">
      <div className="cs-insp__body hg-scroll">
        <div className="sc-panel__h">
          <h2 id="sc-panel-title" className="sr">
            Inspect and edit
          </h2>
          <Segmented<Panel>
            label="Panel"
            value={panel}
            onChange={setPanel}
            options={[
              { value: 'element', label: 'Element' },
              { value: 'tokens', label: 'Tokens' },
              { value: 'about', label: 'Site' },
            ]}
          />
          {onClose ? (
            <button
              type="button"
              className="hg-btn hg-btn--icon hg-btn--ghost"
              aria-label="Close"
              onClick={onClose}
            >
              <Icon name="close" />
            </button>
          ) : null}
        </div>
        {panel === 'element' ? (
          <ElementPanel site={site} picked={picked} reload={reload} />
        ) : panel === 'tokens' ? (
          <TokensPanel site={site} tell={tell} quiet={quiet} />
        ) : (
          <AboutPanel site={site} page={page} />
        )}
      </div>
    </div>
  );
}

function ElementPanel({
  site,
  picked,
  reload,
}: {
  site: SiteDetail;
  picked: Picked | null;
  reload: () => void;
}) {
  const [words, setWords] = useState(picked?.text ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => setWords(picked?.text ?? ''), [picked]);
  if (!picked)
    return (
      <p className="body-sm muted sc-hint">
        Click anything in a frame to see what it is and how it’s styled. Words can be changed right here; for
        the rest, ask a linked AI app, and the frames update as it writes.
      </p>
    );
  const save = async () => {
    if (!picked.text || words === picked.text) return;
    setBusy(true);
    try {
      await api.siteText(site.id, picked.page, picked.text, words);
      toast('Saved.');
      reload();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const rows = Object.entries(picked.styles)
    .filter(([k]) => k !== 'width' && k !== 'height')
    .filter(([, v]) => v && !['normal', 'none', '0px', 'auto', 'rgba(0, 0, 0, 0)'].includes(v));
  return (
    <div className="sc-el">
      <p className="sc-el__tag">
        <code>
          {picked.tag}
          {picked.id ? `#${picked.id}` : ''}
          {picked.classes.length ? `.${picked.classes.join('.')}` : ''}
        </code>
        <span className="num muted body-sm">
          {picked.size[0]} × {picked.size[1]} at {picked.frame}
        </span>
      </p>
      <p className="body-sm muted sc-el__path">{picked.path}</p>
      {picked.text !== null ? (
        <label className="hg-field hg-field--block">
          Words
          <textarea
            rows={Math.min(8, Math.max(2, Math.ceil(words.length / 40)))}
            value={words}
            onChange={(e) => setWords(e.target.value)}
          />
          <span className="sc-el__acts">
            <Button
              kind="primary"
              size="sm"
              busy={busy}
              disabled={words === picked.text || !words.trim()}
              onClick={save}
            >
              Save words
            </Button>
          </span>
        </label>
      ) : null}
      {picked.alt !== null ? (
        <p className="body-sm">
          <b>Alt text:</b> {picked.alt || <span className="hg-err">none, so a screen reader skips it</span>}
        </p>
      ) : null}
      <dl className="sc-styles">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>
              {COLOR.test(v) ? (
                <span className="sc-swatch" style={{ background: v }} aria-hidden="true" />
              ) : null}
              <code>{v}</code>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function TokenRow({ t, onSet }: { t: SiteToken; onSet: (v: string) => Promise<void> }) {
  const [v, setV] = useState(t.value);
  useEffect(() => setV(t.value), [t.value]);
  const hex = hex6(v);
  const commit = (next: string) => {
    if (next.trim() && next.trim() !== t.value) void onSet(next.trim());
  };
  return (
    <li className="sc-token">
      {hex ? (
        <input
          type="color"
          value={hex}
          aria-label={`${t.name}${t.dark ? ' in dark mode' : ''}, colour`}
          onChange={(e) => setV(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
        />
      ) : COLOR.test(v) ? (
        <span className="sc-swatch" style={{ background: v }} aria-hidden="true" />
      ) : (
        <span className="sc-swatch sc-swatch--none" aria-hidden="true" />
      )}
      <label>
        <span className="sc-token__n">{t.name}</span>
        <input
          value={v}
          spellCheck={false}
          onChange={(e) => setV(e.target.value)}
          onBlur={() => commit(v)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(v);
            if (e.key === 'Escape') setV(t.value);
          }}
        />
      </label>
    </li>
  );
}

function TokensPanel({
  site,
  tell,
  quiet,
}: {
  site: SiteDetail;
  tell: (m: Record<string, unknown>) => void;
  quiet: () => void;
}) {
  const [tokens, setTokens] = useState<SiteToken[] | null>(null);
  const [dark, setDark] = useState(false);
  useEffect(() => {
    api
      .siteTokens(site.id)
      .then((r) => setTokens(r.tokens))
      .catch(toastError);
  }, [site.id]);
  const list = useMemo(() => (tokens ?? []).filter((t) => t.dark === dark), [tokens, dark]);
  const hasDark = (tokens ?? []).some((t) => t.dark);
  const groups = useMemo(() => {
    const colours = list.filter((t) => COLOR.test(t.value));
    const rest = list.filter((t) => !COLOR.test(t.value));
    return [
      ['Colours', colours],
      ['Type, space and the rest', rest],
    ] as const;
  }, [list]);

  const set = async (t: SiteToken, value: string) => {
    // Light values show at once in every frame; the stylesheet is saved behind them.
    if (!t.dark) tell({ type: 'token', name: t.name, value });
    quiet();
    try {
      const r = await api.setSiteToken(site.id, { name: t.name, value, dark: t.dark, file: t.file });
      setTokens(r.tokens);
    } catch (e) {
      toastError(e);
    }
  };

  if (!tokens) return <p className="body-sm muted sc-hint">Reading the stylesheets…</p>;
  if (!tokens.length)
    return (
      <p className="body-sm muted sc-hint">
        This site sets no CSS variables on <code>:root</code>, so there’s no system to change here yet. Ask a
        linked AI app to pull its colours and sizes out into tokens.
      </p>
    );
  return (
    <div className="sc-tokens">
      {hasDark ? (
        <Segmented<'light' | 'dark'>
          label="Theme"
          value={dark ? 'dark' : 'light'}
          onChange={(v) => setDark(v === 'dark')}
          options={[
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
        />
      ) : null}
      {groups.map(([name, ts]) =>
        ts.length ? (
          <section key={name} aria-label={name}>
            <h3 className="st-lbl">{name}</h3>
            <ul>
              {ts.map((t) => (
                <TokenRow key={`${t.file}|${t.name}`} t={t} onSet={(v) => set(t, v)} />
              ))}
            </ul>
          </section>
        ) : null,
      )}
    </div>
  );
}

function AboutPanel({ site, page }: { site: SiteDetail; page: string | null }) {
  const [copied, setCopied] = useState(false);
  const ask = `Work on my Hildegard site “${site.title}” (site_id ${site.id})${page ? `, starting with ${page}` : ''}. Read it with site_files and site_read, then make it excellent and hold it to the web checks with a web loop.`;
  const row = (k: string, v: ReactNode) => (
    <div>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  );
  return (
    <div className="sc-about">
      <dl className="sc-styles">
        {row(
          'Started',
          SOURCE[site.source.kind] + (site.source.from ? ` (${site.source.from.slice(0, 80)})` : ''),
        )}
        {row('Pages', site.pages.join(', ') || 'none yet')}
        {row('Files', `${site.files}, ${(site.bytes / 1024 / 1024).toFixed(1)} MB`)}
      </dl>
      {site.reference ? (
        <figure className="sc-ref">
          <img
            src={`/api/sites/${site.id}/reference`}
            alt={`The design this site is held to, drawn at ${site.reference.width} px`}
          />
          <figcaption className="body-sm muted">
            The design to hold it to, at {site.reference.width} px.
          </figcaption>
        </figure>
      ) : null}
      {site.notes.length ? (
        <section aria-labelledby="sc-notes">
          <h3 id="sc-notes" className="st-lbl">
            What’s left to do
          </h3>
          <ul className="sc-notes body-sm">
            {site.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </section>
      ) : null}
      <section aria-labelledby="sc-ask">
        <h3 id="sc-ask" className="st-lbl">
          Hand it to an AI app
        </h3>
        <p className="body-sm sc-ask">{ask}</p>
        <Button
          size="sm"
          icon={copied ? 'check' : 'copy'}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(ask);
              setCopied(true);
            } catch {
              toast('Couldn’t copy. Select the text and copy it yourself.', { tone: 'error' });
            }
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </section>
    </div>
  );
}
