// SPDX-License-Identifier: AGPL-3.0-only
import type { Catalog, Model, ModelState } from '@hildegard/presets';
import { useMemo, useState } from 'react';
import { api } from '../lib/api.ts';
import { type Draft, setDraft } from '../lib/draft.ts';
import { bytes, videoModels } from '../lib/format.ts';
import { useStore } from '../lib/store.ts';
import { Button, Icon, Modal, RadioGroup, Segmented, SheetHead, Slider, toastError } from './ui.tsx';

type Variant = 'center' | 'side' | 'bottom';
interface SheetProps {
  open: boolean;
  onClose: () => void;
  catalog: Catalog;
  draft: Draft;
  variant: Variant;
}

/** Stand-in art for a preset until sample frames ship: the preset's own colours and glyph, never a fake photo. */
function Plate({
  hue,
  glyph,
  colors,
  light,
}: {
  hue: number;
  glyph?: string;
  colors?: string[];
  light?: string;
}) {
  return (
    <span
      className={`hg-plate${light ? ' hg-plate--light' : ''}`}
      style={(light ? { background: light } : { '--h': hue }) as React.CSSProperties}
      aria-hidden="true"
    >
      {light ? null : colors ? (
        <span className="hg-plate__sw">
          {colors.map((c) => (
            <i key={c} style={{ background: c }} />
          ))}
        </span>
      ) : (
        <Icon name={glyph ?? 'sparkle'} size={24} />
      )}
    </span>
  );
}
const hashHue = (id: string) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
/** Each camera body and lens gets a ground in the hue of the film it evokes; anything new falls back to a hash. */
const HUES: Record<string, number> = {
  'full-frame': 250,
  'large-format': 200,
  'vintage-16mm': 60,
  'super-35': 150,
  documentary: 230,
  'super-8': 35,
  'dv-camcorder': 185,
  clean: 255,
  anamorphic: 280,
  macro: 120,
  swirl: 320,
  diffusion: 75,
};
const hueOf = (id: string) => HUES[id] ?? hashHue(id);
/** A small picture of each lighting: where the light falls, its colour, and how deep the shadows go. */
const LIGHTS: Record<string, string> = {
  'golden-hour':
    'radial-gradient(70% 90% at 82% 78%, oklch(.84 .14 75), oklch(.58 .12 55) 38%, oklch(.26 .06 35) 85%)',
  'soft-mist':
    'radial-gradient(130% 110% at 50% 25%, oklch(.82 .02 220), oklch(.62 .025 225) 55%, oklch(.46 .02 235))',
  'hard-practical':
    'radial-gradient(26% 40% at 30% 38%, oklch(.9 .1 80), oklch(.55 .1 60) 45%, transparent 70%), oklch(.13 .02 260)',
  'even-daylight': 'linear-gradient(180deg, oklch(.84 .04 230), oklch(.66 .035 220) 60%, oklch(.56 .03 140))',
  'night-neon':
    'radial-gradient(55% 75% at 18% 85%, oklch(.62 .21 345), transparent 70%), radial-gradient(50% 70% at 86% 18%, oklch(.68 .14 200), transparent 70%), oklch(.14 .04 285)',
  candlelight:
    'radial-gradient(34% 55% at 50% 72%, oklch(.86 .15 70), oklch(.55 .14 45) 40%, transparent 75%), oklch(.12 .03 40)',
};

function Check() {
  return (
    <span className="chk">
      <Icon name="check" size={16} />
    </span>
  );
}

// ── Camera rig ────────────────────────────────────────────────────────────────────────────────────────────────
export function RigSheet({ open, onClose, catalog, draft, variant }: SheetProps) {
  const [rig, setRig] = useState(draft.rig);
  const [aspect, setAspect] = useState(draft.format.aspect);
  const body = catalog.bodies.find((b) => b.id === rig.body);
  const lens = catalog.lenses.find((l) => l.id === rig.lens);
  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy="rig-t"
      variant={variant}
      className="cs-sheet hg-sheet--xl"
    >
      <SheetHead
        id="rig-t"
        title="Camera rig"
        sub="Rigs are presets of their own. Changing the model never breaks a look."
        onClose={onClose}
      />
      <div className="hg-sheet__body">
        <section className="cs-sec">
          <div className="cs-sec__h">
            <span className="ovl">1 · Camera body</span>
            <span className="body-sm muted">Sets grain, colour and how highlights roll off</span>
          </div>
          <RadioGroup label="Camera body" className="hg-optgrid hg-optgrid--rig">
            {catalog.bodies.map((b) => (
              <button
                key={b.id}
                type="button"
                className="cs-opt"
                role="radio"
                aria-checked={rig.body === b.id}
                tabIndex={rig.body === b.id ? 0 : -1}
                onClick={() => setRig({ ...rig, body: b.id })}
                data-autofocus={rig.body === b.id ? '' : undefined}
              >
                <Plate hue={hueOf(b.id)} glyph="camera" />
                {rig.body === b.id ? <Check /> : null}
                <b>{b.name}</b>
                <small>{b.blurb}</small>
              </button>
            ))}
          </RadioGroup>
        </section>
        <section className="cs-sec">
          <div className="cs-sec__h">
            <span className="ovl">2 · Lens</span>
            <span className="body-sm muted">How the glass draws light, flare and blur</span>
          </div>
          <RadioGroup label="Lens" className="hg-optgrid hg-optgrid--rig">
            {catalog.lenses.map((l) => (
              <button
                key={l.id}
                type="button"
                className="cs-opt"
                role="radio"
                aria-checked={rig.lens === l.id}
                tabIndex={rig.lens === l.id ? 0 : -1}
                onClick={() => {
                  setRig({ ...rig, lens: l.id });
                  // An anamorphic lens implies its own frame; any other lens returns to widescreen.
                  if (l.aspect) setAspect(l.aspect);
                  else if (lens?.aspect && aspect === lens.aspect) setAspect('16:9');
                }}
              >
                <Plate hue={hueOf(l.id)} glyph="aperture" />
                {rig.lens === l.id ? <Check /> : null}
                <b>{l.name}</b>
                <small>{l.blurb}</small>
              </button>
            ))}
          </RadioGroup>
        </section>
        <div className="hg-two">
          <section className="cs-sec">
            <div className="cs-sec__h">
              <span className="ovl">3 · Focal length</span>
              <span className="body-sm muted">Full-frame equivalent</span>
            </div>
            <RadioGroup label="Focal length" className="cs-focal">
              {catalog.focals.map((f) => (
                <button
                  key={f.mm}
                  type="button"
                  role="radio"
                  aria-checked={rig.focal === f.mm}
                  tabIndex={rig.focal === f.mm ? 0 : -1}
                  onClick={() => setRig({ ...rig, focal: f.mm })}
                >
                  <b>{f.mm}</b>
                  <small>{f.label}</small>
                </button>
              ))}
            </RadioGroup>
          </section>
          <section className="cs-sec">
            <div className="cs-sec__h">
              <span className="ovl">4 · Aperture</span>
              <span className="num" style={{ fontSize: 15 }}>
                f/{rig.aperture.toFixed(1)}
              </span>
            </div>
            <Slider
              label="Aperture"
              min={0}
              max={APERTURES.length - 1}
              step={1}
              value={Math.max(0, APERTURES.indexOf(rig.aperture))}
              valueText={`f/${rig.aperture}`}
              onChange={(i) => setRig({ ...rig, aperture: APERTURES[i]! })}
              ends={['f/1.4 · softer background', 'f/16 · more in focus']}
            />
          </section>
        </div>
      </div>
      <div className="cs-sheet__f">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="body-strong">
            {body?.name} · {lens?.name} · {rig.focal}mm · f/{rig.aperture.toFixed(1)}
          </div>
          <div className="body-sm muted">
            {aspect !== draft.format.aspect
              ? `Frame changes to ${aspect}`
              : 'Works with every installed video model'}
          </div>
        </div>
        <Button kind="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          kind="primary"
          onClick={() => {
            setDraft((d) => ({ rig, format: { ...d.format, aspect } }));
            onClose();
          }}
        >
          Use this rig
        </Button>
      </div>
    </Modal>
  );
}
export const APERTURES = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16];

// ── Camera motion ─────────────────────────────────────────────────────────────────────────────────────────────
const CATEGORIES: Record<string, string> = {
  push: 'Push & pull',
  orbit: 'Orbit & arc',
  vertical: 'Vertical',
  handheld: 'Handheld',
  time: 'Speed & time',
  reveal: 'Reveal',
  static: 'Still',
};

export function MotionSheet({ open, onClose, catalog, draft, variant }: SheetProps) {
  const [picked, setPicked] = useState(draft.motion);
  const [cat, setCat] = useState<string>('all');
  const [q, setQ] = useState('');
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const m of catalog.motions) c[m.category] = (c[m.category] ?? 0) + 1;
    return c;
  }, [catalog]);
  const shown = catalog.motions.filter(
    (m) => (cat === 'all' || m.category === cat) && (!q || m.name.toLowerCase().includes(q.toLowerCase())),
  );
  const toggle = (id: string) => {
    const i = picked.findIndex((p) => p.id === id);
    if (i >= 0) setPicked(picked.filter((p) => p.id !== id));
    else if (id === 'static') setPicked([{ id, strength: 0.8 }]);
    else setPicked([...picked.filter((p) => p.id !== 'static'), { id, strength: 0.8 }].slice(-2));
  };
  const names = picked.map((p) => catalog.motions.find((m) => m.id === p.id)?.name ?? p.id);
  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy="mo-t"
      variant={variant}
      className="cs-sheet hg-sheet--xl"
    >
      <SheetHead
        id="mo-t"
        title="Camera motion"
        sub="Pick up to two and they run together across the take."
        onClose={onClose}
      >
        <label className="hg-search">
          <Icon name="search" size={16} />
          <span className="sr">Search motions</span>
          <input
            type="search"
            value={q}
            placeholder="Search motions"
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
      </SheetHead>
      <div className="hg-sheet__chips">
        <div className="hg-chips" role="group" aria-label="Categories">
          <button
            type="button"
            className="hg-chip"
            aria-pressed={cat === 'all'}
            onClick={() => setCat('all')}
          >
            All · {catalog.motions.length}
          </button>
          {Object.entries(counts).map(([k, n]) => (
            <button
              key={k}
              type="button"
              className="hg-chip"
              aria-pressed={cat === k}
              onClick={() => setCat(k)}
            >
              {CATEGORIES[k] ?? k} · {n}
            </button>
          ))}
        </div>
      </div>
      <div className="hg-sheet__body">
        <div className="hg-motiongrid">
          {shown.map((m) => {
            const order = picked.findIndex((p) => p.id === m.id);
            return (
              <button
                key={m.id}
                type="button"
                className="cs-motion"
                role="checkbox"
                aria-checked={order >= 0}
                onClick={() => toggle(m.id)}
              >
                <span className="th">
                  <svg viewBox="0 0 160 100" aria-hidden="true">
                    <path className="path" d={m.path} />
                    <circle
                      className="cam"
                      r="4.5"
                      style={{ offsetPath: `path('${m.path}')` } as React.CSSProperties}
                    />
                  </svg>
                  {order >= 0 ? <span className="ord">{order + 1}</span> : null}
                </span>
                <b>{m.name}</b>
                <small>{CATEGORIES[m.category] ?? m.category}</small>
              </button>
            );
          })}
          {shown.length === 0 ? <p className="body-sm muted">No motion matches “{q}”.</p> : null}
        </div>
      </div>
      <div className="cs-sheet__f hg-wrap">
        <div style={{ display: 'grid', gap: 8, flex: 1, minWidth: 220 }}>
          <span className="body-strong">{picked.length ? names.join(' + ') : 'No camera move'}</span>
          {picked.length ? (
            <div className="hg-two">
              {picked.map((p, i) => (
                <Slider
                  key={p.id}
                  label={`${names[i]} strength`}
                  min={0.1}
                  max={1}
                  step={0.1}
                  value={p.strength}
                  valueText={p.strength.toFixed(1)}
                  onChange={(v) => setPicked(picked.map((x) => (x.id === p.id ? { ...x, strength: v } : x)))}
                  head={
                    <div className="hg-range__head">
                      <span>
                        <span className="num" style={{ color: 'var(--brand-text)' }}>
                          {i + 1}
                        </span>{' '}
                        {names[i]}
                      </span>
                      <span className="num">{p.strength.toFixed(1)}</span>
                    </div>
                  }
                />
              ))}
            </div>
          ) : (
            <span className="body-sm muted">The camera holds steady. Pick a move to direct it.</span>
          )}
        </div>
        <Button kind="ghost" onClick={() => setPicked([])} disabled={!picked.length}>
          Clear
        </Button>
        <Button
          kind="primary"
          onClick={() => {
            setDraft({ motion: picked });
            onClose();
          }}
        >
          Use motion
        </Button>
      </div>
    </Modal>
  );
}

// ── Look ──────────────────────────────────────────────────────────────────────────────────────────────────────
export function LookSheet({ open, onClose, catalog, draft, variant }: SheetProps) {
  const [look, setLook] = useState(draft.look);
  const pick = <K extends keyof Draft['look']>(k: K, v: string) =>
    setLook({ ...look, [k]: look[k] === v ? undefined : v });
  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy="look-t"
      variant={variant === 'center' ? 'side' : variant}
      className="cs-sheet"
    >
      <SheetHead
        id="look-t"
        title="Look"
        sub="Lighting, colour and period for the shots you make next. Seeds stay put, so only the look changes."
        onClose={onClose}
      />
      <div className="hg-sheet__body">
        <section className="cs-sec">
          <span className="ovl">Genre</span>
          <RadioGroup label="Genre" className="hg-chips">
            {catalog.genres.map((g) => (
              <button
                key={g.id}
                type="button"
                className="hg-chip"
                role="radio"
                aria-checked={look.genre === g.id}
                tabIndex={look.genre === g.id || (!look.genre && g === catalog.genres[0]) ? 0 : -1}
                onClick={() => pick('genre', g.id)}
              >
                {g.name}
              </button>
            ))}
          </RadioGroup>
        </section>
        <section className="cs-sec">
          <span className="ovl">Era</span>
          <RadioGroup label="Era" className="cs-seg">
            {catalog.eras.map((e) => (
              <button
                key={e.id}
                type="button"
                role="radio"
                aria-checked={look.era === e.id}
                tabIndex={look.era === e.id || (!look.era && e === catalog.eras[0]) ? 0 : -1}
                onClick={() => pick('era', e.id)}
              >
                {e.name}
              </button>
            ))}
          </RadioGroup>
        </section>
        <section className="cs-sec">
          <span className="ovl">Lighting</span>
          <RadioGroup label="Lighting" className="hg-optgrid hg-optgrid--sm">
            {catalog.lightings.map((l) => (
              <button
                key={l.id}
                type="button"
                className="cs-opt"
                role="radio"
                aria-checked={look.lighting === l.id}
                tabIndex={look.lighting === l.id || (!look.lighting && l === catalog.lightings[0]) ? 0 : -1}
                onClick={() => pick('lighting', l.id)}
              >
                <Plate hue={hueOf(l.id)} glyph="sun" light={LIGHTS[l.id]} />
                {look.lighting === l.id ? <Check /> : null}
                <b>{l.name}</b>
                <small>{l.blurb}</small>
              </button>
            ))}
          </RadioGroup>
        </section>
        <section className="cs-sec">
          <span className="ovl">Palette</span>
          <RadioGroup label="Palette" className="hg-palettes">
            {catalog.palettes.map((p) => (
              <button
                key={p.id}
                type="button"
                className="cs-mrow"
                role="radio"
                aria-checked={look.palette === p.id}
                tabIndex={look.palette === p.id || (!look.palette && p === catalog.palettes[0]) ? 0 : -1}
                onClick={() => pick('palette', p.id)}
              >
                <span className="rd" />
                <span style={{ flex: 1, textAlign: 'left' }}>
                  <b>{p.name}</b>
                  <small>{p.blurb}</small>
                </span>
                <span className="hg-swatches" aria-hidden="true">
                  {p.colors.map((c) => (
                    <i key={c} style={{ background: c }} />
                  ))}
                </span>
              </button>
            ))}
          </RadioGroup>
        </section>
      </div>
      <div className="cs-sheet__f hg-wrap">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="body-strong">{lookSummary(catalog, look) || 'No look set'}</div>
          <div className="body-sm muted">
            Choose again to clear a choice. Takes already made keep their look.
          </div>
        </div>
        <Button kind="ghost" onClick={() => setLook({})} disabled={!Object.values(look).some(Boolean)}>
          Clear all
        </Button>
        <Button
          kind="primary"
          onClick={() => {
            setDraft({ look });
            onClose();
          }}
        >
          Use this look
        </Button>
      </div>
    </Modal>
  );
}

export function lookSummary(c: Catalog, look: Draft['look']): string {
  return [
    c.lightings.find((x) => x.id === look.lighting)?.name,
    c.palettes.find((x) => x.id === look.palette)?.name,
    c.genres.find((x) => x.id === look.genre)?.name,
    c.eras.find((x) => x.id === look.era)?.name,
  ]
    .filter(Boolean)
    .join(' · ');
}

// ── Format: frame, length, quality, takes, seed ──────────────────────────────────────────────────────────────
export function FormatSheet({
  open,
  onClose,
  catalog,
  draft,
  variant,
  maxSeconds,
}: SheetProps & { maxSeconds: number }) {
  const [f, setF] = useState(draft.format);
  const [takes, setTakes] = useState(draft.takes);
  const [seed, setSeed] = useState<number | null>(draft.seed);
  const [seedText, setSeedText] = useState(draft.seed === null ? '' : String(draft.seed));
  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy="fmt-t"
      variant={variant === 'center' ? 'dialog' : variant}
      className="cs-sheet hg-sheet--md"
    >
      <SheetHead
        id="fmt-t"
        title="Format"
        sub="Frame, length and quality for the next shot."
        onClose={onClose}
      />
      <div className="hg-sheet__body hg-rows">
        <div className="row">
          <span className="k">Frame</span>
          <Segmented
            className="cs-seg"
            label="Aspect ratio"
            value={f.aspect}
            onChange={(aspect) => setF({ ...f, aspect })}
            options={catalog.aspects.map((a) => ({ value: a.id, label: a.id }))}
          />
        </div>
        <div className="row">
          <span className="k">Length</span>
          <Segmented
            className="cs-seg"
            label="Length in seconds"
            value={Math.min(f.seconds, maxSeconds)}
            onChange={(seconds) => setF({ ...f, seconds })}
            options={catalog.durations.map((s) => ({ value: s, label: `${s}s`, disabled: s > maxSeconds }))}
          />
        </div>
        <div className="row">
          <span className="k">Quality</span>
          <Segmented
            className="cs-seg"
            label="Quality"
            value={f.quality}
            onChange={(quality) => setF({ ...f, quality })}
            options={[
              { value: 'draft', label: 'Draft · fast' },
              { value: 'final', label: 'Final · full quality' },
            ]}
          />
        </div>
        <div className="row">
          <span className="k">Takes</span>
          <div className="cs-step" style={{ width: 140 }}>
            <button
              type="button"
              aria-label="Fewer takes"
              disabled={takes <= 1}
              onClick={() => setTakes(takes - 1)}
            >
              −
            </button>
            <span className="num" aria-live="polite">
              {takes}
            </span>
            <button
              type="button"
              aria-label="More takes"
              disabled={takes >= 4}
              onClick={() => setTakes(takes + 1)}
            >
              +
            </button>
          </div>
        </div>
        <div className="row">
          <span className="k">Seed</span>
          <label className="hg-field">
            <span className="sr">Seed number</span>
            <input
              inputMode="numeric"
              value={seedText}
              placeholder="Random"
              onChange={(e) => {
                const t = e.target.value.replace(/\D/g, '').slice(0, 10);
                setSeedText(t);
                setSeed(t ? Math.min(Number(t), 2 ** 32 - 1) : null);
              }}
            />
          </label>
          <button
            type="button"
            className="cs-lock"
            aria-pressed={seed !== null}
            aria-label={seed !== null ? 'Seed locked; unlock for a fresh seed each time' : 'Lock a seed'}
            onClick={() => {
              if (seed !== null) {
                setSeed(null);
                setSeedText('');
              } else {
                const s = Math.floor(Math.random() * 100000);
                setSeed(s);
                setSeedText(String(s));
              }
            }}
          >
            <Icon name={seed !== null ? 'lock' : 'unlock'} size={18} />
          </button>
        </div>
        <p className="body-sm muted">
          Draft renders fast at a lower size so you can choose; finalize the one you like at full quality with
          the same seed.
        </p>
      </div>
      <div className="cs-sheet__f">
        <span style={{ flex: 1 }} />
        <Button kind="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          kind="primary"
          onClick={() => {
            setDraft({ format: { ...f, seconds: Math.min(f.seconds, maxSeconds) }, takes, seed });
            onClose();
          }}
        >
          Done
        </Button>
      </div>
    </Modal>
  );
}

// ── Model ─────────────────────────────────────────────────────────────────────────────────────────────────────
export function ModelSheet({
  open,
  onClose,
  catalog,
  draft,
  variant,
  go,
}: SheetProps & { go: (to: string) => void }) {
  const models = useStore((s) => s.models);
  const hf = useStore((s) => s.hf);
  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy="model-t"
      variant={variant === 'center' ? 'dialog' : variant}
      className="cs-sheet hg-sheet--md"
    >
      <SheetHead
        id="model-t"
        title="Video model"
        sub="Open models that run on your own GPU. Nothing you make leaves this computer."
        onClose={onClose}
      />
      <div className="hg-sheet__body" style={{ gap: 10 }}>
        {videoModels(catalog).map((m) => {
          const st = models.find((x) => x.id === m.id);
          const chosen = (draft.model ?? '') === m.id;
          return (
            <ModelRow
              key={m.id}
              model={m}
              detail={`${m.license} · ${m.minVramGb} GB GPU or more`}
              state={st}
              chosen={chosen}
              needsLink={m.gated && !hf?.linked}
              onChoose={() => {
                setDraft({ model: m.id });
                onClose();
              }}
              onLink={() => {
                onClose();
                go('/settings/huggingface');
              }}
            />
          );
        })}
      </div>
    </Modal>
  );
}

export function ModelRow({
  model,
  detail,
  state,
  chosen,
  needsLink,
  onChoose,
  onLink,
}: {
  model: Model;
  detail: string;
  state: ModelState | undefined;
  chosen?: boolean;
  needsLink: boolean;
  onChoose?: () => void;
  onLink: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [askingBig, setAskingBig] = useState(false);
  const dl = state?.downloading;
  const { name, blurb } = model;
  const tooBig = state?.fit === 'no';
  const apple = state?.fitWhy === 'apple-gpu';
  const install = async (acceptLicense = false, big = false) => {
    if (!state) return;
    // A model this computer can't run is a big download for nothing, unless they mean to; ask first.
    if (tooBig && !big && !acceptLicense) {
      setAskingBig(true);
      return;
    }
    setAskingBig(false);
    // The license comes first, once per model and license version.
    if (!state.licenseAccepted && !acceptLicense) {
      setAsking(true);
      return;
    }
    setBusy(true);
    try {
      await api.installModel(state.id, acceptLicense);
      setAsking(false);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="st-tile hg-model" aria-current={chosen ? 'true' : undefined}>
      <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <b className="hg-model__name">{name}</b>
          {state?.installed ? <span className="cs-fit ok">Installed</span> : null}
          {chosen ? <span className="cs-fit ok">In use</span> : null}
          {state?.fit === 'fits' ? <span className="cs-fit ok">Fits this computer</span> : null}
          {state?.fit === 'tight' ? (
            <span className="cs-fit muted">Tight on this computer, slower</span>
          ) : null}
          {state?.fit === 'no' ? (
            <span className="cs-fit no">
              {apple ? 'Doesn’t render on this Mac yet' : 'Too big for this computer'}
            </span>
          ) : null}
        </div>
        <span className="body-sm sec-text">{blurb}</span>
        <span className="body-sm muted">{detail}</span>
        {dl ? (
          <div style={{ display: 'grid', gap: 6, marginTop: 4 }}>
            <div className="st-bar">
              <i style={{ width: `${(dl.done / Math.max(1, dl.total)) * 100}%` }} />
            </div>
            <span className="body-sm muted num">
              {bytes(dl.done)} of {bytes(dl.total)}
              {dl.bytesPerSec ? ` · ${bytes(dl.bytesPerSec)}/s` : ''} · {dl.file}
            </span>
          </div>
        ) : null}
        {state?.error ? (
          <span className="body-sm hg-err" role="alert">
            <Icon name="alert" size={16} /> {state.error}
          </span>
        ) : null}
      </div>
      <div className="hg-model__act">
        {state?.installed ? (
          onChoose ? (
            <Button kind={chosen ? undefined : 'primary'} size="sm" onClick={onChoose} disabled={chosen}>
              {chosen ? 'In use' : 'Use'}
            </Button>
          ) : null
        ) : dl ? (
          <Button size="sm" kind="ghost" onClick={() => api.cancelModel(state!.id).catch(toastError)}>
            Stop
          </Button>
        ) : needsLink ? (
          <Button size="sm" icon="link" onClick={onLink}>
            Link Hugging Face
          </Button>
        ) : (
          <Button
            size="sm"
            kind={tooBig ? undefined : 'primary'}
            icon="download"
            onClick={() => install()}
            busy={busy}
          >
            {state?.error ? 'Try again' : `Get · ${bytes(state?.missingBytes ?? 0)}`}
          </Button>
        )}
      </div>
      {askingBig ? (
        <Modal
          open
          onClose={() => setAskingBig(false)}
          labelledBy={`big-${model.id}`}
          variant="dialog"
          className="st-dialog"
        >
          <div className="st-dialog__h">
            <div style={{ flex: 1 }}>
              <h2 id={`big-${model.id}`}>
                {apple
                  ? `${name} doesn’t render on this Mac yet`
                  : `${name} is too big to render on this computer`}
              </h2>
              <p>
                {apple
                  ? 'On Apple’s GPU its takes come out blurred and take over an hour, so Hildegard doesn’t render it here yet. To use it, install it on a paired device with an NVIDIA or AMD GPU and render there.'
                  : 'It needs more GPU memory than this computer has, so takes would fail here. To use it, install it on a paired device with a bigger GPU and render there.'}
              </p>
            </div>
          </div>
          <div className="st-dialog__f">
            <Button kind="primary" onClick={() => setAskingBig(false)} data-autofocus="">
              Not now
            </Button>
            <Button kind="ghost" icon="download" onClick={() => install(false, true)} busy={busy}>
              Download anyway · {bytes(state?.missingBytes ?? 0)}
            </Button>
          </div>
        </Modal>
      ) : null}
      {asking ? (
        <LicenseDialog
          model={model}
          size={state?.missingBytes ?? 0}
          busy={busy}
          onAccept={() => install(true)}
          onClose={() => setAsking(false)}
        />
      ) : null}
    </div>
  );
}

/** Shown before a model's first download: its license, in plain words, with a link to the full text. */
export function LicenseDialog({
  model,
  size,
  busy,
  onAccept,
  onClose,
}: {
  model: Model;
  size: number;
  busy: boolean;
  onAccept: () => void;
  onClose: () => void;
}) {
  const id = `lic-${model.id}`;
  return (
    <Modal open onClose={onClose} labelledBy={id} variant="dialog" className="st-dialog hg-license">
      <div className="st-dialog__h">
        <div style={{ flex: 1 }}>
          <h2 id={id}>
            {model.name} comes under the {model.license}
          </h2>
          <p>You become its licensee when you download it. In short:</p>
        </div>
      </div>
      <div className="st-dialog__b">
        <ul className="hg-terms">
          {model.terms.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
        <p className="body-sm">
          <a href={model.licenseUrl} target="_blank" rel="noreferrer noopener">
            Read the full {model.license}
          </a>
          . This summary is not legal advice; the license text is what counts.
        </p>
      </div>
      <div className="st-dialog__f">
        <Button kind="ghost" onClick={onClose} style={{ marginRight: 'auto' }} data-autofocus="">
          Not now
        </Button>
        <Button kind="primary" icon="download" onClick={onAccept} busy={busy}>
          Accept and download · {bytes(size)}
        </Button>
      </div>
    </Modal>
  );
}
