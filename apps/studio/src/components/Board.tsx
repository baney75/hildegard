import type { Project, Shot, Take } from '@hildegard/presets';
import { useEffect, useRef } from 'react';
import { about, roman } from '../lib/format.ts';
import { useStore } from '../lib/store.ts';
import { TakeCard } from './TakeCard.tsx';
import { Icon } from './ui.tsx';

export function Board({
  project,
  selected,
  leftMs,
  scrollTo,
  onSelect,
  onForce,
}: {
  project: Project;
  selected: string | null;
  leftMs: (t: Take) => number | null;
  scrollTo: string | null;
  onSelect: (id: string) => void;
  onForce: (id: string) => void;
}) {
  const shots = useStore((s) => s.shots);
  const takes = useStore((s) => s.takes);
  const engine = useStore((s) => s.engine);
  const board = useRef<HTMLDivElement>(null);
  const list = project.shotIds.map((id) => shots.get(id)).filter((s): s is Shot => !!s);
  const selectedShot = selected ? takes.get(selected)?.shotId : null;

  useEffect(() => {
    if (!scrollTo) return;
    const el = board.current?.querySelector(`[data-shot="${scrollTo}"]`);
    el?.scrollIntoView({
      block: 'nearest',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  }, [scrollTo]);

  return (
    <div className="cs-board" ref={board}>
      {list.map((shot, i) => {
        const ts = shot.takeIds.map((id) => takes.get(id)).filter((t): t is Take => !!t);
        const running = ts.filter((t) => t.status === 'running').length;
        const waiting = ts.filter((t) => t.status === 'queued').length;
        const meta = [
          `${ts.length} ${ts.length === 1 ? 'take' : 'takes'}`,
          running ? `${running} rendering` : '',
          waiting ? `${waiting} waiting` : '',
        ]
          .filter(Boolean)
          .join(' · ');
        return (
          <section
            key={shot.id}
            className={`cs-folio${shot.id === selectedShot ? ' on' : ''}`}
            data-shot={shot.id}
            aria-labelledby={`shot-${shot.id}`}
          >
            <span className="cs-folio__no" aria-hidden="true">
              {roman(i + 1)}
            </span>
            <div className="cs-folio__h">
              <h2 className="cs-folio__t" id={`shot-${shot.id}`}>
                <span className="sr">Shot {i + 1}: </span>
                {shot.title}
              </h2>
              <span className="cs-folio__rule" />
              <span className="cs-folio__m">{meta}</span>
            </div>
            <div className="cs-grid">
              {ts.map((t) => {
                const left = t.status === 'running' ? leftMs(t) : null;
                return (
                  <TakeCard
                    key={t.id}
                    take={t}
                    selected={t.id === selected}
                    online={!!engine?.online}
                    paused={!!engine?.paused}
                    left={left === null ? null : about(left).replace('~', '')}
                    onSelect={onSelect}
                    onForce={onForce}
                  />
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function EmptyHero({ onStart, onFrame }: { onStart: () => void; onFrame: () => void }) {
  return (
    <div className="cs-hero">
      <svg
        className="cs-halo"
        viewBox="0 0 980 980"
        aria-hidden="true"
        style={{ fill: 'none', stroke: 'var(--gold-leaf)' }}
      >
        {[180, 260, 340, 420, 486].map((r, i) => (
          <circle
            key={r}
            cx="490"
            cy="490"
            r={r}
            style={{ strokeOpacity: [0.22, 0.16, 0.11, 0.07, 0.04][i] }}
          />
        ))}
      </svg>
      <div className="cs-illum-wrap">
        <svg
          viewBox="0 0 168 168"
          width="146"
          height="146"
          aria-hidden="true"
          className="cs-illum"
          style={{ flex: 'none' }}
        >
          <rect width="168" height="168" rx="24" style={{ fill: 'var(--sapphire-deep)' }} />
          <rect
            x="8"
            y="8"
            width="152"
            height="152"
            rx="18"
            style={{ fill: 'none', stroke: 'var(--gold-leaf)', strokeWidth: 1.4 }}
          />
          <rect
            x="13"
            y="13"
            width="142"
            height="142"
            rx="14"
            style={{ fill: 'none', stroke: 'var(--gold-leaf)', strokeWidth: 0.6, strokeOpacity: 0.55 }}
          />
          <circle
            cx="84"
            cy="84"
            r="55"
            style={{
              fill: 'color-mix(in oklab, var(--sapphire-deep), #000 22%)',
              stroke: 'var(--gold-leaf)',
              strokeWidth: 1,
              strokeOpacity: 0.6,
            }}
          />
          <g style={{ fill: 'var(--gold-leaf)', fillOpacity: 0.75 }}>
            {Array.from({ length: 12 }, (_, k) => {
              const a = (k * Math.PI) / 6;
              return (
                <circle
                  // biome-ignore lint/suspicious/noArrayIndexKey: a fixed ring of twelve dots
                  key={k}
                  cx={(84 + 61 * Math.cos(a)).toFixed(1)}
                  cy={(84 + 61 * Math.sin(a)).toFixed(1)}
                  r="1.6"
                />
              );
            })}
          </g>
          <text
            x="84"
            y="113"
            textAnchor="middle"
            style={{
              fontFamily: 'var(--font-display)',
              fontWeight: 600,
              fontSize: 86,
              fill: 'var(--gold-leaf)',
            }}
          >
            E
          </text>
          <path
            d="M29 139c9-1 16-6 19-14"
            style={{ fill: 'none', stroke: 'var(--brand-text)', strokeWidth: 1.4, strokeLinecap: 'round' }}
          />
          <path d="M48 125c-7 1-11 5-12 11 6-1 10-5 12-11z" style={{ fill: 'var(--brand-text)' }} />
        </svg>
        <h1 className="cs-hero__h">
          Every film begins
          <br />
          as a vision.
        </h1>
      </div>
      <p className="cs-hero__sub">Describe your first shot below, or start from a still you already have.</p>
      <div className="cs-starters">
        <button type="button" className="cs-starter" onClick={onStart}>
          <Icon name="text" size={18} />
          Describe a shot
        </button>
        <button type="button" className="cs-starter" onClick={onFrame}>
          <Icon name="upload" size={18} />
          Start from a photo
        </button>
      </div>
    </div>
  );
}
