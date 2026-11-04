// SPDX-License-Identifier: AGPL-3.0-only
import type { Catalog, Still } from '@hildegard/presets';
import { type DragEvent, useEffect, useMemo, useRef, useState } from 'react';
import { LookSheet, lookSummary, RigSheet } from '../components/sheets.tsx';
import {
  Button,
  Icon,
  LiveRing,
  Modal,
  RadioGroup,
  Segmented,
  Status,
  Switch,
  toast,
  toastError,
} from '../components/ui.tsx';
import { ApiError, api, type ImageBody, type UploadResult } from '../lib/api.ts';
import { DEFAULT_DRAFT, type Draft, getDraft, setDraft } from '../lib/draft.ts';
import { deviceLabel } from '../lib/format.ts';
import { useLocal, type WindowClass } from '../lib/hooks.ts';
import { isOwner, upsert, useStore } from '../lib/store.ts';

const MAX_REFERENCES = 4;
const MAX_BYTES = 20 * 1024 * 1024;
/** The same words the character page asks for, for the same reason: real people consent for themselves. */
const ATTEST =
  'This image shows no real person, or only artwork you have the rights to. To draw a real person, make a character for them and let them consent themselves.';

/** What the composer holds between visits. References are not kept: they are uploads of this visit. */
interface Form {
  prompt: string;
  aspect: string;
  quality: 'draft' | 'final';
  count: number;
  /** A number when the seed is locked; null for a fresh seed each time. */
  seed: number | null;
  /** Null until the person picks a camera: then the camera words stay out of the prompt. */
  rig: Draft['rig'] | null;
  look: Draft['look'];
}
const FORM: Form = {
  prompt: '',
  aspect: '1:1',
  quality: 'draft',
  count: 2,
  seed: null,
  rig: null,
  look: {},
};

type Group = 'prompt' | 'format' | 'references' | 'camera' | 'make';
/** Which part of the composer an error from the server belongs beside. */
function groupOf(field: string | undefined): Group {
  const head = field?.split('.')[0];
  if (head === 'prompt') return 'prompt';
  if (head === 'aspect' || head === 'quality' || head === 'count' || head === 'seed') return 'format';
  if (head === 'references' || head === 'noRealPerson') return 'references';
  if (head === 'camera' || head === 'look') return 'camera';
  return 'make';
}

const isImage = (s: Still) => s.characterId === null;
const isLive = (s: Still) => s.status === 'queued' || s.status === 'running';
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A finished image's file, as an upload the server can use as a reference or a start frame. */
async function uploadImage(s: Still): Promise<UploadResult> {
  if (!s.image) throw new Error('This image isn’t finished yet.');
  const res = await fetch(s.image);
  if (!res.ok) throw new Error('Hildegard couldn’t read that image.');
  return api.upload(await res.blob());
}

export function Images({ catalog, wc, go }: { catalog: Catalog; wc: WindowClass; go: (to: string) => void }) {
  const allStills = useStore((s) => s.stills);
  const models = useStore((s) => s.models);
  const engine = useStore((s) => s.engine);
  const auth = useStore((s) => s.auth);
  const [saved, setSaved] = useLocal<Partial<Form>>('hildegard.images', {});
  const form: Form = useMemo(() => ({ ...FORM, ...saved }), [saved]);
  const patch = (p: Partial<Form>) => setSaved((prev) => ({ ...prev, ...p }));
  const [refs, setRefs] = useState<UploadResult[]>([]);
  const [sure, setSure] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; group: Group } | null>(null);
  const [missing, setMissing] = useState(false);
  const [fold, setFold] = useState(false);
  const [sheet, setSheet] = useState<'rig' | 'look' | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const prompt = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const compact = wc === 'compact';

  const images = useMemo(
    () => [...allStills.values()].filter(isImage).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [allStills],
  );
  const opened = open ? allStills.get(open) : undefined;
  useEffect(() => {
    if (open && !allStills.has(open)) setOpen(null);
  }, [open, allStills]);

  // The stills model is not installed: the page says so up front, and the server's refusal says it too.
  const stillsModel = catalog.models.find((m) => m.graph === 'flux-2-klein');
  const state = models.find((m) => m.id === stillsModel?.id);
  const notInstalled = !engine?.fake && !!state && !state.installed;
  const showMissing = notInstalled || missing;
  useEffect(() => {
    if (state?.installed) setMissing(false);
  }, [state?.installed]);

  // Grow the prompt with its text, up to a limit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text changes
  useEffect(() => {
    const el = prompt.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [form.prompt]);

  const addFiles = async (list: File[]) => {
    const room = MAX_REFERENCES - refs.length;
    const files = list.filter((f) => f.type.startsWith('image/'));
    if (!files.length) return toast('Choose a PNG, JPEG or WebP image', { tone: 'error' });
    if (files.length > room)
      toast(
        room
          ? `Up to ${MAX_REFERENCES} reference images. Added the first ${room}.`
          : `Up to ${MAX_REFERENCES} reference images.`,
        { tone: 'error' },
      );
    for (const f of files.slice(0, room)) {
      if (f.size > MAX_BYTES) {
        toast('Images up to 20 MB', { tone: 'error' });
        continue;
      }
      setUploading((n) => n + 1);
      try {
        const r = await api.upload(f);
        setRefs((prev) =>
          prev.some((x) => x.name === r.name) || prev.length >= MAX_REFERENCES ? prev : [...prev, r],
        );
        setError((e) => (e?.group === 'references' ? null : e));
      } catch (e) {
        toastError(e);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void addFiles([...e.dataTransfer.files]);
  };

  const focusPrompt = () => {
    const el = prompt.current;
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.focus({ preventScroll: true });
  };
  /** Edit: the finished image becomes the next reference. */
  const edit = async (s: Still) => {
    if (refs.length >= MAX_REFERENCES)
      return toast(`Up to ${MAX_REFERENCES} reference images. Remove one first.`, { tone: 'error' });
    setUploading((n) => n + 1);
    try {
      const r = await uploadImage(s);
      setRefs((prev) => (prev.some((x) => x.name === r.name) ? prev : [...prev, r].slice(0, MAX_REFERENCES)));
      setOpen(null);
      toast('Added as a reference. Say what to change, then make it.');
      requestAnimationFrame(focusPrompt);
    } catch (e) {
      toastError(e);
    } finally {
      setUploading((n) => n - 1);
    }
  };
  /** Use as start frame: Cinema's composer already holds its start frame in the shared draft. */
  const startFrame = async (s: Still) => {
    try {
      const r = await uploadImage(s);
      setDraft({ startFrame: { name: r.name, url: r.url }, cast: [] });
      setOpen(null);
      go('/');
    } catch (e) {
      toastError(e);
    }
  };

  const make = async () => {
    if (!form.prompt.trim()) {
      setError({ text: 'Describe the image first.', group: 'prompt' });
      prompt.current?.focus();
      return;
    }
    if (refs.length && !sure) {
      setError({ text: 'Say that the reference images show no real person first.', group: 'references' });
      return;
    }
    const body: ImageBody = {
      prompt: form.prompt.trim(),
      aspect: form.aspect,
      quality: form.quality,
      count: form.count,
      ...(form.seed !== null ? { seed: form.seed } : {}),
      ...(refs.length ? { references: refs.map((r) => r.name), noRealPerson: true as const } : {}),
      ...(form.rig ? { camera: { ...form.rig } } : {}),
      ...(Object.values(form.look).some(Boolean)
        ? { look: Object.fromEntries(Object.entries(form.look).filter(([, v]) => v)) }
        : {}),
    };
    setBusy(true);
    setError(null);
    try {
      const r = await api.makeImages(body);
      upsert(r.stills.map((still) => ({ type: 'still' as const, still })));
      setMissing(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) {
        if (e.code === 'missing_model') setMissing(true);
        const group = groupOf(e.field);
        setError({ text: e.message, group });
        if (group === 'camera') setFold(true);
        if (group === 'prompt') prompt.current?.focus();
      } else toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const aspect = catalog.aspects.find((a) => a.id === form.aspect);
  const body = catalog.bodies.find((b) => b.id === form.rig?.body);
  const lens = catalog.lenses.find((l) => l.id === form.rig?.lens);
  const lookLine = lookSummary(catalog, form.look);
  const where = deviceLabel(engine).replace(/^(This|Stand-in)/, (m) => m.toLowerCase());
  const needsOk = refs.length > 0 && !sure;
  const err = (g: Group) =>
    error?.group === g ? (
      <p id={`im-err-${g}`} className="hg-err body-sm im-err" role="alert">
        {error.text}
      </p>
    ) : null;
  const sheetDraft: Draft = {
    ...getDraft(),
    rig: form.rig ?? DEFAULT_DRAFT.rig,
    look: form.look,
    format: { ...DEFAULT_DRAFT.format, aspect: form.aspect },
  };

  return (
    <>
      <header className="hg-app__top">
        <div className="cs-crumb">
          <span className="t">Images</span>
          <span className="s">
            {images.length
              ? `${plural(images.length, 'image', 'images')} · from words, or edits of your own`
              : 'Stills from words, or edits of images you already have'}
          </span>
        </div>
      </header>
      <main className="cs-stage hg-scroll" id="main">
        <div className="st-page im-page">
          {showMissing ? (
            <div className="st-tile hg-banner" role="status">
              <Icon name="alert" size={18} />
              <span>
                Images are drawn with {stillsModel?.name ?? 'the stills model'}, which isn’t installed on this
                computer.{' '}
                {isOwner(auth) ? (
                  <>
                    Install it in <a href="#/settings/models">Settings › Models</a>.
                  </>
                ) : (
                  'Ask whoever runs this Hildegard to install it.'
                )}
              </span>
            </div>
          ) : null}
          <div className="im-layout">
            <section
              className={`st-tile im-comp${dragging ? ' is-drop' : ''}`}
              aria-labelledby="im-comp-h"
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
              }}
              onDrop={onDrop}
            >
              <h2 id="im-comp-h" className="st-h2">
                Make an image
              </h2>
              <div className="hg-field hg-field--block">
                <label htmlFor="im-prompt">Describe the image</label>
                <textarea
                  id="im-prompt"
                  ref={prompt}
                  className="cs-area im-prompt"
                  rows={3}
                  maxLength={2000}
                  value={form.prompt}
                  placeholder={
                    refs.length
                      ? 'Say what to change. Refer to “image 1”, “image 2” and so on.'
                      : 'A fishing boat at dawn, mist on the water, gulls overhead'
                  }
                  aria-invalid={error?.group === 'prompt' || undefined}
                  aria-describedby={error?.group === 'prompt' ? 'im-err-prompt' : undefined}
                  onChange={(e) => {
                    patch({ prompt: e.target.value });
                    if (error?.group === 'prompt') setError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      void make();
                    }
                  }}
                />
                {err('prompt')}
              </div>

              <div className="im-block">
                <span className="ovl">Shape</span>
                <RadioGroup label="Aspect ratio" className="hg-chips">
                  {catalog.aspects.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      className="hg-chip"
                      role="radio"
                      aria-checked={form.aspect === a.id}
                      tabIndex={form.aspect === a.id ? 0 : -1}
                      title={a.name}
                      onClick={() => patch({ aspect: a.id })}
                    >
                      {a.id}
                    </button>
                  ))}
                </RadioGroup>
              </div>

              <div className="im-row">
                <div className="im-block">
                  <span className="ovl">How many</span>
                  <Segmented
                    className="cs-seg"
                    label="How many images"
                    value={form.count}
                    onChange={(count) => patch({ count })}
                    options={[1, 2, 3, 4].map((n) => ({ value: n, label: String(n) }))}
                  />
                </div>
                <div className="im-block">
                  <span className="ovl">Quality</span>
                  <Segmented
                    className="cs-seg"
                    label="Quality"
                    value={form.quality}
                    onChange={(quality) => patch({ quality })}
                    options={[
                      { value: 'draft', label: 'Draft' },
                      { value: 'final', label: 'Final' },
                    ]}
                  />
                </div>
              </div>

              <div className="im-seed">
                <Switch
                  label="Lock the seed"
                  checked={form.seed !== null}
                  onChange={(on) => patch({ seed: on ? Math.floor(Math.random() * 1_000_000_000) : null })}
                />
                <span className="body-sm">{form.seed === null ? 'Fresh seed each time' : 'Seed locked'}</span>
                {form.seed !== null ? (
                  <input
                    className="im-seed__n num"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={4294967295}
                    aria-label="Seed"
                    value={form.seed}
                    aria-invalid={error?.group === 'format' || undefined}
                    onChange={(e) => {
                      const n = Math.trunc(Number(e.target.value));
                      patch({ seed: Number.isFinite(n) && n >= 0 ? n : 0 });
                      if (error?.group === 'format') setError(null);
                    }}
                  />
                ) : null}
              </div>
              {err('format')}

              <div className="im-fold">
                <button
                  type="button"
                  className="im-fold__h"
                  aria-expanded={fold}
                  aria-controls="im-fold-b"
                  onClick={() => setFold(!fold)}
                >
                  <Icon name="camera" size={18} />
                  <span>Camera and look</span>
                  <small className="muted">{form.rig || lookLine ? 'Set' : 'Optional'}</small>
                  <Icon name={fold ? 'close' : 'plus'} size={16} />
                </button>
                {fold ? (
                  <div id="im-fold-b" className="im-fold__b">
                    <div className="im-pick">
                      <Button icon="camera" onClick={() => setSheet('rig')}>
                        {form.rig
                          ? `${body?.name ?? form.rig.body} · ${lens?.name ?? form.rig.lens} · ${form.rig.focal}mm`
                          : 'Choose a camera'}
                      </Button>
                      {form.rig ? (
                        <Button kind="ghost" onClick={() => patch({ rig: null })}>
                          Clear
                        </Button>
                      ) : null}
                    </div>
                    <div className="im-pick">
                      <Button icon="sparkle" onClick={() => setSheet('look')}>
                        {lookLine || 'Set a look'}
                      </Button>
                      {lookLine ? (
                        <Button kind="ghost" onClick={() => patch({ look: {} })}>
                          Clear
                        </Button>
                      ) : null}
                    </div>
                    {err('camera')}
                  </div>
                ) : null}
              </div>

              <div className="im-block" role="group" aria-labelledby="im-refs-l">
                <div className="im-refs__h">
                  <span className="ovl" id="im-refs-l">
                    References · {refs.length} of {MAX_REFERENCES}
                  </span>
                  <span className="body-sm muted">
                    Optional. Drop images here to edit them or draw from them.
                  </span>
                </div>
                <div className="im-refs">
                  {refs.map((r, i) => (
                    <figure key={r.name} className="im-ref">
                      <img src={r.url} alt={`Reference ${i + 1}`} />
                      <figcaption className="num">{i + 1}</figcaption>
                      <button
                        type="button"
                        className="hg-btn hg-btn--sm hg-btn--icon hg-btn--ghost im-ref__x"
                        aria-label={`Remove reference image ${i + 1}`}
                        onClick={() => setRefs(refs.filter((x) => x.name !== r.name))}
                      >
                        <Icon name="close" size={16} />
                      </button>
                    </figure>
                  ))}
                  {refs.length < MAX_REFERENCES ? (
                    <button
                      type="button"
                      className="im-refs__add"
                      aria-busy={uploading > 0 || undefined}
                      onClick={() => file.current?.click()}
                    >
                      <Icon name={uploading ? 'upload' : 'plus'} size={18} />
                      <small>Add images</small>
                    </button>
                  ) : null}
                </div>
                <input
                  ref={file}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  multiple
                  hidden
                  onChange={(e) => {
                    void addFiles([...(e.target.files ?? [])]);
                    e.target.value = '';
                  }}
                />
                {refs.length ? (
                  <label className="cs-check">
                    <input
                      type="checkbox"
                      checked={sure}
                      aria-describedby={error?.group === 'references' ? 'im-err-references' : undefined}
                      onChange={(e) => {
                        setSure(e.target.checked);
                        if (error?.group === 'references') setError(null);
                      }}
                    />
                    <span>{ATTEST}</span>
                  </label>
                ) : null}
                {err('references')}
              </div>

              <div className="im-make">
                <Button
                  kind="primary"
                  size="lg"
                  icon="studio"
                  busy={busy}
                  disabled={needsOk || uploading > 0}
                  onClick={() => void make()}
                >
                  Make {plural(form.count, 'image', 'images')}
                </Button>
                <span className="body-sm muted">
                  {needsOk
                    ? 'Check the box above to use the references.'
                    : `${aspect?.name ?? form.aspect} · ${form.quality === 'draft' ? 'Draft' : 'Final'} on ${where}`}
                </span>
              </div>
              {err('make')}
            </section>

            <section className="im-gallery" aria-labelledby="im-gal-h">
              <h2 id="im-gal-h" className="sr">
                Your images
              </h2>
              {images.length ? (
                <ul className="im-grid">
                  {images.map((s) => (
                    <li key={s.id}>
                      <Card
                        still={s}
                        onOpen={() => setOpen(s.id)}
                        onEdit={() => void edit(s)}
                        onFrame={() => void startFrame(s)}
                      />
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="hg-empty im-empty">
                  <Icon name="image" size={24} />
                  <b>No images yet</b>
                  <span className="body-sm muted" style={{ maxWidth: 420 }}>
                    Describe one and make it. Add an image of your own as a reference to change it instead.
                  </span>
                </div>
              )}
            </section>
          </div>
        </div>
      </main>
      {opened ? (
        <Lightbox
          still={opened}
          compact={compact}
          onClose={() => setOpen(null)}
          onEdit={() => void edit(opened)}
          onFrame={() => void startFrame(opened)}
        />
      ) : null}
      {sheet === 'rig' ? (
        <RigSheet
          open
          onClose={() => setSheet(null)}
          catalog={catalog}
          draft={sheetDraft}
          variant={compact ? 'bottom' : 'center'}
          onApply={(rig, a) => patch({ rig, aspect: a })}
        />
      ) : null}
      {sheet === 'look' ? (
        <LookSheet
          open
          onClose={() => setSheet(null)}
          catalog={catalog}
          draft={sheetDraft}
          variant={compact ? 'bottom' : 'center'}
          onApply={(look) => patch({ look })}
        />
      ) : null}
    </>
  );
}

/** Drop an image: stop it first if it is still being drawn. */
async function discard(s: Still) {
  if (!window.confirm('Delete this image? It can’t be brought back.')) return;
  try {
    if (isLive(s)) await api.cancelStill(s.id);
    await api.deleteStill(s.id);
    upsert({ type: 'removed', kind: 'still', id: s.id });
  } catch (e) {
    toastError(e);
  }
}
async function retry(s: Still) {
  try {
    upsert({ type: 'still', still: await api.retryStill(s.id) });
  } catch (e) {
    toastError(e);
  }
}
async function stop(s: Still) {
  try {
    upsert({ type: 'still', still: await api.cancelStill(s.id) });
  } catch (e) {
    toastError(e);
  }
}

const cut = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text);

/**
 * The live preview of a still being drawn. The server makes a new frame at every step, and asking for each one as it
 * is announced can bury the browser in requests: this asks for the newest only once the last one has arrived.
 */
function Preview({ id, version }: { id: string; version: number }) {
  const [shown, setShown] = useState(version);
  const loading = useRef(true);
  // A frame announced while none is on its way is asked for at once.
  useEffect(() => {
    if (!loading.current && version !== shown) {
      loading.current = true;
      setShown(version);
    }
  }, [version, shown]);
  const settled = () => {
    loading.current = false;
    if (version !== shown) {
      loading.current = true;
      setShown(version);
    }
  };
  return (
    <img
      src={`/api/stills/${id}/preview?v=${shown}`}
      alt=""
      decoding="async"
      onLoad={settled}
      onError={settled}
    />
  );
}

function Card({
  still: s,
  onOpen,
  onEdit,
  onFrame,
}: {
  still: Still;
  onOpen: () => void;
  onEdit: () => void;
  onFrame: () => void;
}) {
  const running = s.status === 'running';
  const failed = s.status === 'failed' || s.status === 'canceled';
  const label = `Image: ${cut(s.prompt, 80)}`;
  return (
    <figure className={`im-card${failed ? ' is-dim' : ''}`} data-status={s.status}>
      <button
        type="button"
        className="im-card__img"
        style={{ aspectRatio: `${s.width} / ${s.height}` }}
        aria-label={s.status === 'done' ? `Open. ${label}` : label}
        disabled={s.status !== 'done'}
        onClick={onOpen}
      >
        {s.image ? (
          <img src={s.image} alt="" loading="lazy" decoding="async" />
        ) : running && s.previewVersion ? (
          <Preview id={s.id} version={s.previewVersion} />
        ) : null}
        {isLive(s) ? (
          <span className="cs-live">
            <LiveRing value={running ? (s.progress?.value ?? null) : null} size={40} />
          </span>
        ) : null}
      </button>
      <figcaption>
        <span className="im-card__p" title={s.prompt}>
          {cut(s.prompt, 90)}
        </span>
        <span className="im-card__bar">
          {s.status === 'queued' ? (
            <Status kind="queued">
              {s.queuePosition ? `Waiting · ${s.queuePosition} ahead` : 'Waiting'}
            </Status>
          ) : running ? (
            <Status kind="running">
              Drawing{s.progress?.steps ? ` · ${s.progress.step ?? 0} of ${s.progress.steps}` : ''}
            </Status>
          ) : failed ? (
            <span className="body-sm hg-err im-card__err" title={s.error?.message}>
              {s.status === 'canceled' ? 'Stopped' : (s.error?.message ?? 'Failed')}
            </span>
          ) : (
            <span className="body-sm muted num">
              {s.aspect ?? `${s.width}×${s.height}`} · {s.quality === 'final' ? 'Final' : 'Draft'}
            </span>
          )}
        </span>
        <span className="im-card__acts">
          {s.status === 'done' ? (
            <>
              <a
                className="hg-btn hg-btn--sm hg-btn--icon hg-btn--ghost"
                href={s.image ?? undefined}
                download={`hildegard-${s.id}.png`}
                aria-label="Download"
                title="Download"
              >
                <Icon name="download" size={16} />
              </a>
              <Button size="sm" kind="ghost" icon="pen" aria-label="Edit" title="Edit" onClick={onEdit} />
              <Button
                size="sm"
                kind="ghost"
                icon="film"
                aria-label="Use as start frame"
                title="Use as start frame"
                onClick={onFrame}
              />
            </>
          ) : null}
          {failed ? (
            <Button
              size="sm"
              kind="ghost"
              icon="retake"
              aria-label="Retry"
              title="Retry"
              onClick={() => void retry(s)}
            />
          ) : null}
          {isLive(s) ? (
            <Button
              size="sm"
              kind="ghost"
              icon="close"
              aria-label="Stop"
              title="Stop"
              onClick={() => void stop(s)}
            />
          ) : (
            <Button
              size="sm"
              kind="ghost"
              icon="trash"
              aria-label="Delete"
              title="Delete"
              onClick={() => void discard(s)}
            />
          )}
        </span>
      </figcaption>
    </figure>
  );
}

function Lightbox({
  still: s,
  compact,
  onClose,
  onEdit,
  onFrame,
}: {
  still: Still;
  compact: boolean;
  onClose: () => void;
  onEdit: () => void;
  onFrame: () => void;
}) {
  return (
    <Modal
      open
      onClose={onClose}
      labelledBy="im-lb-t"
      variant={compact ? 'bottom' : 'center'}
      className="im-lightbox"
    >
      <div className="cs-sheet__h">
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 id="im-lb-t">Image</h2>
        </div>
        <button
          type="button"
          className="hg-btn hg-btn--icon hg-btn--ghost"
          aria-label="Close"
          data-autofocus=""
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="im-lightbox__b">
        <div className="im-lightbox__img">
          {s.image ? <img src={s.image} alt={cut(s.prompt, 140)} /> : null}
        </div>
        <div className="im-lightbox__side">
          <p className="im-lightbox__prompt">{s.prompt}</p>
          <dl className="hg-kv">
            <dt>Seed</dt>
            <dd className="num">{s.seed}</dd>
            <dt>Size</dt>
            <dd className="num">
              {s.width} × {s.height}
            </dd>
            {s.aspect ? (
              <>
                <dt>Shape</dt>
                <dd className="num">{s.aspect}</dd>
              </>
            ) : null}
            {s.quality ? (
              <>
                <dt>Quality</dt>
                <dd>{s.quality === 'final' ? 'Final' : 'Draft'}</dd>
              </>
            ) : null}
            {s.summary ? (
              <>
                <dt>Camera</dt>
                <dd>{s.summary}</dd>
              </>
            ) : null}
            {s.references.length ? (
              <>
                <dt>From</dt>
                <dd>{plural(s.references.length, 'reference image', 'reference images')}</dd>
              </>
            ) : null}
          </dl>
          <div className="im-lightbox__acts">
            <a
              className="hg-btn hg-btn--primary"
              href={s.image ?? undefined}
              download={`hildegard-${s.id}.png`}
            >
              <Icon name="download" size={18} />
              Download
            </a>
            <Button icon="pen" onClick={onEdit}>
              Edit
            </Button>
            <Button icon="film" onClick={onFrame}>
              Use as start frame
            </Button>
            <Button
              kind="ghost"
              icon="trash"
              onClick={async () => {
                await discard(s);
              }}
            >
              Delete
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
