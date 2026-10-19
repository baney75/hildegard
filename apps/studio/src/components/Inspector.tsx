import type { Catalog, Shot, Take } from '@hildegard/presets';
import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import { fromRequest, setDraft } from '../lib/draft.ts';
import { about, bytes, clock, duration, modelName, resolution, roman } from '../lib/format.ts';
import { upsert, useStore } from '../lib/store.ts';
import { previewUrl, takeLabel, waitingFor } from './TakeCard.tsx';
import { Button, Icon, LiveRing, Menu, Status, toast, toastError } from './ui.tsx';

interface Props {
  take: Take;
  shot: Shot | undefined;
  shotNo: number;
  catalog: Catalog;
  left: number | null;
  onForce: (id: string) => void;
  onClose?: () => void;
  onSelect: (id: string | null) => void;
  focusPrompt: () => void;
}

export function Inspector({
  take: t,
  shot,
  shotNo,
  catalog,
  left,
  onForce,
  onClose,
  onSelect,
  focusPrompt,
}: Props) {
  const engine = useStore((s) => s.engine);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a different take starts paused
  useEffect(() => setPlaying(false), [t.id]);

  const run = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    try {
      await fn();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };
  const again = (over: { seed?: number; quality?: 'draft' | 'final' }) =>
    run(over.quality === 'final' ? 'final' : 'retake', async () => {
      const r = await api.createShot({
        shotId: t.shotId,
        request: {
          ...t.request,
          takes: 1,
          seed: over.seed,
          format: { ...t.request.format, quality: over.quality ?? t.request.format.quality },
        },
      });
      upsert([{ type: 'shot', shot: r.shot }, ...r.takes.map((take) => ({ type: 'take' as const, take }))]);
      if (r.takes[0]) onSelect(r.takes[0].id);
    });

  const where = engine?.fake ? 'Stand-in GPU' : (engine?.device ?? 'This computer');
  const title = `Shot ${roman(shotNo)} · ${takeLabel(t)}`;
  const media = t.status === 'running' ? previewUrl(t) : t.poster;

  return (
    <div className={`cs-insp v2${t.status === 'done' ? ' poster' : ''}`} role="region" aria-label={title}>
      {t.status === 'done' ? (
        <div className="cs-poster">
          {playing && t.video ? (
            // biome-ignore lint/a11y/useMediaCaption: generated takes have no dialogue track to caption.
            <video
              className="hg-player"
              src={t.video}
              poster={t.poster ?? undefined}
              controls
              autoPlay
              playsInline
            />
          ) : (
            <>
              {t.poster ? <img src={t.poster} alt="" /> : null}
              <button
                type="button"
                className="cs-play"
                aria-label={`Play, ${clock(t.seconds)}`}
                onClick={() => setPlaying(true)}
              >
                <Icon name="play" size={22} />
              </button>
            </>
          )}
          {playing ? null : (
            <div className="cs-poster__cap">
              <div className="hg-between">
                <span className="ovl">{title}</span>
                <Status kind="done">Done</Status>
              </div>
              <h3>{shot?.title ?? 'Untitled shot'}</h3>
              <span className="cs-meta1">
                {modelName(catalog, t.model)} · seed {t.seed} · {clock(t.seconds)} · {resolution(t)}
                <br />
                {where}
                {t.renderMs ? ` · ${duration(t.renderMs)}` : ''} · <span className="ok">$0 spent</span>
              </span>
            </div>
          )}
        </div>
      ) : (
        <div className="cs-insp__media" style={{ aspectRatio: `${t.width} / ${t.height}` }}>
          {media ? (
            <img
              src={media}
              alt=""
              className={t.status === 'failed' || t.status === 'canceled' ? 'dim' : undefined}
            />
          ) : null}
          {t.status === 'running' ? (
            <span className="cs-live">
              <LiveRing value={t.progress?.value ?? null} size={56} />
            </span>
          ) : null}
        </div>
      )}

      <div className="cs-insp__body">
        {onClose ? (
          <button
            type="button"
            className="hg-btn hg-btn--icon hg-btn--ghost hg-insp__close"
            aria-label="Close"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        ) : null}
        {t.status === 'done' && playing ? (
          <div className="cs-insp__title">
            <div>
              <span className="ovl">{title}</span>
              <h3>{shot?.title}</h3>
            </div>
          </div>
        ) : null}

        {t.status !== 'done' ? (
          <div style={{ display: 'grid', gap: 6 }}>
            <div className="cs-insp__title">
              <div>
                <span className="ovl">{title}</span>
                <h3>{headline(t, !!engine?.online, !!engine?.paused)}</h3>
              </div>
            </div>
            <span className="body-sm sec-text">{explain(t, left, where)}</span>
          </div>
        ) : null}

        {t.status === 'running' ? (
          <>
            <div
              className="st-bar"
              role="progressbar"
              aria-label="Render progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round((t.progress?.value ?? 0) * 100)}
            >
              <i style={{ width: `${(t.progress?.value ?? 0) * 100}%` }} />
            </div>
            <Button
              icon="close"
              kind="ghost"
              onClick={() => run('cancel', () => api.cancel(t.id))}
              busy={busy === 'cancel'}
            >
              Cancel this take
            </Button>
          </>
        ) : null}

        {t.status === 'queued' ? (
          <div className="cs-row">
            <Button kind="force" icon="force" onClick={() => onForce(t.id)}>
              Force now
            </Button>
            <Button
              kind="ghost"
              icon="close"
              onClick={() => run('cancel', () => api.cancel(t.id))}
              busy={busy === 'cancel'}
            >
              Cancel
            </Button>
          </div>
        ) : null}

        {t.status === 'failed' || t.status === 'canceled' ? (
          <>
            {t.error?.detail ? (
              <details className="hg-details">
                <summary>What ComfyUI said</summary>
                <pre>{t.error.detail}</pre>
              </details>
            ) : null}
            <Button
              kind="primary"
              icon="reuse"
              onClick={() => run('retry', () => api.retry(t.id))}
              busy={busy === 'retry'}
              className="hg-btn--block"
            >
              Retry {t.error?.code === 'out_of_memory' ? 'as is' : ''}
            </Button>
            {t.error?.code === 'out_of_memory' && t.quality === 'final' ? (
              <Button
                icon="feather"
                onClick={() => again({ seed: t.seed, quality: 'draft' })}
                busy={busy === 'retake'}
                className="hg-btn--block"
              >
                Retry as a draft · smaller, same seed
              </Button>
            ) : null}
          </>
        ) : null}

        {t.status === 'done' ? (
          <>
            <div className="cs-actgrid">
              {t.quality === 'draft' ? (
                <button
                  type="button"
                  className="cs-act"
                  onClick={() => again({ seed: t.seed, quality: 'final' })}
                  disabled={busy === 'final'}
                >
                  <Icon name="sparkle" />
                  Finalize
                </button>
              ) : null}
              <button type="button" className="cs-act" onClick={() => again({})} disabled={busy === 'retake'}>
                <Icon name="retake" />
                Retake
              </button>
              <button
                type="button"
                className="cs-act"
                aria-pressed={t.kept}
                onClick={() =>
                  run('keep', async () => upsert({ type: 'take', take: await api.keep(t.id, !t.kept) }))
                }
              >
                <Icon name="keep" />
                {t.kept ? 'Kept' : 'Keep'}
              </button>
              <button
                type="button"
                className="cs-act"
                onClick={() => {
                  setDraft(fromRequest(t.request, t.seed));
                  toast('Settings loaded. Change the prompt or anything else, then create.');
                  focusPrompt();
                }}
              >
                <Icon name="reuse" />
                Reuse
              </button>
            </div>
            <div className="cs-row">
              <a
                className="hg-btn"
                href={t.video ?? undefined}
                download={`${(shot?.title ?? 'take').replace(/[^\w -]+/g, '').trim() || 'take'} - ${takeLabel(t)}.mp4`}
              >
                <Icon name="download" size={18} />
                Download{t.bytes ? ` · ${bytes(t.bytes)}` : ''}
              </a>
              <Menu
                label="More: copy prompt, delete take"
                items={[
                  {
                    label: 'Copy the full prompt',
                    icon: 'copy',
                    onSelect: () =>
                      navigator.clipboard?.writeText(t.prompt).then(
                        () => toast('Prompt copied'),
                        () => toast('Could not copy', { tone: 'error' }),
                      ),
                  },
                  {
                    label: 'Delete this take',
                    icon: 'trash',
                    danger: true,
                    onSelect: () =>
                      run('delete', async () => {
                        await api.deleteTake(t.id);
                        onSelect(null);
                      }),
                  },
                ]}
              />
            </div>
          </>
        ) : null}

        <details className="hg-details">
          <summary>Settings</summary>
          <dl className="hg-kv">
            <dt>Rig</dt>
            <dd>{t.summary}</dd>
            <dt>Model</dt>
            <dd>{modelName(catalog, t.model)}</dd>
            <dt>Frame</dt>
            <dd className="num">
              {t.width}×{t.height} · {t.fps} fps · {t.seconds}s
            </dd>
            <dt>Seed</dt>
            <dd className="num">{t.seed}</dd>
            <dt>Prompt</dt>
            <dd className="hg-kv__prompt">{t.prompt}</dd>
          </dl>
        </details>
      </div>
    </div>
  );
}

function headline(t: Take, online: boolean, paused: boolean): string {
  if (t.status === 'running') return 'Rendering';
  if (t.status === 'queued') return waitingFor(t, { online, paused });
  if (t.status === 'canceled') return 'Canceled';
  return t.error?.message ?? 'Stopped';
}

function explain(t: Take, left: number | null, where: string): string {
  if (t.status === 'running') {
    const pct = Math.round((t.progress?.value ?? 0) * 100);
    return `${where} · ${pct}%${left !== null ? ` · ${about(left)} left` : ''}`;
  }
  if (t.status === 'queued')
    return t.priority === 'forced'
      ? 'Forced: it goes before everything else.'
      : 'Force now to run it before the others.';
  if (t.status === 'canceled') return 'Your prompt, seed and rig are kept. Retry when you want it.';
  return `${t.error?.hint ?? 'Retry, and if it fails again the details say why.'} Your prompt, seed and rig are kept, and nothing was spent.`;
}
