// SPDX-License-Identifier: AGPL-3.0-only
/** Pieces every Voice page shares: orbs, kind badges, play buttons, waveforms, models and the drop zone. */
import type { Voice, VoiceModel, VoiceModelState } from '@hildegard/presets';
import { type ReactNode, useId, useRef, useState } from 'react';
import { type AudioUpload, api, type VoiceLicense } from '../lib/api.ts';
import { bytes, clock } from '../lib/format.ts';
import { KIND_LABEL, seek, toggle, usePeaks, usePlayer } from '../lib/voice.ts';
import { Button, Icon, Modal, SheetHead, toastError } from './ui.tsx';

/** A voice's orb: the same colour wherever the voice shows. */
export function Orb({ hue, size = 32 }: { hue: number; size?: number }) {
  return (
    <span
      className="st-orb"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        background: `radial-gradient(circle at 32% 30%, oklch(0.86 0.07 ${hue}), oklch(0.46 0.1 ${hue}) 70%)`,
      }}
    />
  );
}

export function Kind({ voice }: { voice: Voice }) {
  const cls = voice.kind === 'designed' ? 'design' : voice.kind === 'clone' ? 'clone' : '';
  return (
    <span className={`st-kind ${cls}`.trim()}>
      {voice.kind === 'clone' && voice.consent?.status !== 'active'
        ? voice.consent?.status === 'revoked'
          ? 'Revoked'
          : 'Expired'
        : KIND_LABEL[voice.kind]}
    </span>
  );
}

/** Plays or pauses a clip; one clip plays at a time across the Studio. */
export function PlayButton({
  url,
  label,
  size,
  ghost,
  onNeed,
  busy,
}: {
  url: string | null;
  label: string;
  size?: 'sm';
  ghost?: boolean;
  /** No clip yet: make one (a preview), then play it. */
  onNeed?: () => void;
  busy?: boolean;
}) {
  const p = usePlayer();
  const on = !!url && p.url === url && p.playing;
  return (
    <button
      type="button"
      className={`st-playbtn${size ? ` ${size}` : ''}${ghost ? ' ghost' : ''}`}
      aria-label={on ? `Pause ${label}` : `Play ${label}`}
      aria-busy={busy || undefined}
      disabled={busy || (!url && !onNeed)}
      onClick={() => (url ? toggle(url) : onNeed?.())}
    >
      {busy ? (
        <span className="hg-spin" aria-hidden="true" />
      ) : (
        <Icon name={on ? 'pause' : 'play'} size={size ? 16 : 18} />
      )}
    </button>
  );
}

/** A clip's waveform, read from the file. Click to jump there while it plays. */
export function Wave({
  url,
  bars = 72,
  height = 40,
}: {
  url: string | null;
  bars?: number;
  height?: number;
}) {
  const peaks = usePeaks(url, bars);
  const p = usePlayer();
  const at = url && p.url === url && p.duration ? p.time / p.duration : -1;
  const w = bars * 4;
  return (
    <svg
      className="st-wave hg-wave"
      viewBox={`0 0 ${w} ${height}`}
      preserveAspectRatio="none"
      height={height}
      aria-hidden="true"
      onClick={(e) => {
        if (!url || p.url !== url || !p.duration) return;
        const r = e.currentTarget.getBoundingClientRect();
        seek(((e.clientX - r.left) / r.width) * p.duration);
      }}
    >
      {Array.from({ length: bars }, (_, i) => {
        const v = peaks ? Math.max(0.06, peaks[i] ?? 0) : 0.08;
        const h = v * (height - 4) + 2;
        return (
          <rect
            // biome-ignore lint/suspicious/noArrayIndexKey: bars are positions, never reordered.
            key={i}
            x={i * 4 + 1}
            y={(height - h) / 2}
            width={2}
            height={h}
            rx={1}
            className={at >= 0 && i / bars <= at ? 'on' : undefined}
          />
        );
      })}
    </svg>
  );
}

/** A clip with its play button, waveform and length. */
export function Clip({ url, label, seconds }: { url: string; label: string; seconds?: number | null }) {
  return (
    <div className="hg-clip">
      <PlayButton url={url} label={label} />
      <Wave url={url} />
      {seconds ? <span className="num body-sm muted">{clock(seconds)}</span> : null}
    </div>
  );
}

/** Drop a recording, or choose one: it uploads, and the page gets its name. */
export function DropAudio({
  onUploaded,
  onFile,
  label = 'Drop a recording here, or choose one',
  sub = 'WAV, MP3, M4A, OGG, FLAC or WebM, up to 200 MB.',
  compact,
}: {
  onUploaded?: (u: AudioUpload, file: File) => void | Promise<void>;
  /** Take the file itself, instead of uploading it as a recording to work on. */
  onFile?: (file: File) => Promise<void>;
  label?: string;
  sub?: string;
  compact?: boolean;
}) {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const take = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try {
      if (onFile) await onFile(f);
      else await onUploaded?.(await api.uploadAudio(f), f);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <label
      htmlFor={id}
      className={`hg-drop${over ? ' over' : ''}${compact ? ' compact' : ''}`}
      aria-busy={busy || undefined}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void take(e.dataTransfer.files[0]);
      }}
    >
      <input
        ref={input}
        id={id}
        type="file"
        accept="audio/*,video/mp4,video/quicktime,.wav,.mp3,.m4a,.ogg,.flac,.webm"
        className="sr"
        onChange={(e) => void take(e.target.files?.[0])}
      />
      {busy ? (
        <span className="hg-spin" aria-hidden="true" />
      ) : (
        <Icon name="upload" size={compact ? 18 : 24} />
      )}
      <span>
        <b>{busy ? 'Uploading…' : label}</b>
        {compact ? null : <small>{sub}</small>}
      </span>
    </label>
  );
}

/** A voice model: what it does, its license and size, and getting it. */
export function VoiceModelRow({
  model,
  state,
  all,
}: {
  model: VoiceModel;
  state: VoiceModelState | undefined;
  all: readonly VoiceModel[];
}) {
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const dl = state?.downloading;
  const install = async (accept = false) => {
    // The license comes first, once per model and license version.
    if (!state?.licenseAccepted && !accept) {
      setAsking(true);
      return;
    }
    setBusy(true);
    try {
      await api.installVoiceModel(model.id, accept);
      setAsking(false);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="st-tile hg-model">
      <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <b className="hg-model__name">{model.name}</b>
          {state?.installed ? <span className="cs-fit ok">Installed</span> : null}
          {state?.fit === 'good' ? <span className="cs-fit ok">Fits this computer</span> : null}
          {state?.fit === 'slow' ? <span className="cs-fit muted">Runs slowly here</span> : null}
          {state?.fit === 'no' ? <span className="cs-fit no">Too big for this computer</span> : null}
        </div>
        <span className="body-sm sec-text">{model.blurb}</span>
        <span className="body-sm muted">
          {model.license} · {model.minVramGb ? `a ${model.minVramGb} GB GPU or more` : 'runs on any computer'}
        </span>
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
        {state?.installed ? null : dl ? (
          <Button size="sm" kind="ghost" onClick={() => api.cancelVoiceModel(model.id).catch(toastError)}>
            Stop
          </Button>
        ) : (
          <Button size="sm" kind="primary" icon="download" onClick={() => install()} busy={busy}>
            {state?.error ? 'Try again' : `Get · ${bytes(state?.missingBytes ?? 0)}`}
          </Button>
        )}
      </div>
      {asking ? (
        <VoiceLicenseDialog
          model={model}
          license={licenseOf(model, all)}
          size={state?.missingBytes ?? 0}
          busy={busy}
          onAccept={() => install(true)}
          onClose={() => setAsking(false)}
        />
      ) : null}
    </div>
  );
}

/** A model that clones brings the transcriber, which checks consent; its license is shown with the model's. */
function licenseOf(m: VoiceModel, all: readonly VoiceModel[]): VoiceLicense {
  const t = all.find((x) => x.id === 'whisper-small');
  return {
    license: m.license,
    licenseUrl: m.licenseUrl,
    terms: m.terms,
    also: m.can.includes('clone') && t && t.id !== m.id ? [t] : [],
  };
}

function VoiceLicenseDialog({
  model,
  license,
  size,
  busy,
  onAccept,
  onClose,
}: {
  model: VoiceModel;
  license: VoiceLicense;
  size: number;
  busy: boolean;
  onAccept: () => void;
  onClose: () => void;
}) {
  const id = `vlic-${model.id}`;
  return (
    <Modal open onClose={onClose} labelledBy={id} variant="dialog" className="st-dialog hg-license">
      <div className="st-dialog__h">
        <div style={{ flex: 1 }}>
          <h2 id={id}>
            {model.name} comes under the {license.license}
          </h2>
          <p>You become its licensee when you download it. In short:</p>
        </div>
      </div>
      <div className="st-dialog__b">
        <ul className="hg-terms">
          {license.terms.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
        {license.also.length ? (
          <p className="body-sm sec-text">
            It brings{' '}
            {license.also.map((a, i) => (
              <span key={a.id}>
                {i ? ' and ' : ''}
                {a.name} (
                <a href={a.licenseUrl} target="_blank" rel="noreferrer noopener">
                  {a.license}
                </a>
                )
              </span>
            ))}{' '}
            too, which cloning needs to check consent. Accepting covers those as well.
          </p>
        ) : null}
        <p className="body-sm">
          <a href={license.licenseUrl} target="_blank" rel="noreferrer noopener">
            Read the full {license.license}
          </a>
          . This summary is not legal advice; the license text is what counts.
        </p>
      </div>
      <div className="st-dialog__f">
        <Button kind="ghost" onClick={onClose} style={{ marginRight: 'auto' }} data-autofocus="">
          Not now
        </Button>
        <Button kind="primary" icon="download" onClick={onAccept} busy={busy}>
          Accept and download{size ? ` · ${bytes(size)}` : ''}
        </Button>
      </div>
    </Modal>
  );
}

export function VoiceModelsSheet({
  open,
  onClose,
  models,
  states,
  sub,
}: {
  open: boolean;
  onClose: () => void;
  models: readonly VoiceModel[];
  states: readonly VoiceModelState[];
  sub?: ReactNode;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy="vmodels-t"
      variant="dialog"
      className="cs-sheet hg-sheet--md"
    >
      <SheetHead
        id="vmodels-t"
        title="Voice models"
        sub={sub ?? 'Open models that run on your own computer. Nothing you say or make leaves it.'}
        onClose={onClose}
      />
      <div className="hg-sheet__body" style={{ gap: 10 }}>
        {models.map((m) => (
          <VoiceModelRow key={m.id} model={m} all={models} state={states.find((s) => s.id === m.id)} />
        ))}
      </div>
    </Modal>
  );
}

/** Ask for a name, in a dialog: renaming or keeping a voice. */
export function AskName({
  title,
  sub,
  initial,
  action,
  onSubmit,
  onClose,
}: {
  title: string;
  sub?: string;
  initial: string;
  action: string;
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const id = useId();
  return (
    <Modal open onClose={onClose} labelledBy={id} variant="dialog" className="st-dialog hg-ask">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          setBusy(true);
          try {
            await onSubmit(name.trim());
          } catch (err) {
            toastError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="st-dialog__h">
          <div style={{ flex: 1 }}>
            <h2 id={id}>{title}</h2>
            {sub ? <p>{sub}</p> : null}
          </div>
        </div>
        <div className="st-dialog__b">
          <label className="hg-field--block hg-field">
            Name
            <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} data-autofocus="" />
          </label>
        </div>
        <div className="st-dialog__f">
          <Button kind="ghost" onClick={onClose} style={{ marginRight: 'auto' }}>
            Cancel
          </Button>
          <Button kind="primary" type="submit" busy={busy} disabled={!name.trim()}>
            {action}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Are you sure, for something that can't be undone. */
export function Confirm({
  title,
  body,
  action,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  action: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const id = useId();
  return (
    <Modal open onClose={onClose} labelledBy={id} variant="dialog" className="st-dialog">
      <div className="st-dialog__h">
        <div style={{ flex: 1 }}>
          <h2 id={id}>{title}</h2>
          <p>{body}</p>
        </div>
      </div>
      <div className="st-dialog__f">
        <Button kind="ghost" onClick={onClose} style={{ marginRight: 'auto' }} data-autofocus="">
          Cancel
        </Button>
        <Button
          kind="danger"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
            } catch (e) {
              toastError(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          {action}
        </Button>
      </div>
    </Modal>
  );
}
