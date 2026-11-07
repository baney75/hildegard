// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The page a link from a chat opens: record a voice or a video on this device, play it back, record again, and send
 * it. It needs no account; the link's token is the only key, it works once, and this page can do nothing else. It
 * never starts the microphone or camera until the person taps.
 */
import { useEffect, useRef, useState } from 'react';
import markVellum from '../assets/mark-vellum.svg';
import { Button, Icon } from '../components/ui.tsx';
import { api, type RecordLinkInfo } from '../lib/api.ts';
import { clock } from '../lib/format.ts';
import { useNow } from '../lib/hooks.ts';
import { useCapture } from '../lib/record.ts';

function Preview({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} className="hg-record-media" autoPlay muted playsInline aria-label="Your camera" />;
}

export function RecordPage({ token }: { token: string }) {
  const [info, setInfo] = useState<RecordLinkInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const kind = info?.kind ?? 'voice';
  const cap = useCapture(kind);
  const now = useNow(!!info && !sent);

  useEffect(() => {
    document.title = 'Record · Hildegard';
    api
      .recordLinkInfo(token)
      .then((i) => {
        setInfo(i);
        setSent(i.state === 'received');
      })
      .catch((e) => setError((e as Error).message));
  }, [token]);

  const send = async () => {
    if (!cap.clip || !info) return;
    if (cap.clip.blob.size > info.maxBytes) {
      setProblem(
        `That recording is over ${Math.round(info.maxBytes / 1024 / 1024)} MB, which is more than Hildegard takes here. Record a shorter one.`,
      );
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await api.recordSend(token, cap.clip.blob);
      setSent(true);
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const left = info ? Date.parse(info.expiresAt) - now : 0;
  const on = cap.state === 'recording';
  const what = kind === 'voice' ? 'voice' : 'video';
  return (
    <main className="hg-phone-consent" id="main">
      <img src={markVellum} alt="Hildegard" height={36} />
      {!info ? (
        error ? (
          <div className="hg-stack" role="alert">
            <h1 className="st-h1">This link doesn’t work</h1>
            <p className="st-lead">{error}</p>
          </div>
        ) : (
          <span className="hg-spin" role="status" aria-label="Opening" />
        )
      ) : sent ? (
        <div className="hg-stack" role="status">
          <span className="hg-ok__icon">
            <Icon name="check" size={24} />
          </span>
          <h1 className="st-h1">Sent</h1>
          <p className="st-lead">Your recording arrived. You can close this page.</p>
        </div>
      ) : left <= 0 && cap.state !== 'recording' ? (
        <div className="hg-stack" role="alert">
          <h1 className="st-h1">This link has run out</h1>
          <p className="st-lead">Ask for a new one. Each works for 30 minutes, and once.</p>
        </div>
      ) : (
        <>
          <p className="hg-eyebrow">{kind === 'voice' ? 'Record your voice' : 'Record a video'}</p>
          {info.purpose ? (
            <blockquote className="st-prompter">
              <b>{info.purpose}</b>
            </blockquote>
          ) : null}
          {cap.state === 'review' && cap.clip ? (
            <>
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
                <Button icon="upload" kind="primary" onClick={() => void send()} busy={busy}>
                  {busy ? 'Sending…' : 'Send'}
                </Button>
              </div>
            </>
          ) : (
            <>
              {kind === 'video' && cap.stream ? <Preview stream={cap.stream} /> : null}
              <button
                type="button"
                className={`st-rec${on ? '' : ' idle'}`}
                aria-label={on ? 'Stop recording' : 'Start recording'}
                aria-pressed={on}
                disabled={cap.state === 'asking' || cap.state === 'unsupported' || cap.state === 'denied'}
                onClick={() => (on ? cap.stop() : void cap.start())}
              >
                <Icon name={on ? 'stop' : kind === 'video' ? 'camera' : 'mic'} size={24} />
              </button>
              <span className="num body-sm muted" aria-live="off">
                {on ? clock(cap.seconds) : `${Math.max(1, Math.ceil(left / 60_000))} min left`}
              </span>
              {cap.state === 'idle' ? (
                <p className="body-sm sec-text">
                  Tap the button to start. Hildegard asks your {kind === 'video' ? 'camera and ' : ''}
                  microphone only then. You can listen back before you send.
                </p>
              ) : null}
              {cap.state === 'denied' || cap.state === 'unsupported' ? (
                <>
                  <p className="body-sm hg-err" role="alert">
                    {cap.state === 'denied'
                      ? `The ${kind === 'video' ? 'camera or microphone is' : 'microphone is'} blocked. Allow it for this page, or choose a ${what} you already have.`
                      : `This browser can’t record here. Choose a ${what} you already have.`}
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
            </>
          )}
          {problem ? (
            <p className="body-sm hg-err" role="alert">
              {problem}
            </p>
          ) : null}
        </>
      )}
    </main>
  );
}
