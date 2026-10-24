// SPDX-License-Identifier: AGPL-3.0-only
import type { Catalog, GuestTake, Take } from '@hildegard/presets';
import { useMemo, useState } from 'react';
import { ForceDialog } from '../components/ForceDialog.tsx';
import { previewUrl, takeLabel, waitingFor } from '../components/TakeCard.tsx';
import { Button, Icon, Segmented, Status, toastError, WithCode } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import {
  about,
  comfyDown,
  deviceLabel,
  duration,
  estimateMs,
  guestFrom,
  guestLine,
  leftMs,
  modelName,
  ordinal,
  resolution,
} from '../lib/format.ts';
import { useNow, type WindowClass } from '../lib/hooks.ts';
import { isOwner, upsert, useStore } from '../lib/store.ts';

type Filter = 'all' | 'running' | 'waiting' | 'done';
/** The progress bar's colour says the state with the status word: gold only while a take renders. */
const BAR: Record<Take['status'], string> = {
  running: '',
  queued: ' q',
  done: ' ok',
  failed: ' err',
  canceled: ' idle',
};

export function Queue({ catalog, wc, go }: { catalog: Catalog; wc: WindowClass; go: (to: string) => void }) {
  const takes = useStore((s) => s.takes);
  const shots = useStore((s) => s.shots);
  const engine = useStore((s) => s.engine);
  const guests = useStore((s) => s.guests);
  const owner = useStore((s) => isOwner(s.auth));
  const me = useStore((s) => s.auth?.person?.id ?? null);
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
  const where = deviceLabel(engine);
  // Renders paired devices sent here: they take the GPU in turn like any take, so they show in line with them.
  const guestsRunning = guests.filter((g) => g.status === 'running');
  const guestsWaiting = guests.filter((g) => g.status === 'queued');
  const inLine: Array<{ take: Take } | { guest: GuestTake }> = [
    ...waiting.map((take) => ({ take })),
    ...guestsWaiting.map((guest) => ({ guest })),
  ].sort(
    (a, b) =>
      (('take' in a ? a.take.queuePosition : a.guest.queuePosition) ?? 99) -
      (('take' in b ? b.take.queuePosition : b.guest.queuePosition) ?? 99),
  );
  const busy = running.length + guestsRunning.length;

  // Time until each waiting take starts: what is left of the current render plus everything ahead of it.
  const startsIn = (() => {
    const m = new Map<string, number | null>();
    // Another device's render takes as long as it takes: nothing behind it can promise a start time.
    let acc: number | null = running[0]
      ? leftMs(running[0], estimateMs(all, running[0]), now)
      : guestsRunning.length
        ? null
        : 0;
    for (const x of inLine) {
      if ('guest' in x) {
        acc = null;
        continue;
      }
      m.set(x.take.id, acc);
      const own = estimateMs(all, x.take);
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
          <img
            src={thumb}
            alt=""
            loading="lazy"
            decoding="async"
            className={t.status === 'failed' || t.status === 'canceled' ? 'dim' : undefined}
          />
        ) : (
          <span className="thph" aria-hidden="true">
            <Icon name="video" size={18} />
          </span>
        )}
        <span style={{ minWidth: 0 }}>
          <b>
            {/* A long shot title gives way; which take it is always shows. */}
            <button type="button" className="hg-linkbtn st-job__name" onClick={open}>
              <span className="t">{shot?.title ?? 'Shot'}</span>
              <span className="k"> · {takeLabel(t)}</span>
            </button>
          </b>
          <small>
            {modelName(catalog, t.model)} · {resolution(t)} · {t.seconds}s
            {t.source.kind === 'agent' ? ` · asked by ${t.source.name}` : ''}
            {/* Whose take it is, when someone signed in from elsewhere asked for it. */}
            {t.by && t.by.id !== me ? ` · by ${t.by.name}` : ''}
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
            className={`st-bar${BAR[t.status]}`}
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
          <small className={t.status === 'failed' ? 'wrap' : undefined}>
            {t.status === 'running'
              ? pct >= 100
                ? 'Finishing'
                : left !== null
                  ? `${about(left).replace('~', '')} left`
                  : `${pct}%`
              : null}
            {t.status === 'queued'
              ? // While paused or offline nothing starts, so it says why instead of when.
                `${t.queuePosition ? ordinal(t.queuePosition) : 'Next'}${!engine?.online || engine.paused ? ` · ${waitingFor(t, { online: !!engine?.online, paused: !!engine?.paused })}` : starts ? ` · starts in ${about(starts)}` : ''}`
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

  /** A paired device's render: who sent it and how far along it is. Its prompt stays on that device. */
  const guestRow = (g: GuestTake) => {
    const pct = Math.round((g.progress ?? 0) * 100);
    const live = g.status === 'running';
    return (
      <div key={g.id} className={`st-job${live ? ' live' : ''}`} title={guestLine(g)} data-guest={g.id}>
        <span className="thph" aria-hidden="true">
          <Icon name="desktop" size={18} />
        </span>
        <span style={{ minWidth: 0 }}>
          <b>{guestFrom(g)}</b>
          <small>
            {g.quality === 'draft' ? 'A draft' : g.quality === 'final' ? 'A final take' : 'A take'} sent from
            another of your devices
          </small>
        </span>
        <span style={{ display: 'grid', gap: 6 }}>
          {live ? <Status kind="running">Rendering</Status> : <Status kind="queued">Waiting</Status>}
          <span
            className={`st-bar${live ? '' : ' q'}`}
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
            {live
              ? pct >= 100
                ? 'Finishing'
                : `${pct}%`
              : `${g.queuePosition ? ordinal(g.queuePosition) : 'Next'}${!engine?.online || engine.paused ? ` · ${waitingFor(g, { online: !!engine?.online, paused: !!engine?.paused })}` : ''}`}
          </small>
        </span>
        <span className="acts" />
      </div>
    );
  };
  const nTakes = (n: number) => (n === 1 ? '1 take' : `${n} takes`);
  const waitingCount = inLine.length;

  const groups: Array<{
    key: Filter;
    title: string;
    rows: React.ReactNode[];
    sub: string;
    extra?: React.ReactNode;
  }> = [
    {
      key: 'running',
      title: 'Rendering',
      rows: [...guestsRunning.map(guestRow), ...running.map(row)],
      sub: nTakes(busy),
    },
    {
      key: 'waiting',
      title: 'Waiting',
      rows: inLine.map((x) => ('take' in x ? row(x.take) : guestRow(x.guest))),
      sub: nTakes(waitingCount),
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
      rows: [...done, ...stopped].map(row),
      sub: `${done.length} made${stopped.length ? ` · ${stopped.length} stopped` : ''} · $0.00 spent`,
    },
  ];
  const shown = groups.filter((g) => filter === 'all' || g.key === filter);
  const empty = !busy && !waitingCount && !done.length && !stopped.length;

  return (
    <>
      <header className="hg-app__top">
        <div className="cs-crumb">
          <span className="t">Queue</span>
          <span className="s">
            {engine?.online
              ? `${engine.comfy === 'remote' ? `Rendering on ${where}` : where}${engine.paused ? ' · paused' : busy ? ' · busy' : ' · ready'}`
              : comfyDown(engine).short}
          </span>
        </div>
        {owner ? (
          <div className="hg-app__topactions">
            <Button icon={engine?.paused ? 'play' : 'pause'} onClick={pauseAll}>
              {engine?.paused ? 'Resume' : 'Pause all'}
            </Button>
          </div>
        ) : null}
      </header>
      <main className="cs-stage hg-scroll" id="main">
        <div className="st-page">
          {!engine?.online ? (
            <div className="st-tile hg-banner" role="status">
              <Icon name="alert" size={18} />
              <span>
                <WithCode text={comfyDown(engine).long} />
              </span>
            </div>
          ) : null}
          <div className="hg-between hg-wrap">
            <Segmented
              className="hg-seg hg-seg--fill"
              label="Show"
              value={filter}
              onChange={setFilter}
              options={[
                {
                  value: 'all',
                  label: `All · ${busy + waitingCount + done.length + stopped.length}`,
                },
                { value: 'running', label: `Rendering · ${busy}` },
                { value: 'waiting', label: `Waiting · ${waitingCount}` },
                {
                  value: 'done',
                  label: `${wc === 'compact' ? 'Done' : 'Done today'} · ${done.length + stopped.length}`,
                },
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
              g.rows.length ? (
                <section key={g.key} aria-label={g.title} style={{ display: 'grid', gap: 10 }}>
                  <div className="st-grouph">
                    <b>{g.title}</b>
                    <span>{g.sub}</span>
                    {g.extra}
                  </div>
                  <div className="st-jobs">{g.rows}</div>
                </section>
              ) : null,
            )
          )}
        </div>
      </main>
      {forcing && takes.get(forcing) ? (
        <ForceDialog
          take={takes.get(forcing)!}
          title={shots.get(takes.get(forcing)!.shotId)?.title ?? 'Untitled shot'}
          compact={wc === 'compact'}
          onClose={() => setForcing(null)}
        />
      ) : null}
    </>
  );
}
