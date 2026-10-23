// SPDX-License-Identifier: AGPL-3.0-only
import type { Take } from '@hildegard/presets';
import { memo, useRef, useState } from 'react';
import { clock, ordinal } from '../lib/format.ts';
import { Icon, LiveRing, Status } from './ui.tsx';

export function takeLabel(t: Take): string {
  return `${t.quality === 'draft' ? 'Draft' : 'Take'} ${t.number}${t.kept ? ' · kept' : ''}`;
}

/** What a waiting take is waiting for, in a few words. */
export function waitingFor(
  t: Pick<Take, 'queuePosition'>,
  ctx: { online: boolean; paused: boolean },
): string {
  if (!ctx.online) return 'Waiting for ComfyUI';
  if (ctx.paused) return 'Paused';
  return t.queuePosition && t.queuePosition > 1 ? `${ordinal(t.queuePosition)} in line` : 'Up next';
}

export const previewUrl = (t: Take) =>
  t.previewVersion > 0 ? `/api/takes/${t.id}/preview?v=${t.previewVersion}` : null;

interface Props {
  take: Take;
  selected: boolean;
  online: boolean;
  paused: boolean;
  left: string | null;
  onSelect: (id: string) => void;
  onForce: (id: string) => void;
}

function TakeCardImpl({ take: t, selected, online, paused, left, onSelect, onForce }: Props) {
  const [hover, setHover] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const cls = [
    'cs-card',
    selected && 'is-selected',
    t.status === 'running' && 'is-running',
    t.status === 'queued' && 'is-queued',
    (t.status === 'failed' || t.status === 'canceled') && 'is-failed',
  ]
    .filter(Boolean)
    .join(' ');
  const preview = previewUrl(t);
  const pct = t.progress ? Math.round(t.progress.value * 100) : 0;
  const aspect = `${t.width} / ${t.height}`;
  let status: string;
  if (t.status === 'running')
    status = left ? `Rendering · ${left} left` : t.progress?.value ? `Rendering · ${pct}%` : 'Starting';
  else if (t.status === 'queued') status = waitingFor(t, { online, paused });
  else if (t.status === 'failed') status = t.error?.message ?? 'Failed';
  else if (t.status === 'canceled') status = 'Canceled';
  else status = takeLabel(t);

  return (
    <article className={cls} aria-label={`${takeLabel(t)}: ${t.status === 'done' ? 'done' : status}`}>
      <button
        type="button"
        className="cs-card__media"
        style={{ aspectRatio: aspect }}
        // A stopped take shows its last frame dimmed almost to black, so its words keep the dark theme's colours.
        data-theme={(t.status === 'failed' || t.status === 'canceled') && t.poster ? 'dark' : undefined}
        aria-pressed={selected}
        onClick={() => onSelect(t.id)}
        onMouseEnter={() => t.video && setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => t.video && setHover(true)}
        onBlur={() => setHover(false)}
      >
        <span className="sr">Open {takeLabel(t)}, </span>
        {t.status === 'done' && t.poster ? (
          <img src={t.poster} alt="" loading="lazy" decoding="async" />
        ) : null}
        {t.status === 'done' && hover && t.video ? (
          <video
            ref={video}
            src={t.video}
            muted
            loop
            playsInline
            autoPlay
            preload="auto"
            tabIndex={-1}
            aria-hidden="true"
          />
        ) : null}
        {t.status === 'running' && preview ? <img src={preview} alt="" decoding="async" /> : null}
        {(t.status === 'failed' || t.status === 'canceled') && t.poster ? (
          <img src={t.poster} alt="" className="dim" />
        ) : null}
        {t.status === 'done' ? (
          <span className="cs-badge">
            <Icon name="video" size={14} />
            {clock(t.seconds)}
          </span>
        ) : null}
        {t.status === 'done' && t.quality === 'draft' ? (
          <span className="cs-badge draft" aria-hidden="true">
            <Icon name="feather" size={14} />
            Draft
          </span>
        ) : null}
        {t.status === 'running' ? (
          <>
            {t.progress?.steps ? (
              <span className="cs-badge r">
                {t.progress.step ?? 0} / {t.progress.steps}
              </span>
            ) : null}
            <span className="cs-live">
              <LiveRing value={t.progress?.value ?? null} />
            </span>
          </>
        ) : null}
        {t.status === 'queued' ? (
          <span className="cs-qmeta">
            <Status kind="queued">{t.priority === 'forced' ? 'Forced' : 'Queued'}</Status>
            <b>{status}</b>
          </span>
        ) : null}
        {t.status === 'failed' || t.status === 'canceled' ? (
          <span className="cs-qmeta">
            <Status kind={t.status === 'failed' ? 'error' : 'idle'}>
              {t.status === 'failed' ? 'Stopped' : 'Canceled'}
            </Status>
            <b>
              {t.status === 'failed' ? (t.error?.message ?? 'Something went wrong') : 'Nothing was rendered'}
            </b>
          </span>
        ) : null}
      </button>
      <div className="cs-card__meta">
        {t.status === 'running' ? (
          <span className="st">
            <Status kind="running">{status}</Status>
          </span>
        ) : (
          <b>{takeLabel(t)}</b>
        )}
        {t.source.kind === 'agent' ? <span className="cs-sub">Asked by {t.source.name}</span> : null}
        {t.status === 'queued' ? (
          <div className="cs-cardacts">
            <button type="button" className="hg-btn hg-btn--sm hg-btn--force" onClick={() => onForce(t.id)}>
              <Icon name="force" size={16} />
              Force now
            </button>
          </div>
        ) : null}
      </div>
    </article>
  );
}
export const TakeCard = memo(TakeCardImpl);
