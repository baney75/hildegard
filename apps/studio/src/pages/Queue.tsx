// SPDX-License-Identifier: AGPL-3.0-only
import type { Catalog, Take } from '@hildegard/presets';
import { useMemo, useState } from 'react';
import { ForceDialog } from '../components/ForceDialog.tsx';
import { previewUrl, takeLabel, waitingFor } from '../components/TakeCard.tsx';
import { Button, Icon, Segmented, Status, toastError } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { about, duration, estimateMs, leftMs, modelName, ordinal, resolution } from '../lib/format.ts';
import { useNow, type WindowClass } from '../lib/hooks.ts';
import { upsert, useStore } from '../lib/store.ts';

type Filter = 'all' | 'running' | 'waiting' | 'done';

export function Queue({ catalog, wc, go }: { catalog: Catalog; wc: WindowClass; go: (to: string) => void }) {
  const takes = useStore((s) => s.takes);
  const shots = useStore((s) => s.shots);
  const engine = useStore((s) => s.engine);
  const [filter, setFilter] = useState<Filter>('all');
  const [forcing, setForcing] = useState<string | null>(null);
  const all = [...takes.values()];
  const running = all.filter((t) => t.status === 'running');
  const now = useNow(running.length > 0);
  const waiting = all
    .filter((t) => t.status === 'queued')
    .sort(
      (a, b) => (a.queuePosition ?? 99) - (b.queuePosition ?? 99) || a.createdAt.localeCompare(b.createdAt),
    );
  const dayStart = useMemo(() => new Date(new Date().setHours(0, 0, 0, 0)).toISOString(), []);
  const done = all
    .filter((t) => t.status === 'done' && (t.finishedAt ?? '') >= dayStart)
    .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''));
  const stopped = all.filter(
    (t) => (t.status === 'failed' || t.status === 'canceled') && (t.finishedAt ?? '') >= dayStart,
  );
  const where = engine?.fake ? 'Stand-in GPU' : (engine?.device ?? 'This computer');

  // Time until each waiting take starts: what is left of the current render plus everything ahead of it.
  const startsIn = (() => {
    const m = new Map<string, number | null>();
    let acc: number | null = running[0] ? leftMs(running[0], estimateMs(all, running[0]), now) : 0;
    for (const t of waiting) {
      m.set(t.id, acc);
      const own = estimateMs(all, t);
      acc = acc === null || own === null ? null : acc + own;
    }
    return m;
  })();

  const pauseAll = () => (engine?.paused ? api.resume() : api.pause()).catch(toastError);
  const row = (t: Take) => {
    const shot = shots.get(t.shotId);
    const thumb = t.status === 'running' ? previewUrl(t) : t.poster;
    const pct = Math.round((t.progress?.value ?? (t.status === 'done' ? 1 : 0)) * 100);
    const left = t.status === 'running' ? leftMs(t, estimateMs(all, t), now) : null;
    const starts = startsIn.get(t.id);
    const open = () => go(`/film/${t.projectId}/take/${t.id}`);
    return (
      <div key={t.id} className={`st-job${t.status === 'running' ? ' live' : ''}`}>
        {thumb ? (
          <img src={thumb} alt="" />
        ) : (
          <span className="thph" aria-hidden="true">
            <Icon name="video" size={18} />
          </span>
        )}
        <span style={{ minWidth: 0 }}>
          <b>
            <button type="button" className="hg-linkbtn" onClick={open}>
              {shot?.title ?? 'Shot'} · {takeLabel(t)}
            </button>
          </b>
          <small>
            {modelName(catalog, t.model)} · {resolution(t)} · {t.seconds}s
            {t.source.kind === 'agent' ? ` · asked by ${t.source.name}` : ''}
          </small>
        </span>
        <span style={{ display: 'grid', gap: 6 }}>
          {t.status === 'running' ? <Status kind="running">Rendering</Status> : null}
          {t.status === 'queued' ? (
            <Status kind="queued">{t.priority === 'forced' ? 'Forced' : 'Waiting'}</Status>
          ) : null}
          {t.status === 'done' ? <Status kind="done">Done</Status> : null}
          {t.status === 'failed' ? <Status kind="error">{t.error?.message ?? 'Stopped'}</Status> : null}
          {t.status === 'canceled' ? <Status kind="idle">Canceled</Status> : null}
          <span
            className={`st-bar${t.status === 'queued' ? ' q' : t.status === 'done' ? ' ok' : ''}`}
            role="progressbar"
            aria-label="Progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
          >
            <i style={{ width: `${pct}%` }} />
          </span>
        </span>
        <span style={{ minWidth: 0 }}>
          <b style={{ fontWeight: 500 }}>{where}</b>
          <small>
            {t.status === 'running'
              ? left !== null
                ? `${about(left).replace('~', '')} left`
                : `${pct}%`
              : null}
            {t.status === 'queued'
              ? `${t.queuePosition ? ordinal(t.queuePosition) : 'Next'}${starts ? ` · starts in ${about(starts)}` : ''}${!engine?.online || engine.paused ? ` · ${waitingFor(t, { online: !!engine?.online, paused: !!engine?.paused })}` : ''}`
              : null}
            {t.status === 'done' ? `${t.renderMs ? duration(t.renderMs) : ''} · $0.00` : null}
            {t.status === 'failed' ? t.error?.hint : null}
          </small>
        </span>
        <span className="acts">
          {t.status === 'queued' ? (
            <>
              <Button size="sm" kind="force" icon="force" onClick={() => setForcing(t.id)}>
                Force now
              </Button>
              <Button
                size="sm"
                kind="ghost"
                icon="close"
                aria-label="Cancel"
                onClick={() =>
                  api
                    .cancel(t.id)
                    .then((x) => upsert({ type: 'take', take: x }))
                    .catch(toastError)
                }
              />
            </>
          ) : null}
          {t.status === 'running' ? (
            <Button size="sm" kind="ghost" icon="close" onClick={() => api.cancel(t.id).catch(toastError)}>
              Cancel
            </Button>
          ) : null}
          {t.status === 'failed' || t.status === 'canceled' ? (
            <Button
              size="sm"
              icon="reuse"
              onClick={() =>
                api
                  .retry(t.id)
                  .then((x) => upsert({ type: 'take', take: x }))
                  .catch(toastError)
              }
            >
              Retry
            </Button>
          ) : null}
          {t.status === 'done' ? (
            <Button size="sm" kind="ghost" onClick={open}>
              Open
            </Button>
          ) : null}
        </span>
      </div>
    );
  };

  const groups: Array<{ key: Filter; title: string; list: Take[]; sub: string; extra?: React.ReactNode }> = [
    {
      key: 'running',
      title: 'Rendering',
      list: running,
      sub: running.length === 1 ? '1 take' : `${running.length} takes`,
    },
    {
      key: 'waiting',
      title: 'Waiting',
      list: waiting,
      sub: waiting.length === 1 ? '1 take' : `${waiting.length} takes`,
      extra:
        waiting.length > 1 ? (
          <Button
            size="sm"
            kind="ghost"
            icon="close"
            style={{ marginLeft: 'auto' }}
            onClick={() => Promise.all(waiting.map((t) => api.cancel(t.id))).catch(toastError)}
          >
            Cancel all waiting
          </Button>
        ) : null,
    },
    {
      key: 'done',
      title: 'Done today',
      list: [...done, ...stopped],
      sub: `${done.length} made · $0.00 spent`,
    },
  ];
  const shown = groups.filter((g) => filter === 'all' || g.key === filter);
  const empty = !running.length && !waiting.length && !done.length && !stopped.length;

  return (
    <>
      <header className="hg-app__top">
        <div className="cs-crumb">
          <span className="t">Queue</span>
          <span className="s">
            {engine?.online
              ? `${where}${engine.paused ? ' · paused' : running.length ? ' · busy' : ' · ready'}`
              : 'ComfyUI is not running'}
          </span>
        </div>
        <div className="hg-app__topactions">
          <Button icon={engine?.paused ? 'play' : 'pause'} onClick={pauseAll}>
            {engine?.paused ? 'Resume' : 'Pause all'}
          </Button>
        </div>
      </header>
      <main className="cs-stage hg-scroll" id="main">
        <div className="st-page">
          {!engine?.online ? (
            <div className="st-tile hg-banner" role="status">
              <Icon name="alert" size={18} />
              <span>
                <b>ComfyUI is not running.</b> Takes wait here and start on their own once it is. Start it
                with <code>hildegard start</code>.
              </span>
            </div>
          ) : null}
          <div className="hg-between hg-wrap">
            <Segmented
              label="Show"
              value={filter}
              onChange={setFilter}
              options={[
                {
                  value: 'all',
                  label: `All · ${running.length + waiting.length + done.length + stopped.length}`,
                },
                { value: 'running', label: `Rendering · ${running.length}` },
                { value: 'waiting', label: `Waiting · ${waiting.length}` },
                { value: 'done', label: `Done today · ${done.length}` },
              ]}
            />
            {wc === 'compact' ? null : (
              <span className="body-sm muted">One take renders at a time. Force now jumps the line.</span>
            )}
          </div>
          {empty ? (
            <div className="hg-empty">
              <Icon name="queue" size={24} />
              <b>Nothing in the queue</b>
              <span className="body-sm muted">
                Takes you and your agents create wait here while they render.
              </span>
              <Button kind="primary" onClick={() => go('/')}>
                Go to Cinema
              </Button>
            </div>
          ) : (
            shown.map((g) =>
              g.list.length ? (
                <section key={g.key} aria-label={g.title} style={{ display: 'grid', gap: 10 }}>
                  <div className="st-grouph">
                    <b>{g.title}</b>
                    <span>{g.sub}</span>
                    {g.extra}
                  </div>
                  <div className="st-jobs">{g.list.map(row)}</div>
                </section>
              ) : null,
            )
          )}
        </div>
      </main>
      {forcing && takes.get(forcing) ? (
        <ForceDialog
          take={takes.get(forcing)!}
          title={`${shots.get(takes.get(forcing)!.shotId)?.title ?? 'this take'} · ${takeLabel(takes.get(forcing)!)}`}
          compact={wc === 'compact'}
          onClose={() => setForcing(null)}
        />
      ) : null}
    </>
  );
}
