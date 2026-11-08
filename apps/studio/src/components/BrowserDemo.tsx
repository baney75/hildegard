// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A browser demo from the Studio: a site or an unpacked extension, in Playwright's Chromium with a throwaway profile,
 * driven by steps (nobody clicking) or by you in its window, recorded onto a clean backdrop with a cursor and click
 * ripples. It lands with your recordings. Folders and a window you drive are this computer's, so they show only here.
 */
import { useEffect, useId, useState } from 'react';
import { api, type DemoInfo } from '../lib/api.ts';
import { DEMO_BACKDROPS, remember, remembered } from '../lib/capture.ts';
import { Backdrops, RecordingPlayer } from './Recorder.tsx';
import { Button, Icon, Segmented, Switch, WithCode } from './ui.tsx';

const EXAMPLE = `[
  { "do": "caption", "text": "Sign up in ten seconds" },
  { "do": "click", "text": "Sign up" },
  { "do": "type", "selector": "#email", "text": "ada@example.com" },
  { "do": "click", "text": "Continue" },
  { "do": "wait", "text": "Welcome" }
]`;
const KEY = 'hildegard.demo';
type Saved = {
  url: string;
  extension: string;
  steps: string;
  size: string;
  backdrop: string;
  aspect: '16:9' | '1:1' | '9:16';
  zoom: boolean;
  driven: 'steps' | 'me';
};

export function BrowserDemo({ here, onKept }: { here: boolean; onKept: () => void }) {
  const id = useId();
  const [f, setF] = useState<Saved>(() => {
    try {
      const j = JSON.parse(remembered(KEY) || 'null') as Saved | null;
      if (j && typeof j.url === 'string') return j;
    } catch {}
    return {
      url: 'https://',
      extension: '',
      steps: EXAMPLE,
      size: '1280x800',
      backdrop: 'viridian',
      aspect: '16:9',
      zoom: true,
      driven: 'steps',
    };
  });
  const set = (p: Partial<Saved>) =>
    setF((o) => {
      const n = { ...o, ...p };
      remember(KEY, JSON.stringify(n));
      return n;
    });
  const [job, setJob] = useState<DemoInfo | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const running = !!job && !['done', 'failed', 'stopped'].includes(job.status);
  const driven = here ? f.driven : 'steps';

  useEffect(() => {
    if (!job || !running) return;
    const t = setInterval(() => {
      api
        .demo(job.id)
        .then((j) => {
          setJob(j);
          if (j.status === 'done' || j.status === 'stopped') onKept();
        })
        .catch(() => {});
    }, 800);
    return () => clearInterval(t);
  }, [job, running, onKept]);

  const start = async () => {
    setError(null);
    let steps: unknown;
    if (driven === 'steps') {
      try {
        steps = JSON.parse(f.steps);
      } catch (e) {
        setError({ message: `The steps aren’t JSON: ${(e as Error).message}` });
        return;
      }
    }
    const [w, h] = f.size.split('x').map(Number);
    setBusy(true);
    try {
      setJob(
        await api.startDemo({
          url: f.url,
          extension: here && f.extension.trim() ? f.extension.trim() : undefined,
          steps,
          width: w,
          height: h,
          backdrop: f.backdrop,
          aspect: f.aspect,
          zoom: f.zoom,
        }),
      );
    } catch (e) {
      setError({ message: (e as Error).message, code: (e as { code?: string }).code });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="hg-rec">
      <div className="hg-rec__stage hg-demo__stage">
        {job?.recording?.url && !running ? (
          <RecordingPlayer url={job.recording.url} kind="video" label="Your demo" chapters={[]} />
        ) : (
          <div
            className="hg-demo__preview"
            style={{ background: DEMO_BACKDROPS.find((b) => b.id === f.backdrop)?.css ?? 'var(--panel)' }}
            data-aspect={f.aspect}
          >
            <div className="hg-demo__window">
              <span className="hg-demo__bar" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span className="body-sm hg-demo__url">{f.url}</span>
              {running ? (
                <p className="body-sm" role="status">
                  <span className="hg-spin" /> {job?.stage ?? 'Working…'}
                </p>
              ) : null}
            </div>
          </div>
        )}
        <div className="hg-rec__transport">
          {running ? (
            <Button icon="stop" onClick={() => job && void api.stopDemo(job.id).then(setJob)}>
              {driven === 'me' ? 'Stop and keep' : 'Stop'}
            </Button>
          ) : (
            <Button kind="primary" size="lg" icon="play" onClick={() => void start()} busy={busy}>
              {driven === 'me' ? 'Open and record' : 'Record the demo'}
            </Button>
          )}
        </div>
        {job?.log.length ? (
          <ol className="hg-chapters hg-demo__log" aria-label="Steps done">
            {job.log.map((l, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the log only grows
              <li key={i}>
                <span className="num muted">{i + 1}</span>
                <span>{l}</span>
              </li>
            ))}
          </ol>
        ) : null}
        {job?.status === 'failed' ? (
          <p className="body-sm hg-err" role="alert">
            {job.error}
          </p>
        ) : null}
        {error ? (
          <p className="body-sm hg-err" role="alert">
            {error.code === 'browser' ? (
              <WithCode text={error.message.replace(/: (npx .*)$/, ': `$1`')} />
            ) : (
              error.message
            )}
          </p>
        ) : null}
      </div>
      <div className="hg-rec__side">
        <p className="body-sm sec-text">
          A browser of its own, with a fresh profile that is deleted after: none of your cookies or sign-ins.
        </p>
        <section className="hg-rec__group" aria-labelledby={`${id}-what`}>
          <h3 id={`${id}-what`} className="hg-rec__label">
            What to show
          </h3>
          <label className="hg-field--block">
            Address
            <input
              className="hg-select"
              type="url"
              value={f.url}
              onChange={(e) => set({ url: e.target.value })}
              disabled={running}
              inputMode="url"
              autoComplete="off"
            />
          </label>
          {here ? (
            <label className="hg-field--block">
              Unpacked extension folder (optional)
              <input
                className="hg-select"
                value={f.extension}
                onChange={(e) => set({ extension: e.target.value })}
                disabled={running}
                placeholder="/path/to/extension"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          ) : null}
        </section>
        <section className="hg-rec__group" aria-labelledby={`${id}-how`}>
          <h3 id={`${id}-how`} className="hg-rec__label">
            Who drives
          </h3>
          {here ? (
            <Segmented
              className="hg-seg hg-seg--fill"
              label="Who drives"
              value={f.driven}
              onChange={(v: 'steps' | 'me') => set({ driven: v })}
              options={[
                { value: 'steps', label: 'Steps', disabled: running },
                { value: 'me', label: 'Me, in the window', disabled: running },
              ]}
            />
          ) : null}
          {driven === 'steps' ? (
            <label className="hg-field--block">
              Steps (JSON): goto, click, type, key, wait, scroll, pause, caption
              <textarea
                className="cs-area hg-demo__steps"
                rows={9}
                value={f.steps}
                onChange={(e) => set({ steps: e.target.value })}
                disabled={running}
                spellCheck={false}
              />
            </label>
          ) : (
            <p className="body-sm muted">A window opens. Show what you like, then press Stop and keep.</p>
          )}
        </section>
        <section className="hg-rec__group" aria-labelledby={`${id}-look`}>
          <h3 id={`${id}-look`} className="hg-rec__label">
            Look
          </h3>
          <Backdrops value={f.backdrop} onChange={(b) => set({ backdrop: b })} disabled={running} />
          <div className="hg-rec__pair">
            <label className="hg-field--block">
              Browser size
              <select
                className="hg-select"
                value={f.size}
                onChange={(e) => set({ size: e.target.value })}
                disabled={running}
              >
                {['1280x800', '1440x900', '1024x768', '390x844'].map((s) => (
                  <option key={s} value={s}>
                    {s.replace('x', ' × ')}
                  </option>
                ))}
              </select>
            </label>
            <label className="hg-field--block">
              Video shape
              <select
                className="hg-select"
                value={f.aspect}
                onChange={(e) => set({ aspect: e.target.value as Saved['aspect'] })}
                disabled={running}
              >
                <option value="16:9">Wide, 16:9</option>
                <option value="1:1">Square, 1:1</option>
                <option value="9:16">Tall, 9:16</option>
              </select>
            </label>
          </div>
          <div className="hg-between">
            <span className="body-sm sec-text">Zoom toward each click</span>
            <Switch checked={f.zoom} onChange={(v) => set({ zoom: v })} label="Zoom toward each click" />
          </div>
        </section>
        {!here ? (
          <p className="body-sm muted">
            <Icon name="lock" size={14} /> Extensions and driving the window yourself work on the computer
            Hildegard runs on.
          </p>
        ) : null}
      </div>
    </div>
  );
}
