// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Clone a voice, with living consent: the speaker reads a fresh consent line (here, or on their own phone through a
 * link), then records samples. Hildegard checks the line was heard, live, and that every sample is the same person
 * before it makes anything.
 */
import type { ConsentSessionView, MarkCheck, VoiceState } from '@hildegard/presets';
import { useEffect, useState } from 'react';
import { Button, Icon, LiveRing, RadioGroup, toast, toastError } from '../../components/ui.tsx';
import { DropAudio, Orb, PlayButton, Wave } from '../../components/voice.tsx';
import { api } from '../../lib/api.ts';
import { clock } from '../../lib/format.ts';
import { useLocal, useNow } from '../../lib/hooks.ts';
import { setConsent, upsert, useStore, whenVoiceJob } from '../../lib/store.ts';
import { toggle, useRecorder } from '../../lib/voice.ts';

type Relation = ConsentSessionView['relation'];
type Step = 'consent' | 'record' | 'check' | 'ready';
const STEPS: Array<{ id: Step; label: string }> = [
  { id: 'consent', label: 'Consent' },
  { id: 'record', label: 'Record' },
  { id: 'check', label: 'Check' },
  { id: 'ready', label: 'Ready' },
];

/** Something to read while recording samples: plain, varied sentences that cover most sounds. */
const PASSAGE = [
  'In the summer of 1150, Hildegard left the monastery and took her sisters down the river to Bingen.',
  'They said the hill was too steep for a convent. She built one anyway, stone by stone, and the bells rang across the water.',
  'She wrote about plants and stars, healing and music, and sent letters to popes and emperors who wrote back.',
  'Quick brown hares jumped over the frozen ditch while six women watched from the garden wall.',
  'Would you bring the blue jug, please? The bread is warm, and the soup needs a pinch of salt.',
];

export function Steps({ at }: { at: Step }) {
  const i = STEPS.findIndex((s) => s.id === at);
  return (
    <ol className="st-steps hg-steps-v" aria-label="Steps">
      {STEPS.map((s, k) => (
        <li
          key={s.id}
          className={k < i ? 'done' : k === i ? 'cur' : undefined}
          aria-current={k === i ? 'step' : undefined}
        >
          {k ? <span className="sep" aria-hidden="true" /> : null}
          <span>
            <i aria-hidden="true">{k < i ? <Icon name="check" size={14} /> : k + 1}</i>
            {s.label}
            {k < i ? <span className="sr"> (done)</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Which step a session is on. */
export function stepOf(s: ConsentSessionView | null, redo: 'consent' | 'record' | null): Step {
  if (!s?.recording || redo === 'consent') return 'consent';
  if (s.voice || s.check?.ok) return 'ready';
  if (s.checking || (s.check && redo !== 'record')) return 'check';
  return 'record';
}

export function Clone({
  state,
  sessionId,
  go,
  redo,
  setRedo,
}: {
  state: VoiceState;
  sessionId: string | null;
  go: (to: string) => void;
  redo: 'consent' | 'record' | null;
  setRedo: (r: 'consent' | 'record' | null) => void;
}) {
  const session = useStore((s) => (sessionId ? (s.consents.get(sessionId) ?? null) : null));
  const [links, setLinks] = useLocal<Record<string, string>>('hildegard.voice.consentLinks', {});
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!sessionId || session) return;
    api
      .consent(sessionId)
      .then(setConsent)
      .catch(() => setMissing(true));
  }, [sessionId, session]);

  if (!sessionId)
    return (
      <Whose
        state={state}
        onStarted={(s) => {
          setConsent(s);
          if (s.link) setLinks((l) => ({ ...l, [s.id]: s.link! }));
          go(`/voice/clone/${s.id}`);
        }}
      />
    );
  if (missing)
    return (
      <div className="hg-empty">
        <b>This clone isn’t here any more</b>
        <span className="body-sm muted">
          Consent lines last ten minutes, and a restart forgets them. Start again.
        </span>
        <Button kind="primary" onClick={() => go('/voice/clone')}>
          Start again
        </Button>
      </div>
    );
  if (!session)
    return (
      <div className="hg-empty" role="status">
        <span className="hg-spin" />
      </div>
    );
  const step = stepOf(session, redo);
  if (step === 'consent')
    return (
      <Consent
        s={session}
        link={links[session.id] ?? null}
        again={redo === 'consent'}
        onDone={() => setRedo(null)}
        go={go}
      />
    );
  if (step === 'record')
    return (
      <Record
        s={session}
        state={state}
        onCheck={() => setRedo(null)}
        onRedoConsent={() => setRedo('consent')}
      />
    );
  if (step === 'check') return <Check s={session} state={state} go={go} setRedo={setRedo} />;
  return <Ready s={session} state={state} go={go} />;
}

function Whose({
  state,
  onStarted,
}: {
  state: VoiceState;
  onStarted: (s: ConsentSessionView & { link: string | null }) => void;
}) {
  const [relation, setRelation] = useState<Relation>('self');
  const [speaker, setSpeaker] = useLocal('hildegard.voice.speaker', '');
  const [until, setUntil] = useState('');
  const [busy, setBusy] = useState(false);
  const canClone = state.catalog.models.filter((m) => m.can.includes('clone'));
  const usable =
    state.engine.fake || canClone.some((m) => state.models.find((x) => x.id === m.id)?.installed);
  const options: Array<{ id: Relation; icon: string; title: string; body: string }> = [
    {
      id: 'self',
      icon: 'person',
      title: 'Your own voice',
      body: 'You read a short consent line, then record your samples. Ready in about five minutes.',
    },
    {
      id: 'agreed',
      icon: 'link',
      title: 'Someone who has agreed',
      body: 'Send them a link. They read the consent line on their own phone, then record. Nothing to install.',
    },
    {
      id: 'licensed',
      icon: 'book',
      title: 'A voice actor you license',
      body: 'They record consent the same way, and you note when the license ends. Hildegard keeps both with the voice.',
    },
  ];
  const start = async () => {
    if (!speaker.trim()) return;
    setBusy(true);
    try {
      onStarted(
        await api.startConsent({
          speaker: speaker.trim(),
          relation,
          until: relation === 'licensed' && until ? new Date(`${until}T23:59:59`).toISOString() : null,
        }),
      );
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="hg-clone hg-clone--whose"
      onSubmit={(e) => {
        e.preventDefault();
        void start();
      }}
    >
      <h2 className="st-h1">Whose voice is this?</h2>
      <p className="st-lead">
        Every clone starts with the speaker saying yes, in their own voice. Hildegard checks that the samples
        match that person before it makes anything.
      </p>
      <RadioGroup label="Whose voice" className="hg-whose">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            className="st-opt2"
            aria-checked={relation === o.id}
            tabIndex={relation === o.id ? 0 : -1}
            onClick={() => setRelation(o.id)}
          >
            <Icon name={o.icon} size={22} />
            <b>{o.title}</b>
            <span className="body-sm sec-text">{o.body}</span>
          </button>
        ))}
      </RadioGroup>
      <div className="hg-whose__fields">
        <label className="hg-field hg-field--block">
          {relation === 'self'
            ? 'Your name, as you’ll say it'
            : relation === 'agreed'
              ? 'Their name, as they’ll say it'
              : 'The actor’s name, as they’ll say it'}
          <input
            value={speaker}
            maxLength={60}
            autoComplete="name"
            onChange={(e) => setSpeaker(e.target.value)}
            required
          />
        </label>
        {relation === 'licensed' ? (
          <label className="hg-field hg-field--block">
            License ends (optional)
            <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
          </label>
        ) : null}
      </div>
      {!usable ? (
        <div className="st-tile hg-banner" role="status">
          <Icon name="alert" size={18} />
          <span>Cloning needs Chatterbox or Qwen3-TTS Base. Get one in Voice models first.</span>
        </div>
      ) : null}
      <div className="hg-between hg-wrap">
        <span className="body-sm muted hg-promise">
          <Icon name="shield" size={16} /> Hildegard won’t clone a voice without its owner’s recorded consent,
          public figures included.
        </span>
        <Button kind="primary" size="lg" type="submit" busy={busy} disabled={!speaker.trim() || !usable}>
          Continue
        </Button>
      </div>
    </form>
  );
}

/** The live meter while recording, and the record button. */
function RecordButton({ rec, label }: { rec: ReturnType<typeof useRecorder>; label: string }) {
  const on = rec.state === 'recording';
  return (
    <div className="hg-recbar">
      <span className="hg-level" aria-hidden="true">
        <i style={{ transform: `scaleX(${on ? Math.min(1, rec.level * 1.6) : 0})` }} />
      </span>
      <button
        type="button"
        className={`st-rec${on ? '' : ' idle'}`}
        aria-label={on ? 'Stop recording' : label}
        aria-pressed={on}
        disabled={rec.state === 'asking' || rec.state === 'unsupported'}
        onClick={() => (on ? rec.stop() : void rec.start())}
      >
        <Icon name={on ? 'stop' : 'mic'} size={24} />
      </button>
      <span className="hg-level r" aria-hidden="true">
        <i style={{ transform: `scaleX(${on ? Math.min(1, rec.level * 1.6) : 0})` }} />
      </span>
      <span className="num body-sm hg-recbar__t" aria-live="off">
        {on ? clock(rec.seconds) : ''}
      </span>
    </div>
  );
}

function micProblem(state: ReturnType<typeof useRecorder>['state']): string | null {
  if (state === 'denied')
    return 'Hildegard can’t use the microphone. Allow it in your browser’s site settings, or upload a recording instead.';
  if (state === 'unsupported') return 'This browser can’t record here. Upload a recording instead.';
  return null;
}

function Consent({
  s,
  link,
  again,
  onDone,
  go,
}: {
  s: ConsentSessionView;
  link: string | null;
  again: boolean;
  onDone: () => void;
  go: (to: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [here, setHere] = useState(s.relation === 'self' || !link);
  const now = useNow(true);
  const left = Date.parse(s.expiresAt) - now;
  const send = async (blob: Blob) => {
    setBusy(true);
    try {
      setConsent(await api.recordConsent(s.id, blob));
      onDone();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const rec = useRecorder((blob) => void send(blob));
  const self = s.relation === 'self';
  const restart = async () => {
    try {
      const n = await api.startConsent({ speaker: s.speaker, relation: s.relation });
      setConsent(n);
      go(`/voice/clone/${n.id}`);
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <div className="hg-clone hg-clone--consent">
      <p className="hg-eyebrow">
        {again
          ? 'Record the consent line again'
          : self
            ? 'First, your consent, in your own voice'
            : `First, ${s.speaker}’s consent, in their own voice`}
      </p>
      <blockquote className="st-prompter">
        <b>“{s.line}”</b>
      </blockquote>
      {left <= 0 ? (
        <div className="hg-stack" style={{ justifyItems: 'center' }}>
          <p className="body-sm sec-text">
            This line has expired, so a recording made earlier can’t be reused.
          </p>
          <Button kind="primary" onClick={restart}>
            Get a fresh line
          </Button>
        </div>
      ) : !here && link ? (
        <div className="st-tile hg-sendlink">
          <b>Send {s.speaker} this link</b>
          <span className="body-sm sec-text">
            They open it on their own phone and read the line aloud. This page moves on by itself when it
            arrives.
          </span>
          <div className="st-code">
            <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{link}</span>
            <Button
              size="sm"
              icon="copy"
              onClick={() =>
                navigator.clipboard
                  .writeText(link)
                  .then(() => toast('Link copied.'))
                  .catch(toastError)
              }
            >
              Copy
            </Button>
          </div>
          <span className="body-sm muted" role="status">
            <span className="hg-spin" /> Waiting for {s.speaker}… The line works for{' '}
            {Math.ceil(left / 60_000)} more {Math.ceil(left / 60_000) === 1 ? 'minute' : 'minutes'}.
          </span>
          <button type="button" className="hg-linkbtn body-sm" onClick={() => setHere(true)}>
            Or record {s.speaker} here, together
          </button>
        </div>
      ) : (
        <>
          <RecordButton rec={rec} label={self ? 'Record your consent' : `Record ${s.speaker}’s consent`} />
          {busy ? (
            <p className="body-sm muted" role="status">
              <span className="hg-spin" /> Saving the recording…
            </p>
          ) : null}
          <p className="body-sm sec-text hg-clone__note">
            Read it once. Hildegard keeps this recording with the voice and checks it matches every sample
            before it makes anything, so no one can clone a voice that isn’t theirs. The line works for{' '}
            {Math.ceil(left / 60_000)} more {Math.ceil(left / 60_000) === 1 ? 'minute' : 'minutes'}.
          </p>
          {micProblem(rec.state) ? (
            <p className="body-sm hg-err" role="alert">
              {micProblem(rec.state)}
            </p>
          ) : null}
          <DropAudio compact label="Or upload a recording of the line made just now" onFile={send} />
        </>
      )}
    </div>
  );
}

function Record({
  s,
  state,
  onCheck,
  onRedoConsent,
}: {
  s: ConsentSessionView;
  state: VoiceState;
  onCheck: () => void;
  onRedoConsent: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState(0);
  const need = state.catalog.consent.quickSeconds;
  const total = (s.recording?.seconds ?? 0) + s.samples.reduce((n, x) => n + x.seconds, 0);
  const target = Math.max(60, need);
  const add = async (blob: Blob) => {
    setBusy(true);
    try {
      const u = await api.uploadAudio(blob);
      setConsent(await api.addSamples(s.id, [u.name]));
      setLine((l) => (l + 1) % PASSAGE.length);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const rec = useRecorder((blob) => void add(blob));
  const check = async () => {
    setBusy(true);
    try {
      const j = await api.checkConsent(s.id);
      upsert({ type: 'voice-job', job: j });
      onCheck();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="hg-clone hg-clone--record">
      <div className="hg-record__read">
        <h2 className="sr">Read this aloud</h2>
        <p className="st-prompter hg-reading">
          {PASSAGE.map((p, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed passage.
            <span key={i} className={i === line ? 'now' : undefined}>
              {p}{' '}
            </span>
          ))}
        </p>
        <RecordButton rec={rec} label="Record a sample" />
        <p className="body-sm sec-text">
          {rec.state === 'recording'
            ? 'Recording. Read at your normal pace, then stop.'
            : busy
              ? 'Saving…'
              : `Read the highlighted lines in ${s.speaker === '' ? 'your' : `${s.speaker}’s`} normal voice. Short clips are fine.`}
        </p>
        {micProblem(rec.state) ? (
          <p className="body-sm hg-err" role="alert">
            {micProblem(rec.state)}
          </p>
        ) : null}
      </div>
      <aside className="st-pane r hg-record__side" aria-label="Samples">
        <div className="hg-record__meter">
          <div className="hg-between">
            <span className="hg-record__total">
              <b className="num">{clock(total)}</b> <span className="muted">of {clock(need)}</span>
            </span>
            {total >= need ? <span className="cs-fit ok">Enough</span> : null}
          </div>
          <div
            className="st-meter"
            role="meter"
            aria-label="Speech recorded"
            aria-valuemin={0}
            aria-valuemax={target}
            aria-valuenow={Math.round(total)}
          >
            <i style={{ width: `${Math.min(100, (total / target) * 100)}%` }} />
            <span className="tgt" style={{ left: `${(need / target) * 100}%` }} />
          </div>
          <span className="body-sm muted">
            {need} seconds makes a quick clone, counting the consent line. A minute of clean speech makes it
            closer.
          </span>
        </div>
        <p className="hg-eyebrow" style={{ textAlign: 'left' }}>
          Clips
        </p>
        <ul className="hg-clips" aria-label="Clips">
          {s.recording ? (
            <li className="st-clipcard">
              <PlayButton url={s.recording.url} label="the consent recording" size="sm" ghost />
              <span className="hg-clips__t">
                <b>Consent</b>
                <small className="num">{clock(s.recording.seconds)}</small>
              </span>
              <button type="button" className="hg-linkbtn body-sm" onClick={onRedoConsent}>
                Record again
              </button>
            </li>
          ) : null}
          {s.samples.map((x, i) => (
            <li key={x.name} className="hg-clips__li">
              <div className="st-clipcard">
                <PlayButton url={x.url} label={`clip ${i + 1}`} size="sm" ghost />
                <span className="hg-clips__t">
                  <b>Clip {i + 1}</b>
                  <small className="num">{clock(x.seconds)}</small>
                </span>
                <span className={`st-check${x.quality.level === 'ok' ? '' : ' warn'}`}>
                  <span className="dot">
                    <Icon name={x.quality.level === 'ok' ? 'check' : 'alert'} size={14} />
                  </span>
                  Level
                </span>
                <span className={`st-check${x.quality.noise === 'ok' ? '' : ' warn'}`}>
                  <span className="dot">
                    <Icon name={x.quality.noise === 'ok' ? 'check' : 'alert'} size={14} />
                  </span>
                  Noise
                </span>
                <button
                  type="button"
                  className="hg-btn hg-btn--icon hg-btn--ghost hg-btn--sm"
                  aria-label={`Remove clip ${i + 1}`}
                  onClick={() => api.removeSample(s.id, x.name).then(setConsent).catch(toastError)}
                >
                  <Icon name="trash" size={16} />
                </button>
              </div>
              {x.quality.tip ? <p className="body-sm muted hg-clips__tip">{x.quality.tip}</p> : null}
            </li>
          ))}
        </ul>
        <DropAudio
          compact
          label="Add recordings you already have"
          onUploaded={(u) => api.addSamples(s.id, [u.name]).then(setConsent).catch(toastError)}
        />
        <Button
          kind="primary"
          size="lg"
          className="hg-btn--block"
          onClick={check}
          busy={busy}
          disabled={total < need || rec.state === 'recording' || !s.samples.length}
        >
          Check and continue
        </Button>
        {!s.samples.length ? (
          <p className="body-sm muted">Record at least one sample to clone from.</p>
        ) : null}
      </aside>
    </div>
  );
}

function Check({
  s,
  state,
  go,
  setRedo,
}: {
  s: ConsentSessionView;
  state: VoiceState;
  go: (to: string) => void;
  setRedo: (r: 'consent' | 'record' | null) => void;
}) {
  const c = s.check;
  const rows: Array<{ ok: boolean | null; text: string }> = [
    { ok: c ? c.live.ok : null, text: 'It’s a person’s live voice, not an AI one' },
    { ok: c ? c.heard.ok : null, text: 'The consent line was heard, word for word' },
    { ok: c ? c.speaker.ok : null, text: 'Every clip is the person who gave consent' },
    { ok: c ? c.length.ok : null, text: 'There’s enough speech to clone from' },
  ];
  if (s.checking || !c)
    return (
      <div className="hg-clone hg-clone--check" role="status">
        <LiveRing value={null} size={56} />
        <h2 className="st-h1">Checking it’s the same person…</h2>
        <ul className="hg-checks">
          {rows.map((r) => (
            <li key={r.text} className="st-check warn">
              <span className="dot">
                <span className="hg-spin" />
              </span>
              {r.text}
            </li>
          ))}
        </ul>
      </div>
    );
  const sameSpeaker = state.catalog.consent.sameSpeaker;
  const strangers = c.speaker.scores
    .map((v, i) => ({ v, i }))
    .filter((x) => x.v < sameSpeaker)
    .map((x) => x.i);
  const title = !c.live.ok
    ? 'The consent recording sounds made by AI.'
    : !c.heard.ok
      ? 'Hildegard couldn’t hear the consent line.'
      : !c.speaker.ok
        ? 'These clips aren’t from the person who gave consent.'
        : 'There isn’t enough speech yet.';
  const body =
    !c.speaker.ok && c.live.ok && c.heard.ok
      ? `${strangers.map((i) => `Clip ${i + 1}`).join(' and ')} ${strangers.length === 1 ? 'sounds' : 'sound'} like a different speaker than the consent recording. Hildegard didn’t make anything.`
      : `${c.why.join(' ')} Hildegard didn’t make anything.`;
  return (
    <div className="hg-clone hg-clone--blocked" role="alert">
      <span className="hg-blocked__icon">
        <Icon name="shield" size={24} />
      </span>
      <h2 className="st-h1">{title}</h2>
      <p className="st-lead">{body}</p>
      <ul className="hg-checks">
        {rows.map((r) => (
          <li key={r.text} className={`st-check${r.ok ? '' : ' warn'}`}>
            <span className="dot">
              <Icon name={r.ok ? 'check' : 'close'} size={14} />
            </span>
            {r.text}
            <span className="sr">{r.ok ? ', passed' : ', failed'}</span>
          </li>
        ))}
      </ul>
      <div className="hg-wrap" style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
        {!c.live.ok || !c.heard.ok ? (
          <Button kind="primary" icon="mic" onClick={() => setRedo('consent')}>
            Record consent again
          </Button>
        ) : !c.speaker.ok ? (
          <>
            <Button
              onClick={async () => {
                try {
                  for (const i of strangers.sort((a, b) => b - a)) {
                    const x = s.samples[i];
                    if (x) setConsent(await api.removeSample(s.id, x.name));
                  }
                  setRedo('record');
                } catch (e) {
                  toastError(e);
                }
              }}
            >
              Remove those clips
            </Button>
            <Button kind="primary" onClick={() => go('/voice/clone')}>
              Invite the new speaker
            </Button>
          </>
        ) : (
          <Button kind="primary" icon="mic" onClick={() => setRedo('record')}>
            Record more
          </Button>
        )}
      </div>
      <p className="body-sm muted">
        Each speaker records their own consent. That keeps every voice in Hildegard legal and theirs.
      </p>
    </div>
  );
}

function Ready({ s, state, go }: { s: ConsentSessionView; state: VoiceState; go: (to: string) => void }) {
  const voice = s.voice ? (state.voices.find((v) => v.id === s.voice) ?? null) : null;
  const [name, setName] = useState(s.speaker);
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState('The bells rang for the first time across the water.');
  const [tryJob, setTryJob] = useState<string | null>(null);
  const tryClip = state.jobs.find((j) => j.id === tryJob);
  const finish = async () => {
    setBusy(true);
    try {
      await api.finishClone(s.id, name.trim() || s.speaker);
      setConsent(await api.consent(s.id));
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const say = async () => {
    if (!voice || !line.trim()) return;
    setBusy(true);
    try {
      const j = await api.speak({
        paragraphs: [{ text: line.trim() }],
        voice: voice.id,
        title: line.trim().slice(0, 60),
      });
      upsert({ type: 'voice-job', job: j });
      setTryJob(j.id);
      const done = await whenVoiceJob(j.id);
      if (done.status === 'done' && done.audio[0]) toggle(done.audio[0]);
      else if (done.error) toastError(new Error(done.error.message));
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  if (!voice)
    return (
      <form
        className="hg-clone hg-clone--name"
        onSubmit={(e) => {
          e.preventDefault();
          void finish();
        }}
      >
        <span className="hg-ok__icon">
          <Icon name="check" size={24} />
        </span>
        <h2 className="st-h1">{s.speaker}’s consent checks out</h2>
        <p className="st-lead">
          The line was heard live, and every clip is the same person. Name the voice and Hildegard signs a
          consent certificate for it.
        </p>
        <label className="hg-field hg-field--block" style={{ width: 'min(420px, 100%)' }}>
          Name
          <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </label>
        <Button kind="primary" size="lg" type="submit" busy={busy}>
          Make the voice
        </Button>
      </form>
    );
  return (
    <div className="hg-clone hg-clone--ready">
      <section className="st-tile hg-ready__voice" aria-labelledby="ready-n">
        <div className="st-tile__h">
          <Orb hue={voice.hue} size={72} />
          <span>
            <b id="ready-n" className="hg-ready__name">
              {voice.name}
            </b>
            <small>
              Clone · made on {state.device} · <span className="num">$0.00</span>
            </small>
          </span>
        </div>
        <div className="hg-clip">
          <PlayButton
            url={tryClip?.status === 'done' ? (tryClip.audio[0] ?? null) : null}
            onNeed={say}
            busy={busy}
            label={`${voice.name} saying the line`}
          />
          <Wave url={tryClip?.status === 'done' ? (tryClip.audio[0] ?? null) : null} />
        </div>
        <form
          className="hg-ready__try"
          onSubmit={(e) => {
            e.preventDefault();
            void say();
          }}
        >
          <input
            value={line}
            maxLength={400}
            aria-label="Something to say"
            onChange={(e) => {
              setLine(e.target.value);
              setTryJob(null);
            }}
          />
        </form>
        <div className="st-row2">
          <Button onClick={() => go(`/voice/voices/${voice.id}`)}>Consent and uses</Button>
          <Button kind="primary" onClick={() => go(`/voice/speak/${voice.id}`)}>
            Use voice
          </Button>
        </div>
      </section>
      <IsOurs />
    </div>
  );
}

/** Drop any clip to learn whether Hildegard made it. */
export function IsOurs({ intro = true }: { intro?: boolean }) {
  const [result, setResult] = useState<{ file: string; check: MarkCheck } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <section className="st-tile hg-ours" aria-labelledby="ours-h">
      {intro ? (
        <div className="hg-ours__mark">
          <Icon name="shield" size={18} />
          <span>
            <b>Every clip is watermarked</b>
            <small className="body-sm muted">Inaudible, and it survives MP3 and trimming.</small>
          </span>
        </div>
      ) : null}
      <h3 id="ours-h" className="st-h2">
        Is this ours?
      </h3>
      <DropAudio
        compact
        label="Drop a clip to check it"
        onUploaded={async (u, f) => {
          setBusy(true);
          try {
            setResult({ file: f.name, check: await api.isOurs(u.name) });
          } catch (e) {
            toastError(e);
          } finally {
            setBusy(false);
          }
        }}
      />
      {busy ? (
        <p className="body-sm muted" role="status">
          <span className="hg-spin" /> Listening for the watermark…
        </p>
      ) : result ? (
        <div className={`hg-ours__r ${result.check.verdict}`} role="status">
          <Icon name={result.check.verdict === 'no' ? 'close' : 'check'} size={18} />
          <span>
            <b>
              {result.check.verdict === 'ours'
                ? 'Yes, made with Hildegard.'
                : result.check.verdict === 'likely'
                  ? 'Probably made with Hildegard.'
                  : 'No Hildegard watermark in it.'}
            </b>
            <small>
              {result.file}
              {result.check.job
                ? ` · ${result.check.job.title}, ${new Date(result.check.job.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`
                : ''}
            </small>
          </span>
        </div>
      ) : null}
    </section>
  );
}
