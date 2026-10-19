import type { Catalog } from '@hildegard/presets';
import { type ClipboardEvent, type DragEvent, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '../lib/api.ts';
import { getDraft, setDraft, toRequest, useDraft } from '../lib/draft.ts';
import { about, estimateMs } from '../lib/format.ts';
import type { WindowClass } from '../lib/hooks.ts';
import { getState, upsert, useStore } from '../lib/store.ts';
import { FormatSheet, LookSheet, lookSummary, ModelSheet, MotionSheet, RigSheet } from './sheets.tsx';
import { Icon, toast, toastError } from './ui.tsx';

type SheetName = 'rig' | 'motion' | 'look' | 'format' | 'model' | null;

export function Composer({
  catalog,
  projectId,
  wc,
  go,
  onCreated,
}: {
  catalog: Catalog;
  projectId: string | null;
  wc: WindowClass;
  go: (to: string) => void;
  onCreated: (shotId: string, takeId: string | undefined) => void;
}) {
  const draft = useDraft();
  const models = useStore((s) => s.models);
  const engine = useStore((s) => s.engine);
  const takes = useStore((s) => s.takes);
  const [sheet, setSheet] = useState<SheetName>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<{ text: string; field?: string } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);

  const installed = models.filter((m) => m.installed).map((m) => m.id);
  // The chosen model if it is installed, otherwise the first installed one. The stand-in GPU renders any model.
  const usable = engine?.fake ? catalog.models.map((m) => m.id) : installed;
  const modelId = draft.model && usable.includes(draft.model) ? draft.model : (usable[0] ?? null);
  const model = catalog.models.find((m) => m.id === modelId) ?? null;
  const seconds = model ? Math.min(draft.format.seconds, model.maxSeconds) : draft.format.seconds;

  const body = catalog.bodies.find((b) => b.id === draft.rig.body);
  const lens = catalog.lenses.find((l) => l.id === draft.rig.lens);
  const motionNames = draft.motion
    .map((m) => catalog.motions.find((x) => x.id === m.id)?.name)
    .filter(Boolean);
  const palette = catalog.palettes.find((p) => p.id === draft.look.palette);
  const look = lookSummary(catalog, draft.look);

  const estimate = useMemo(() => {
    if (!model) return null;
    const aspect = catalog.aspects.find((a) => a.id === draft.format.aspect);
    if (!aspect) return null;
    const q = model[draft.format.quality];
    const scale = q.height / Math.min(aspect.width, aspect.height);
    const one = estimateMs(takes.values(), {
      model: model.id,
      quality: draft.format.quality,
      width: aspect.width * scale,
      height: aspect.height * scale,
      seconds,
      fps: model.fps,
    });
    return one === null ? null : one * draft.takes;
  }, [model, catalog, draft.format, draft.takes, seconds, takes]);

  // ⌘/Ctrl-K jumps to the prompt from anywhere.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  // Grow the prompt with its text, up to a limit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text changes
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft.prompt]);

  const addFrame = async (f: File | Blob | null | undefined) => {
    if (!f) return;
    if (f.size > 20 * 1024 * 1024) return toast('Images up to 20 MB', { tone: 'error' });
    setUploading(true);
    try {
      const r = await api.upload(f);
      setDraft({ startFrame: r });
    } catch (e) {
      toastError(e);
    } finally {
      setUploading(false);
    }
  };

  const create = async () => {
    const d = getDraft();
    if (!d.prompt.trim()) {
      setError({ text: 'Describe the shot first.', field: 'prompt' });
      input.current?.focus();
      return;
    }
    if (!modelId) {
      setSheet('model');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api.createShot({
        projectId: projectId ?? undefined,
        request: toRequest({ ...d, format: { ...d.format, seconds } }, modelId),
      });
      upsert([
        { type: 'project', project: r.project },
        { type: 'shot', shot: r.shot },
        ...r.takes.map((take) => ({ type: 'take' as const, take })),
      ]);
      setDraft({ prompt: '' });
      onCreated(r.shot.id, r.takes[0]?.id);
      if (!getState().engine?.online) toast('Queued. Takes start when ComfyUI is running.');
    } catch (e) {
      if (e instanceof ApiError && e.field) {
        setError({ text: e.message, field: e.field });
        const where: Record<string, SheetName> = {
          rig: 'rig',
          motion: 'motion',
          look: 'look',
          format: 'format',
          model: 'model',
        };
        const s = where[e.field.split('.')[0]!];
        if (s) setSheet(s);
        else if (e.field === 'prompt') input.current?.focus();
      } else toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const onPaste = (e: ClipboardEvent) => {
    const img = [...e.clipboardData.items].find((i) => i.type.startsWith('image/'));
    if (img) {
      e.preventDefault();
      void addFrame(img.getAsFile());
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
    if (f) void addFrame(f);
    else toast('Drop a PNG, JPEG or WebP image', { tone: 'error' });
  };

  const compact = wc === 'compact';
  const variant = compact ? 'bottom' : 'center';
  const takesWord = `${draft.takes} ${draft.format.quality === 'draft' ? (draft.takes === 1 ? 'draft' : 'drafts') : draft.takes === 1 ? 'take' : 'takes'}`;
  const where = engine?.fake ? 'stand-in GPU' : (engine?.device ?? 'This computer').replace(/^This/, 'this');
  const createLabel = !modelId ? 'Choose a model' : `Create ${takesWord}`;
  const createSub = !modelId
    ? 'Install one to start'
    : estimate
      ? `${about(estimate)} on ${where}`
      : `On ${where}`;

  return (
    <div
      className="cs-comp"
      role="group"
      aria-label="Direct a shot"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div className={`cs-comp__box${dragging ? ' is-drop' : ''}`}>
        <div className="cs-comp__in">
          {draft.startFrame ? (
            <div className="hg-frame">
              <button
                type="button"
                className="cs-attach"
                aria-label="Replace the start frame"
                onClick={() => file.current?.click()}
              >
                <img src={draft.startFrame.url} alt="" />
                <span className="lbl">Start</span>
              </button>
              <button
                type="button"
                className="hg-frame__x"
                aria-label="Remove the start frame"
                onClick={() => setDraft({ startFrame: null })}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              className={`cs-attach empty${dragging ? ' target' : ''}`}
              aria-label="Add a start frame"
              aria-busy={uploading || undefined}
              onClick={() => file.current?.click()}
            >
              <Icon name={uploading ? 'upload' : 'plus'} size={18} />
            </button>
          )}
          <input
            ref={file}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={(e) => {
              void addFrame(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <label className="sr" htmlFor="hg-prompt">
            Describe the shot
          </label>
          <textarea
            id="hg-prompt"
            ref={input}
            className="cs-prompt__line hg-promptfield"
            rows={1}
            maxLength={2000}
            value={draft.prompt}
            placeholder={
              compact
                ? 'Describe the shot'
                : 'Describe the shot: who, what happens, where. ⌘/Ctrl-Enter to create.'
            }
            aria-invalid={error?.field === 'prompt' || undefined}
            aria-describedby={error ? 'hg-comp-err' : undefined}
            onChange={(e) => {
              setDraft({ prompt: e.target.value });
              if (error?.field === 'prompt') setError(null);
            }}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void create();
              }
            }}
          />
        </div>
        <div className="cs-comp__bar">
          <div className="hg-pills" role="group" aria-label="Shot settings">
            <button
              type="button"
              className="cs-pill"
              onClick={() => setSheet('model')}
              aria-label={model ? `Model: ${model.name}` : 'Choose a model'}
            >
              <Icon name="video" size={16} />
              {model?.name ?? 'Choose a model'}
            </button>
            <button
              type="button"
              className="cs-pill"
              onClick={() => setSheet('look')}
              aria-label={look ? `Look: ${look}` : 'Set a look'}
            >
              {palette ? (
                <span className="sw">
                  {palette.colors.slice(0, 3).map((c) => (
                    <i key={c} style={{ background: c }} />
                  ))}
                </span>
              ) : (
                <Icon name="sparkle" size={16} />
              )}
              {compact ? null : look ? 'Look' : 'Set a look'}
            </button>
            <button
              type="button"
              className="cs-pill"
              onClick={() => setSheet('rig')}
              aria-label={`Camera rig: ${body?.name}, ${lens?.name} · ${draft.rig.focal}mm`}
            >
              <Icon name="camera" size={16} />
              {compact ? `${draft.rig.focal}mm` : `${lens?.name} · ${draft.rig.focal}mm`}
            </button>
            <button
              type="button"
              className="cs-pill"
              onClick={() => setSheet('motion')}
              aria-label={`Camera motion: ${motionNames.join(' + ') || 'none'}`}
            >
              <Icon name="rotate" size={16} />
              {compact ? motionNames.length || null : motionNames.length ? motionNames.join(' + ') : 'Motion'}
            </button>
            <button
              type="button"
              className="cs-pill"
              onClick={() => setSheet('format')}
              aria-label={`Format: ${draft.format.aspect} · ${seconds}s · ${draft.format.quality === 'draft' ? 'Draft' : 'Final'}`}
            >
              {draft.format.aspect} · {seconds}s
              {compact ? '' : ` · ${draft.format.quality === 'draft' ? 'Draft' : 'Final'}`}
            </button>
            <button
              type="button"
              className={`cs-pill${draft.seed !== null ? ' lock' : ''}`}
              onClick={() => setSheet('format')}
              aria-label={draft.seed !== null ? `Seed ${draft.seed}, locked` : 'Seed: random'}
            >
              <Icon name={draft.seed !== null ? 'lock' : 'unlock'} size={16} />
              {compact ? null : <span className="num">{draft.seed ?? 'Random'}</span>}
            </button>
          </div>
          <button
            type="button"
            className="cs-create"
            onClick={create}
            disabled={busy}
            aria-busy={busy || undefined}
          >
            <Icon name="studio" size={18} />
            <span>
              <b>{createLabel}</b>
              <small>{createSub}</small>
            </span>
          </button>
        </div>
      </div>
      {error ? (
        <p id="hg-comp-err" className="cs-comp__cost hg-err" role="alert">
          {error.text}
        </p>
      ) : (
        <p className="cs-comp__cost">
          Est. <span className="num">$0.00</span> · Stays on your devices
        </p>
      )}
      {sheet === 'rig' ? (
        <RigSheet open onClose={() => setSheet(null)} catalog={catalog} draft={draft} variant={variant} />
      ) : null}
      {sheet === 'motion' ? (
        <MotionSheet open onClose={() => setSheet(null)} catalog={catalog} draft={draft} variant={variant} />
      ) : null}
      {sheet === 'look' ? (
        <LookSheet open onClose={() => setSheet(null)} catalog={catalog} draft={draft} variant={variant} />
      ) : null}
      {sheet === 'format' ? (
        <FormatSheet
          open
          onClose={() => setSheet(null)}
          catalog={catalog}
          draft={draft}
          variant={variant}
          maxSeconds={model?.maxSeconds ?? 10}
        />
      ) : null}
      {sheet === 'model' ? (
        <ModelSheet
          open
          onClose={() => setSheet(null)}
          catalog={catalog}
          draft={{ ...draft, model: modelId }}
          variant={variant}
          go={go}
        />
      ) : null}
    </div>
  );
}
