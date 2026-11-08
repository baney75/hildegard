// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The page a link from a chat opens: record on this device from what the link allows (the camera, the screen, the
 * screen with the camera, or the voice), with a teleprompter when the link brought a script, and for an interview one
 * question at a time. Each answer goes to Hildegard on Next, so the agent asking can hear it and ask a follow-up, which
 * this page picks up within a few seconds. Then play it back, record again, and send it. It needs no account; the
 * link's token is the only key, the full recording goes once, and this page can do nothing else. It never starts the
 * microphone, camera or a screen share until the person presses Record.
 */
import { useEffect, useState } from 'react';
import markVellum from '../assets/mark-vellum.svg';
import { Recorder, useInterview } from '../components/Recorder.tsx';
import { Button, Icon } from '../components/ui.tsx';
import { api, type RecordLinkInfo } from '../lib/api.ts';
import { type Source, useStudioRecorder } from '../lib/capture.ts';
import { useNow } from '../lib/hooks.ts';

/** How often the page looks for a follow-up question. */
const POLL_MS = 3000;

export function RecordPage({ token }: { token: string }) {
  const [info, setInfo] = useState<RecordLinkInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [script, setScript] = useState('');

  useEffect(() => {
    document.title = 'Record · Hildegard';
    api
      .recordLinkInfo(token)
      .then((i) => {
        setInfo(i);
        setScript(i.script ?? '');
        setSent(i.state === 'received');
      })
      .catch((e) => setError((e as Error).message));
  }, [token]);

  if (!info)
    return (
      <main className="hg-phone-consent" id="main">
        <img src={markVellum} alt="Hildegard" height={36} />
        {error ? (
          <div className="hg-stack" role="alert">
            <h1 className="st-h1">This link doesn’t work</h1>
            <p className="st-lead">{error}</p>
          </div>
        ) : (
          <span className="hg-spin" role="status" aria-label="Opening" />
        )}
      </main>
    );
  return (
    <LinkRecorder
      token={token}
      info={info}
      setInfo={setInfo}
      sent={sent}
      setSent={setSent}
      busy={busy}
      setBusy={setBusy}
      problem={problem}
      setProblem={setProblem}
      script={script}
      setScript={setScript}
    />
  );
}

function LinkRecorder({
  token,
  info,
  setInfo,
  sent,
  setSent,
  busy,
  setBusy,
  problem,
  setProblem,
  script,
  setScript,
}: {
  token: string;
  info: RecordLinkInfo;
  setInfo: (i: RecordLinkInfo) => void;
  sent: boolean;
  setSent: (b: boolean) => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
  problem: string | null;
  setProblem: (s: string | null) => void;
  script: string;
  setScript: (s: string) => void;
}) {
  const sources: Source[] = info.sources?.length
    ? info.sources
    : [info.kind === 'voice' ? 'voice' : 'camera'];
  // Each link remembers its own choices only for this page: nothing is kept for the next link.
  const rec = useStudioRecorder({ sources, storage: null });
  const questions = info.questions?.length ? info.questions : null;
  const interview = useInterview(rec, questions, async (i, at, clip) => {
    await api.recordAnswer(token, i, at, clip);
  });
  const now = useNow(!sent);

  // An interview looks for follow-ups every few seconds while the page is open, and keeps its end time fresh.
  // biome-ignore lint/correctness/useExhaustiveDependencies: whether it is an interview, not each new list.
  useEffect(() => {
    if (!questions || sent) return;
    let live = true;
    const t = setInterval(() => {
      api
        .recordLinkInfo(token)
        .then((i) => live && setInfo(i))
        .catch(() => {});
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [!!questions, sent, token, setInfo]);

  const left = Date.parse(info.expiresAt) - now;
  const on = rec.phase === 'recording' || rec.phase === 'paused' || rec.phase === 'countdown';

  const send = async () => {
    const c = rec.clip;
    if (!c) return;
    if (c.blob.size > info.maxBytes) {
      setProblem(
        `That recording is over ${Math.round(info.maxBytes / 1024 / 1024)} MB, which is more than Hildegard takes here. Record a shorter one.`,
      );
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      if (c.chapters.length) await api.recordChapters(token, c.chapters);
      await api.recordSend(token, c.blob);
      setSent(true);
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (sent)
    return (
      <main className="hg-phone-consent" id="main">
        <img src={markVellum} alt="Hildegard" height={36} />
        <div className="hg-stack" role="status">
          <span className="hg-ok__icon">
            <Icon name="check" size={24} />
          </span>
          <h1 className="st-h1">Sent</h1>
          <p className="st-lead">Your recording arrived. You can close this page.</p>
        </div>
      </main>
    );
  if (left <= 0 && !on && rec.phase !== 'review')
    return (
      <main className="hg-phone-consent" id="main">
        <img src={markVellum} alt="Hildegard" height={36} />
        <div className="hg-stack" role="alert">
          <h1 className="st-h1">This link has run out</h1>
          <p className="st-lead">Ask for a new one.</p>
        </div>
      </main>
    );

  const what = questions
    ? 'An interview'
    : sources[0] === 'voice'
      ? 'Record your voice'
      : sources.some((s) => s !== 'camera')
        ? 'Record your screen or camera'
        : 'Record a video';
  return (
    <main className="hg-recpage" id="main">
      <header className="hg-recpage__h">
        <img src={markVellum} alt="Hildegard" height={28} />
        <div style={{ minWidth: 0 }}>
          <p className="hg-eyebrow">{what}</p>
          {info.purpose ? <h1 className="st-h2">{info.purpose}</h1> : null}
        </div>
        <span className="num body-sm muted" aria-live="off">
          {Math.max(1, Math.ceil(left / 60_000))} min left
        </span>
      </header>
      <Recorder
        rec={rec}
        script={questions ? null : script}
        setScript={setScript}
        interview={interview}
        intro={
          questions ? (
            <p>
              <b>Each answer goes to Hildegard when you tap Next, so the interviewer can hear it.</b> The
              questions show one at a time; new ones may arrive as you go. At the end you watch it back and
              send the whole recording.
            </p>
          ) : (
            <p>
              Press Record to start. Hildegard asks for your microphone
              {sources.some((s) => s !== 'voice') ? ', camera or screen' : ''} only then. You can play it back
              before you send it.
            </p>
          )
        }
        review={() => (
          <>
            <div className="hg-record-actions">
              <Button icon="rotate" onClick={rec.again} disabled={busy}>
                Record again
              </Button>
              <Button icon="upload" kind="primary" onClick={() => void send()} busy={busy}>
                {busy ? 'Sending…' : 'Send'}
              </Button>
            </div>
            {problem ? (
              <p className="body-sm hg-err" role="alert">
                {problem}
              </p>
            ) : null}
          </>
        )}
      />
    </main>
  );
}
