// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Record in the Studio: your voice (noise suppression on) or yourself on camera, here on this computer, with nothing to
 * set up. Listen or watch back, record again, and keep it: it lands with your other recordings, the same place a record
 * link's recording does, ready to clean up and to use as a film's voice-over. "Record on your phone" shows a QR code
 * for a link to open on a phone; if Hildegard has no link of its own on yet it asks first, and turns one on only after
 * a yes. The microphone and camera start only when you tap Record.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { api, type LinkOnAnswer, type LinkPlan, type RecordingInfo } from '../lib/api.ts';
import { clock } from '../lib/format.ts';
import { useCapture } from '../lib/record.ts';
import { Qr } from './Qr.tsx';
import { Button, Icon, Modal, Segmented, toastError, WithCode } from './ui.tsx';

type Kind = 'voice' | 'video';

/** What the person is told when the link they are given is public. */
const PUBLIC_NOTE =
  'This link is public: it goes through a tunnel anyone on the internet can reach, so anyone who has Hildegard’s link can see its sign-in page (only people you invite can get in). Turn it off in Settings › Sharing when you’re done.';

type Phone =
  | { at: 'asking' }
  | { at: 'confirm'; plan: LinkPlan }
  | { at: 'turning' }
  | { at: 'missing'; answer: LinkOnAnswer }
  | { at: 'waiting'; id: string; url: string; secure: boolean; note: string | null }
  | { at: 'arrived'; recording: RecordingInfo }
  | { at: 'error'; message: string };

function Preview({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} className="hg-record-media" autoPlay muted playsInline aria-label="Your camera" />;
}

export function RecordDialog({
  kinds = ['voice', 'video'],
  onKept,
  onClose,
}: {
  /** What can be recorded here: a voice-over asks for a voice only. */
  kinds?: Kind[];
  /** A recording was kept (made here, or arrived from the phone). */
  onKept?: (r: RecordingInfo) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [kind, setKind] = useState<Kind>(kinds[0] ?? 'voice');
  const cap = useCapture(kind);
  const [busy, setBusy] = useState(false);
  const [kept, setKept] = useState<RecordingInfo | null>(null);
  const [phone, setPhone] = useState<Phone | null>(null);
  const kept_ = useRef(onKept);
  kept_.current = onKept;
  const on = cap.state === 'recording';
  const working = on || cap.state === 'asking';

  const keep = async () => {
    if (!cap.clip) return;
    setBusy(true);
    try {
      const r = await api.keepRecording(cap.clip.blob, kind);
      setKept(r);
      kept_.current?.(r);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const another = () => {
    setKept(null);
    setPhone(null);
    cap.again();
  };

  // ── The phone ────────────────────────────────────────────────────────────────────────────────────────────────
  const askPhone = async (note: string | null = null) => {
    setPhone({ at: 'asking' });
    try {
      const l = await api.phoneRecordLink(kind);
      if (l.needsLink) setPhone({ at: 'confirm', plan: l.plan });
      else
        setPhone({
          at: 'waiting',
          id: l.id,
          url: l.url,
          secure: l.secure,
          note: l.public ? [note, PUBLIC_NOTE].filter(Boolean).join(' ') : note,
        });
    } catch (e) {
      setPhone({ at: 'error', message: (e as Error).message });
    }
  };
  const turnOn = async (plan: LinkPlan) => {
    setPhone({ at: 'turning' });
    try {
      const a = await api.linkOn(plan);
      if (a.status === 'on') await askPhone(a.message);
      // The computer changed since the question was asked: ask again, for what would happen now.
      else if (a.status === 'confirm' && a.plan) setPhone({ at: 'confirm', plan: a.plan });
      else setPhone({ at: 'missing', answer: a });
    } catch (e) {
      setPhone({ at: 'error', message: (e as Error).message });
    }
  };

  // While a phone link waits, look for its recording every two seconds.
  const waiting = phone?.at === 'waiting' ? phone.id : null;
  useEffect(() => {
    if (!waiting) return;
    let live = true;
    const look = async () => {
      try {
        const r = await api.recording(waiting);
        if (!live) return;
        if (r.status === 'received') {
          setPhone({ at: 'arrived', recording: r });
          kept_.current?.(r);
        } else if (r.status === 'expired')
          setPhone({ at: 'error', message: 'That link ran out before anything was sent. Make a new one.' });
      } catch {}
    };
    const t = setInterval(() => void look(), 2000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [waiting]);

  const phoneBody = () => {
    if (!phone) return null;
    switch (phone.at) {
      case 'asking':
      case 'turning':
        return (
          <div className="hg-recorddlg__stage" role="status">
            <span className="hg-spin" />
            <p className="body-sm sec-text">
              {phone.at === 'turning' ? 'Turning on the link…' : 'Making a link…'}
            </p>
          </div>
        );
      case 'confirm':
        return (
          <div className="hg-recorddlg__stage">
            <h3 className="st-h2">
              {phone.plan.route === 'none'
                ? 'No link is possible yet'
                : phone.plan.public
                  ? 'Turn on a public link to this computer?'
                  : 'Turn on a private link to this computer?'}
            </h3>
            <p className="body-sm sec-text">{phone.plan.ask}</p>
            <div className="hg-record-actions">
              <Button kind="ghost" onClick={() => setPhone(null)} data-autofocus="">
                Not now
              </Button>
              <Button kind="primary" icon="link" onClick={() => void turnOn(phone.plan)}>
                {phone.plan.route === 'none'
                  ? 'What do I need?'
                  : phone.plan.public
                    ? 'Turn on public link'
                    : 'Turn on'}
              </Button>
            </div>
          </div>
        );
      case 'missing':
        return (
          <div className="hg-recorddlg__stage" role="alert">
            <h3 className="st-h2">One thing first</h3>
            <p className="body-sm sec-text">{phone.answer.message}</p>
            <ul className="hg-stack body-sm" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {phone.answer.steps.map((s) => (
                <li key={s.id}>
                  <b>{s.title}.</b> <span className="sec-text">{s.detail}</span>
                  {s.command ? (
                    <>
                      {' '}
                      <WithCode text={`\`${s.command}\``} />
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
            <div className="hg-record-actions">
              <Button kind="ghost" onClick={() => setPhone(null)}>
                Back
              </Button>
              <Button icon="rotate" onClick={() => void askPhone()}>
                Try again
              </Button>
            </div>
          </div>
        );
      case 'waiting':
        return (
          <div className="hg-recorddlg__stage">
            <Qr
              value={phone.url}
              label="QR code for the link to record on your phone"
              hint="Point your phone’s camera at this, tap Record there, and send it. This page picks it up."
            />
            {phone.note ? <p className="body-sm sec-text">{phone.note}</p> : null}
            {phone.secure ? null : (
              <p className="body-sm sec-text">
                This link isn’t https, so some phones won’t let the page use the microphone. They can still
                send a recording they already have.
              </p>
            )}
            <p className="body-sm muted" role="status">
              <span className="hg-spin" /> Waiting for your recording. The link works once, for 30 minutes.
            </p>
          </div>
        );
      case 'arrived':
        return (
          <div className="hg-recorddlg__stage" role="status">
            <span className="hg-ok__icon">
              <Icon name="check" size={24} />
            </span>
            <h3 className="st-h2">It arrived</h3>
            <p className="body-sm sec-text">
              {phone.recording.seconds ? `${clock(phone.recording.seconds)} · ` : ''}It’s kept with your
              recordings.
            </p>
          </div>
        );
      case 'error':
        return (
          <div className="hg-recorddlg__stage" role="alert">
            <p className="body-sm hg-err">{phone.message}</p>
            <div className="hg-record-actions">
              <Button kind="ghost" onClick={() => setPhone(null)}>
                Back
              </Button>
              <Button icon="rotate" onClick={() => void askPhone()}>
                Try again
              </Button>
            </div>
          </div>
        );
    }
  };

  // ── Here ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const here = () => {
    if (kept)
      return (
        <div className="hg-recorddlg__stage" role="status">
          <span className="hg-ok__icon">
            <Icon name="check" size={24} />
          </span>
          <h3 className="st-h2">Kept</h3>
          <p className="body-sm sec-text">
            {kept.seconds ? `${clock(kept.seconds)} · ` : ''}It’s with your recordings, ready to clean up and
            to use as a film’s voice-over.
          </p>
        </div>
      );
    if (cap.state === 'review' && cap.clip)
      return (
        <div className="hg-recorddlg__stage">
          {kind === 'video' ? (
            // biome-ignore lint/a11y/useMediaCaption: the person's own take, played back to check it
            <video
              className="hg-record-media"
              src={cap.clip.url}
              controls
              playsInline
              aria-label="Your video"
            />
          ) : (
            // biome-ignore lint/a11y/useMediaCaption: the person's own take, played back to check it
            <audio className="hg-record-media" src={cap.clip.url} controls aria-label="Your recording" />
          )}
          <div className="hg-record-actions">
            <Button icon="rotate" onClick={cap.again} disabled={busy}>
              Record again
            </Button>
            <Button icon="keep" kind="primary" onClick={() => void keep()} busy={busy}>
              {busy ? 'Keeping…' : 'Keep'}
            </Button>
          </div>
        </div>
      );
    return (
      <div className="hg-recorddlg__stage">
        {kind === 'video' && cap.stream ? <Preview stream={cap.stream} /> : null}
        <button
          type="button"
          className={`st-rec${on ? '' : ' idle'}`}
          aria-label={on ? 'Stop recording' : 'Start recording'}
          aria-pressed={on}
          disabled={cap.state === 'asking' || cap.state === 'unsupported' || cap.state === 'denied'}
          onClick={() => (on ? cap.stop() : void cap.start())}
          data-autofocus=""
        >
          <Icon name={on ? 'stop' : kind === 'video' ? 'camera' : 'mic'} size={24} />
        </button>
        <span className="num body-sm muted" aria-live="off">
          {on ? clock(cap.seconds) : '0:00'}
        </span>
        {cap.state === 'idle' ? (
          <p className="body-sm sec-text">
            Tap the button to start. Hildegard asks for your {kind === 'video' ? 'camera and ' : ''}
            microphone only then, and nothing leaves this computer. You can listen back before you keep it.
          </p>
        ) : null}
        {cap.state === 'denied' || cap.state === 'unsupported' ? (
          <>
            <p className="body-sm hg-err" role="alert">
              {cap.state === 'denied'
                ? `The ${kind === 'video' ? 'camera or microphone is' : 'microphone is'} blocked. Allow it for Hildegard in your system settings, or choose a ${kind === 'video' ? 'video' : 'voice recording'} you already have.`
                : `This window can’t record here. Record on your phone below, or choose a ${kind === 'video' ? 'video' : 'voice recording'} you already have.`}
            </p>
            <label className="hg-btn">
              <Icon name="upload" size={18} />
              <span>Choose a file</span>
              <input
                type="file"
                accept={kind === 'video' ? 'video/*' : 'audio/*'}
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) cap.choose(f);
                }}
              />
            </label>
          </>
        ) : null}
      </div>
    );
  };

  const arrived = phone?.at === 'arrived';
  return (
    <Modal open onClose={onClose} labelledBy={id} variant="dialog" className="st-dialog hg-recorddlg">
      <div className="st-dialog__h">
        <div style={{ flex: 1 }}>
          <h2 id={id}>Record</h2>
          <p>
            {kinds.length > 1 ? 'Your voice, or yourself on camera.' : 'Your voice.'} It stays on this
            computer, with your other recordings.
          </p>
        </div>
      </div>
      <div className="st-dialog__b">
        {kinds.length > 1 && !phone && !kept ? (
          <Segmented
            className="hg-seg hg-seg--fill"
            label="What to record"
            value={kind}
            onChange={(k) => {
              cap.again();
              setKind(k);
            }}
            options={[
              { value: 'voice' as Kind, label: 'Voice', disabled: working },
              { value: 'video' as Kind, label: 'Video with sound', disabled: working },
            ]}
          />
        ) : null}
        {phone ? phoneBody() : here()}
      </div>
      <div className="st-dialog__f">
        {!phone && !kept && !working && cap.state !== 'review' ? (
          <Button icon="phone" kind="ghost" onClick={() => void askPhone()}>
            Record on your phone
          </Button>
        ) : null}
        <span style={{ flex: 1 }} />
        {kept || arrived ? (
          <Button kind="ghost" onClick={another}>
            Record another
          </Button>
        ) : null}
        <Button kind={kept || arrived ? 'primary' : 'ghost'} onClick={onClose} disabled={on}>
          {kept || arrived ? 'Done' : 'Close'}
        </Button>
      </div>
    </Modal>
  );
}
