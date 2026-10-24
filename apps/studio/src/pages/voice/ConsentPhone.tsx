// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The page a speaker opens on their own phone from a consent link: their name, the line, and a record button.
 * It needs no account, and can do one thing only: send the recording.
 */
import { useEffect, useState } from 'react';
import markVellum from '../../assets/mark-vellum.svg';
import { Icon } from '../../components/ui.tsx';
import { DropAudio } from '../../components/voice.tsx';
import { api, type ConsentLink } from '../../lib/api.ts';
import { clock } from '../../lib/format.ts';
import { useNow } from '../../lib/hooks.ts';
import { useRecorder } from '../../lib/voice.ts';

export function ConsentPhone({ token }: { token: string }) {
  const [info, setInfo] = useState<ConsentLink | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const now = useNow(!!info && !sent);
  useEffect(() => {
    document.title = 'Your consent · Hildegard';
    api
      .consentLink(token)
      .then((i) => {
        setInfo(i);
        setSent(i.recorded);
      })
      .catch((e) => setError((e as Error).message));
  }, [token]);
  const send = async (blob: Blob) => {
    setBusy(true);
    setError(null);
    try {
      await api.recordByLink(token, blob);
      setSent(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const rec = useRecorder((blob) => void send(blob));
  const left = info ? Date.parse(info.expiresAt) - now : 0;
  const on = rec.state === 'recording';
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
          <h1 className="st-h1">Thank you, {info.speaker}</h1>
          <p className="st-lead">
            Your consent arrived. You can close this page. Whoever sent the link can now record your samples
            with you; nothing is made until every sample matches your voice.
          </p>
        </div>
      ) : left <= 0 ? (
        <div className="hg-stack" role="alert">
          <h1 className="st-h1">This line has expired</h1>
          <p className="st-lead">
            Ask for a new link. Each one works for ten minutes, so an old recording can’t be reused.
          </p>
        </div>
      ) : (
        <>
          <p className="hg-eyebrow">Hello, {info.speaker}. Read this aloud, once.</p>
          <blockquote className="st-prompter">
            <b>“{info.line}”</b>
          </blockquote>
          <button
            type="button"
            className={`st-rec${on ? '' : ' idle'}`}
            aria-label={on ? 'Stop recording' : 'Record your consent'}
            aria-pressed={on}
            disabled={busy || rec.state === 'asking' || rec.state === 'unsupported'}
            onClick={() => (on ? rec.stop() : void rec.start())}
          >
            <Icon name={on ? 'stop' : 'mic'} size={24} />
          </button>
          <span className="num body-sm muted">
            {on ? clock(rec.seconds) : busy ? 'Sending…' : `${Math.ceil(left / 60_000)} min left`}
          </span>
          <p className="body-sm sec-text">
            By reading it you agree that the person who sent this link may make a copy of your voice with
            Hildegard. The words at the end are random, so this recording can only be used for this voice.
          </p>
          {rec.state === 'denied' || rec.state === 'unsupported' ? (
            <>
              <p className="body-sm hg-err" role="alert">
                {rec.state === 'denied'
                  ? 'The microphone is blocked. Allow it for this page, or record the line in your voice memos and upload it.'
                  : 'This browser can’t record here. Record the line in your voice memos and upload it.'}
              </p>
              <DropAudio compact label="Upload a recording of the line" onFile={send} />
            </>
          ) : null}
          {error ? (
            <p className="body-sm hg-err" role="alert">
              {error}
            </p>
          ) : null}
        </>
      )}
    </main>
  );
}
