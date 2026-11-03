// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Talk: say something, and Hildegard answers out loud. Each turn goes to /api/talk/turn alone, which hears it,
 * answers and speaks; the page never calls the voice studio itself, so where each step runs can change behind it.
 */
import type { ChoirState, DeviceCapabilities } from '@hildegard/presets';
import { useEffect, useState } from 'react';
import { Icon, toastError } from '../components/ui.tsx';
import { Clip, DropAudio } from '../components/voice.tsx';
import { api, type TalkStatus, type TalkTurn } from '../lib/api.ts';
import { talkMeter, talksThere } from '../lib/format.ts';
import { useStore } from '../lib/store.ts';
import { toggle, useRecorder } from '../lib/voice.ts';
import { micProblem, RecordButton } from './voice/Clone.tsx';

/** This computer's claim in one quiet line: what it hears, answers and speaks with. */
function capsLine(c: DeviceCapabilities, llm: TalkStatus['llm']): string {
  const io = [c.mic && 'microphone', c.speaker && 'speaker'].filter(Boolean).join(' and ');
  return [
    io ? `This computer has a ${io}` : 'This computer has no microphone or speaker of its own',
    `hears with ${c.stt.join(', ') || 'nothing yet'}`,
    `answers with ${llm ? llm.model : 'a stand-in'}`,
    `speaks with ${c.tts.join(', ') || 'nothing yet'}`,
    c.compute === 'interactive' ? 'answers while you wait' : 'works in batches',
  ].join(', ');
}

/** How long each step of a turn took, as one bar in three parts, and where it ran. */
function Timing({ t }: { t: TalkTurn }) {
  if (!t.ms) return null;
  const m = talkMeter(t.ms);
  const where = t.device && t.device !== 'local' ? t.device : 'this computer';
  return (
    <div className="hg-talk-meter" data-testid="talk-timing">
      <div className="hg-talk-meter__bar" aria-hidden="true">
        {m.steps.map((s) => (
          <i key={s.id} className={`is-${s.id}`} style={{ flexGrow: s.share }} />
        ))}
      </div>
      <p className="body-sm muted">
        {m.steps.map((s) => `${s.label} in ${s.text}`).join(' · ')} · {m.total} in all, on {where}
      </p>
    </div>
  );
}

/** Where the reply's audio plays from: the URL the server gave, or the bytes it sent. */
const replyUrl = (t: TalkTurn) =>
  t.audio.url ?? (t.audio.data ? `data:${t.audio.contentType};base64,${t.audio.data}` : null);

export function Talk() {
  const [status, setStatus] = useState<TalkStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [turns, setTurns] = useState<Array<TalkTurn & { n: number }>>([]);
  const stored = useStore((s) => s.choir);
  // What the page asked for when it opened, else what the store last heard.
  const [fetched, setFetched] = useState<ChoirState | null>(null);
  const choir = fetched ?? stored;
  /** Joined devices a turn can run on now, and the one chosen; null follows the primary. */
  const devices = (choir?.devices ?? []).filter(talksThere).map((d) => d.name);
  const primary = choir?.primary ?? status?.primary ?? 'local';
  const primaryReady = primary === 'local' || devices.includes(primary);
  const [picked, setPicked] = useState<string | null>(null);
  const device = picked ?? (primaryReady ? primary : 'local');

  useEffect(() => {
    let live = true;
    api
      .talk()
      .then((s) => live && setStatus(s))
      .catch((e) => live && setError((e as Error).message));
    api
      .choir()
      .then((c) => live && setFetched(c))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const send = async (clip: Blob) => {
    setBusy(true);
    try {
      const t = await api.talkTurn(clip, { device });
      setTurns((all) => [{ ...t, n: (all[0]?.n ?? 0) + 1 }, ...all].slice(0, 20));
      const url = replyUrl(t);
      if (url) toggle(url);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const rec = useRecorder((clip) => void send(clip));
  const mic = micProblem(rec.state);

  return (
    <>
      <header className="hg-app__top">
        <div className="cs-crumb">
          <span className="t">Talk</span>
        </div>
      </header>
      <main className="cs-stage hg-scroll" id="main">
        <div className="st-page hg-narrow">
          {status && !status.ready ? (
            <div className="st-tile hg-banner" role="status">
              <Icon name="alert" size={18} />
              <span>{status.problem ?? 'Talk isn’t ready on this computer.'}</span>
            </div>
          ) : null}
          {error ? (
            <div className="st-tile hg-banner" role="alert">
              <Icon name="alert" size={18} />
              <span>{error}</span>
            </div>
          ) : null}
          <section className="st-tile hg-stack" aria-labelledby="talk-h">
            <h2 id="talk-h" className="st-h2">
              Say something
            </h2>
            <p className="body-sm muted">
              Record what you want to say. Hildegard hears it, answers, and says the answer back. Need lines
              to read? Open the <a href="#/talk/script">demo script</a>.
            </p>
            <RecordButton rec={rec} label="Record what you want to say" />
            {mic ? <p className="body-sm muted">{mic}</p> : null}
            <DropAudio compact label="Or upload a recording" onFile={send} />
            {busy ? (
              <div className="hg-between" role="status">
                <span className="body-sm muted">Listening and answering…</span>
                <span className="hg-spin" aria-hidden="true" />
              </div>
            ) : null}
            {devices.length ? (
              <label className="hg-field--block">
                Hear and answer on
                <select className="hg-select" value={device} onChange={(e) => setPicked(e.target.value)}>
                  <option value="local">This computer{primary === 'local' ? ' (primary)' : ''}</option>
                  {devices.map((n) => (
                    <option key={n} value={n}>
                      {n}
                      {primary === n ? ' (primary)' : ''}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {!primaryReady ? (
              <p className="body-sm muted" role="status">
                {primary} is your primary, but it can’t hear and answer right now, so turns run on this
                computer until it can.
              </p>
            ) : null}
            {status ? <p className="body-sm muted">{capsLine(status.capabilities, status.llm)}.</p> : null}
          </section>
          {turns.map((t, i) => {
            const url = replyUrl(t);
            return (
              <section
                key={t.n}
                className="st-tile hg-stack"
                aria-label={i === 0 ? 'Latest turn' : `Turn ${t.n}`}
              >
                <div>
                  <b className="body-sm">You said</b>
                  <p data-testid="talk-transcript">{t.transcript}</p>
                </div>
                <div>
                  <b className="body-sm">Hildegard said</b>
                  <p data-testid="talk-reply">{t.replyText}</p>
                </div>
                {url ? <Clip url={url} label="Hildegard’s answer" /> : null}
                <Timing t={t} />
              </section>
            );
          })}
        </div>
      </main>
    </>
  );
}
