// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The full recorder, for a record link's page and the Studio's Record page: what to record from, which microphone and
 * camera, the camera's bubble over a screen, a teleprompter, an interview's questions one at a time, and the
 * countdown, pause and stop. The caller says what happens to the take (send it, keep it).
 */
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import {
  type BubbleSize,
  type Chapter,
  type Corner,
  hasPicture,
  remember,
  remembered,
  SOURCE_LABEL,
  type Source,
  type StudioRecorder,
} from '../lib/capture.ts';
import { clock } from '../lib/format.ts';
import { Button, Icon, Segmented, Slider, Switch } from './ui.tsx';

function Live({ stream, label, mirror }: { stream: MediaStream; label: string; mirror?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <video
      ref={ref}
      className={`hg-rec__video${mirror ? ' is-mirror' : ''}`}
      autoPlay
      muted
      playsInline
      aria-label={label}
    />
  );
}

/** How loud the microphone is now: a quiet bar that turns gold only near clipping. */
export function LevelMeter({ level, label = 'Microphone level' }: { level: number; label?: string }) {
  const pct = Math.min(100, Math.round(Math.sqrt(level) * 100));
  return (
    <div
      className={`hg-rec__meter${level > 0.9 ? ' is-hot' : ''}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

// ── Teleprompter ─────────────────────────────────────────────────────────────────────────────────────────────

export interface PrompterSettings {
  speed: number;
  size: number;
  mirror: boolean;
}
const PROMPTER_KEY = 'hildegard.record.prompter';
export function usePrompterSettings(): [PrompterSettings, (p: Partial<PrompterSettings>) => void] {
  const [s, set] = useState<PrompterSettings>(() => {
    try {
      const j = JSON.parse(remembered(PROMPTER_KEY) || 'null') as PrompterSettings | null;
      if (j && typeof j.speed === 'number' && typeof j.size === 'number') return j;
    } catch {}
    return { speed: 40, size: 32, mirror: false };
  });
  return [
    s,
    (p) =>
      set((old) => {
        const next = { ...old, ...p };
        remember(PROMPTER_KEY, JSON.stringify(next));
        return next;
      }),
  ];
}

/**
 * The script, scrolling past a reading line while recording: it starts when the countdown ends, stops with Pause, and
 * goes back to the top for another take. Mirrored, it reads right through a glass prompter.
 */
export function Prompter({
  text,
  running,
  restart,
  settings,
}: {
  text: string;
  running: boolean;
  /** Changes when a new take starts, to go back to the top. */
  restart: unknown;
  settings: PrompterSettings;
}) {
  const box = useRef<HTMLDivElement>(null);
  const pos = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: back to the top for each take.
  useEffect(() => {
    pos.current = 0;
    if (box.current) box.current.scrollTop = 0;
  }, [restart]);
  useEffect(() => {
    if (!running) return;
    let raf = 0;
    let last = performance.now();
    const step = (t: number) => {
      const el = box.current;
      if (el) {
        pos.current = Math.min(
          el.scrollHeight - el.clientHeight,
          pos.current + ((t - last) / 1000) * settings.speed,
        );
        el.scrollTop = pos.current;
      }
      last = t;
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [running, settings.speed]);
  return (
    <div className={`hg-prompter${settings.mirror ? ' is-mirror' : ''}`}>
      <div
        ref={box}
        className="hg-prompter__text"
        style={{ fontSize: settings.size, lineHeight: 1.45 }}
        data-testid="prompter"
        data-running={running ? '' : undefined}
        // A scrolling region takes focus, so the keys scroll it between takes.
        // biome-ignore lint/a11y/noNoninteractiveTabindex: axe's scrollable-region-focusable asks for it
        tabIndex={0}
        role="region"
        aria-label="Teleprompter"
        onScroll={(e) => {
          if (!running) pos.current = e.currentTarget.scrollTop;
        }}
      >
        <div className="hg-prompter__pad" />
        {text.split(/\n{2,}/).map((p, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs of one text, in order
          <p key={i}>{p}</p>
        ))}
        <div className="hg-prompter__pad" />
      </div>
      <span className="hg-prompter__line" aria-hidden="true" />
    </div>
  );
}

// ── The recorder ─────────────────────────────────────────────────────────────────────────────────────────────

export interface InterviewView {
  questions: string[];
  /** The question on screen; equal to questions.length when all are answered. */
  index: number;
  next: () => void;
  busy: boolean;
  note: string | null;
}

export function Recorder({
  rec,
  script,
  setScript,
  interview,
  review,
  intro,
  footer,
}: {
  rec: StudioRecorder;
  /** Teleprompter text; null hides the teleprompter. */
  script: string | null;
  setScript?: (s: string) => void;
  interview?: InterviewView | null;
  /** What to do with a take once it is done: Send, Keep. */
  review: (clip: NonNullable<StudioRecorder['clip']>) => ReactNode;
  /** A line before anything starts. */
  intro?: ReactNode;
  /** Under the setup: a practice interview's questions, say. */
  footer?: ReactNode;
}) {
  const id = useId();
  const [prompter, setPrompter] = usePrompterSettings();
  const [editing, setEditing] = useState(false);
  const [take, setTake] = useState(0);
  const p = rec.phase;
  const live = p === 'recording' || p === 'paused' || p === 'countdown';
  const busy = live || p === 'asking';
  const picture = hasPicture(rec.source);
  const camera = rec.source === 'camera' || rec.source === 'screen+camera';
  const onStage = interview ? (interview.questions[interview.index] ?? null) : null;

  useEffect(() => {
    if (p === 'countdown') setTake((t) => t + 1);
  }, [p]);

  if (p === 'review' && rec.clip) {
    const c = rec.clip;
    return (
      <div className="hg-rec hg-rec--review">
        <div className="hg-rec__stage">
          {picture || c.blob.type.startsWith('video') ? (
            // biome-ignore lint/a11y/useMediaCaption: the person's own take, played back to check it
            <video className="hg-rec__video" src={c.url} controls playsInline aria-label="Your video" />
          ) : (
            // biome-ignore lint/a11y/useMediaCaption: the person's own take, played back to check it
            <audio className="hg-record-media" src={c.url} controls aria-label="Your recording" />
          )}
        </div>
        <div className="hg-rec__side hg-stack">
          <p className="body-sm sec-text num">
            {c.seconds ? `${clock(c.seconds)} · ` : ''}
            {Math.max(1, Math.round(c.blob.size / 1024 / 1024))} MB
          </p>
          {c.chapters.length ? <Chapters chapters={c.chapters} /> : null}
          {review(c)}
        </div>
      </div>
    );
  }

  const record = () => void rec.start({ countdown: true });
  return (
    <div className="hg-rec">
      <div className="hg-rec__stage">
        {onStage !== null || (interview && live) ? (
          <div className="hg-rec__ask" aria-live="polite">
            <p className="hg-eyebrow">
              {onStage !== null
                ? `Question ${interview!.index + 1} of ${interview!.questions.length}`
                : 'Questions'}
            </p>
            <p className="st-prompter hg-rec__q">
              <b>
                {onStage ??
                  'That was the last question. Stop when you’re done, or wait a moment for a follow-up.'}
              </b>
            </p>
            {interview!.note ? <p className="body-sm sec-text">{interview!.note}</p> : null}
          </div>
        ) : null}
        {script !== null && !interview ? (
          editing && !live ? (
            <label className="hg-field--block hg-rec__script">
              Script
              <textarea
                className="cs-area"
                value={script}
                rows={8}
                maxLength={20_000}
                onChange={(e) => setScript?.(e.target.value)}
                placeholder="Paste or write what you’ll say. A blank line starts a new paragraph."
              />
            </label>
          ) : script.trim() ? (
            <Prompter text={script} running={p === 'recording'} restart={take} settings={prompter} />
          ) : null
        ) : null}
        <div className={`hg-rec__screen${picture ? '' : ' is-voice'}`}>
          {rec.preview && picture ? (
            <Live
              stream={rec.preview}
              label={rec.source === 'camera' ? 'Your camera' : 'What is being recorded'}
              mirror={rec.source === 'camera'}
            />
          ) : (
            <div className="hg-rec__blank">
              <Icon name={picture ? (rec.source === 'camera' ? 'camera' : 'desktop') : 'mic'} size={24} />
              {picture && !live ? (
                <span className="body-sm muted">
                  {rec.source === 'camera'
                    ? 'Your camera shows here once you press Record.'
                    : 'You choose a screen, window or tab when you press Record.'}
                </span>
              ) : null}
              {!picture ? <LevelMeter level={rec.level} /> : null}
            </div>
          )}
          {p === 'countdown' ? (
            <button
              type="button"
              className="hg-rec__count"
              onClick={rec.skipCountdown}
              aria-label={`Starting in ${rec.count}. Start now`}
            >
              <span className="num">{rec.count}</span>
              <small>Start now</small>
            </button>
          ) : null}
          {p === 'recording' || p === 'paused' ? (
            <span className={`hg-rec__live${p === 'paused' ? ' is-paused' : ''}`} role="status">
              <i aria-hidden="true" />
              {p === 'paused' ? 'Paused' : 'Recording'} <span className="num">{clock(rec.seconds)}</span>
            </span>
          ) : null}
        </div>
        <div className="hg-rec__transport">
          {live && p !== 'countdown' ? (
            <Button
              icon={p === 'paused' ? 'play' : 'pause'}
              onClick={p === 'paused' ? rec.resume : rec.pause}
              aria-keyshortcuts="Space"
            >
              {p === 'paused' ? 'Resume' : 'Pause'}
            </Button>
          ) : null}
          <button
            type="button"
            className={`st-rec${live ? '' : ' idle'}`}
            aria-label={live ? 'Stop recording' : 'Start recording'}
            aria-pressed={live}
            aria-keyshortcuts={live ? 'Escape' : undefined}
            disabled={p === 'asking' || p === 'unsupported' || p === 'denied'}
            onClick={() => (live ? rec.stopKey.current() : record())}
          >
            <Icon name={live ? 'stop' : picture ? (camera ? 'camera' : 'desktop') : 'mic'} size={24} />
          </button>
          {interview && (p === 'recording' || p === 'paused') && onStage !== null ? (
            <Button kind="primary" icon="chevronr" onClick={interview.next} disabled={interview.busy}>
              {interview.index + 1 < interview.questions.length ? 'Next' : 'Done with this one'}
            </Button>
          ) : null}
        </div>
        <p className="body-sm muted hg-rec__hint">
          {live
            ? 'Space pauses and resumes. Esc stops.'
            : p === 'asking'
              ? 'Waiting for your browser…'
              : 'A 3-2-1 countdown starts it. Tap the number to start at once.'}
        </p>
        {rec.problem ? (
          <p className="body-sm hg-err" role="alert">
            {rec.problem}
          </p>
        ) : null}
        {p === 'denied' || p === 'unsupported' ? (
          <div className="hg-stack" style={{ justifyItems: 'center' }}>
            <p className="body-sm hg-err" role="alert">
              {p === 'denied'
                ? `The ${picture ? 'camera, screen or microphone is' : 'microphone is'} blocked. Allow it for this page, or choose a recording you already have.`
                : 'This browser can’t record here. Choose a recording you already have.'}
            </p>
            <label className="hg-btn">
              <Icon name="upload" size={18} />
              <span>Choose a file</span>
              <input
                type="file"
                accept={picture ? 'video/*' : 'audio/*'}
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) rec.choose(f);
                }}
              />
            </label>
            {p === 'denied' ? (
              <Button kind="ghost" onClick={rec.again}>
                Try again
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="hg-rec__side">
        {intro && !live ? <div className="body-sm sec-text">{intro}</div> : null}
        <section className="hg-rec__group" aria-labelledby={`${id}-src`}>
          <h3 id={`${id}-src`} className="hg-rec__label">
            Record
          </h3>
          {rec.offered.length > 1 ? (
            <Segmented
              className="hg-seg hg-seg--fill hg-rec__sources"
              label="What to record"
              value={rec.source}
              onChange={(s: Source) => rec.setSource(s)}
              options={rec.offered.map((s) => ({ value: s, label: SOURCE_LABEL[s], disabled: busy }))}
            />
          ) : (
            <p className="body-sm">{SOURCE_LABEL[rec.source]}</p>
          )}
          {!rec.screen.ok && rec.offered.length < ['camera', 'screen', 'screen+camera', 'voice'].length ? (
            <p className="body-sm muted">{rec.screen.reason}</p>
          ) : null}
        </section>

        <section className="hg-rec__group" aria-labelledby={`${id}-dev`}>
          <h3 id={`${id}-dev`} className="hg-rec__label">
            Devices
          </h3>
          <label className="hg-field--block">
            Microphone
            <select
              className="hg-select"
              aria-label="Microphone"
              value={rec.mic ?? ''}
              disabled={busy}
              onChange={(e) => rec.setMic(e.target.value || null)}
            >
              <option value="">The system’s microphone</option>
              {rec.devices.mics.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          <div className="hg-rec__microw">
            <LevelMeter level={rec.level} />
            <Button
              size="sm"
              kind="ghost"
              icon="mic"
              onClick={() => void rec.testMic()}
              disabled={busy || !!rec.testing}
            >
              {rec.testing === 'listening'
                ? 'Say something…'
                : rec.testing === 'playing'
                  ? 'Playing back…'
                  : 'Test'}
            </Button>
          </div>
          {camera ? (
            <label className="hg-field--block">
              Camera
              <select
                className="hg-select"
                aria-label="Camera"
                value={rec.cam ?? ''}
                disabled={busy}
                onChange={(e) => rec.setCam(e.target.value || null)}
              >
                <option value="">The system’s camera</option>
                {rec.devices.cams.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {!rec.devices.mics.some((d) => !/^Microphone \d+$/.test(d.label)) ? (
            <p className="body-sm muted">Names show once you allow the microphone: press Test or Record.</p>
          ) : null}
        </section>

        {rec.source === 'screen+camera' ? (
          <section className="hg-rec__group" aria-labelledby={`${id}-bub`}>
            <h3 id={`${id}-bub`} className="hg-rec__label">
              Camera bubble
            </h3>
            <Segmented
              className="hg-seg hg-seg--fill"
              label="Corner"
              value={rec.bubble.corner}
              onChange={(c: Corner) => rec.setBubble({ corner: c })}
              options={[
                { value: 'tl', label: 'Top left' },
                { value: 'tr', label: 'Top right' },
                { value: 'bl', label: 'Bottom left' },
                { value: 'br', label: 'Bottom right' },
              ]}
            />
            <div className="hg-rec__pair">
              <Segmented
                className="hg-seg hg-seg--fill"
                label="Bubble size"
                value={rec.bubble.size}
                onChange={(s: BubbleSize) => rec.setBubble({ size: s })}
                options={[
                  { value: 'S', label: 'S' },
                  { value: 'M', label: 'M' },
                  { value: 'L', label: 'L' },
                ]}
              />
              <Segmented
                className="hg-seg hg-seg--fill"
                label="Bubble shape"
                value={rec.bubble.shape}
                onChange={(s: 'round' | 'rounded') => rec.setBubble({ shape: s })}
                options={[
                  { value: 'round', label: 'Round' },
                  { value: 'rounded', label: 'Square' },
                ]}
              />
            </div>
          </section>
        ) : null}

        {script !== null && !interview ? (
          <section className="hg-rec__group" aria-labelledby={`${id}-tp`}>
            <div className="hg-between">
              <h3 id={`${id}-tp`} className="hg-rec__label">
                Teleprompter
              </h3>
              {setScript ? (
                <Button size="sm" kind="ghost" onClick={() => setEditing((e) => !e)} disabled={live}>
                  {editing ? 'Done' : script.trim() ? 'Edit script' : 'Add a script'}
                </Button>
              ) : null}
            </div>
            <Slider
              label="Scroll speed"
              value={prompter.speed}
              min={10}
              max={120}
              step={5}
              onChange={(v) => setPrompter({ speed: v })}
              valueText={`${prompter.speed} pixels a second`}
              head={<span className="body-sm sec-text">Speed</span>}
            />
            <Slider
              label="Text size"
              value={prompter.size}
              min={20}
              max={64}
              step={2}
              onChange={(v) => setPrompter({ size: v })}
              valueText={`${prompter.size} pixels`}
              head={<span className="body-sm sec-text">Text size</span>}
            />
            <div className="hg-between">
              <span className="body-sm sec-text">Mirror, for a glass prompter</span>
              <Switch
                checked={prompter.mirror}
                onChange={(v) => setPrompter({ mirror: v })}
                label="Mirror the teleprompter"
              />
            </div>
          </section>
        ) : null}
        {footer}
      </div>
    </div>
  );
}

/** A take's chapters, as a list; with `onSeek`, each jumps there. */
export function Chapters({ chapters, onSeek }: { chapters: Chapter[]; onSeek?: (at: number) => void }) {
  return (
    <ol className="hg-chapters" aria-label="Chapters">
      {chapters.map((c) => (
        <li key={`${c.at}-${c.title}`}>
          {onSeek ? (
            <button type="button" onClick={() => onSeek(c.at)}>
              <span className="num muted">{clock(c.at)}</span>
              <span>{c.title}</span>
            </button>
          ) : (
            <>
              <span className="num muted">{clock(c.at)}</span>
              <span>{c.title}</span>
            </>
          )}
        </li>
      ))}
    </ol>
  );
}

/** A kept recording with its chapters: a chapter seeks the player to where it starts. */
export function RecordingPlayer({
  url,
  kind,
  label,
  chapters,
}: {
  url: string;
  kind: 'voice' | 'video';
  label: string;
  chapters: Chapter[];
}) {
  const ref = useRef<HTMLMediaElement | null>(null);
  const seek = (at: number) => {
    const m = ref.current;
    if (!m) return;
    m.currentTime = at;
    void m.play().catch(() => {});
  };
  return (
    <div className="hg-stack">
      {kind === 'video' ? (
        // biome-ignore lint/a11y/useMediaCaption: the person's own recording
        <video
          ref={(el) => {
            ref.current = el;
          }}
          className="hg-rec__video"
          src={url}
          controls
          playsInline
          preload="metadata"
          aria-label={label}
        />
      ) : (
        // biome-ignore lint/a11y/useMediaCaption: the person's own recording
        <audio
          ref={(el) => {
            ref.current = el;
          }}
          className="hg-record-media"
          src={url}
          controls
          preload="metadata"
          aria-label={label}
        />
      )}
      {chapters.length ? <Chapters chapters={chapters} onSeek={seek} /> : null}
    </div>
  );
}

/**
 * An interview's questions, one at a time: a chapter where each is put, and on Next the answer's sound is cut out and
 * handed to `onAnswer` (the link's page sends it; a practice interview keeps nothing).
 */
export function useInterview(
  rec: StudioRecorder,
  questions: string[] | null,
  onAnswer?: (index: number, at: number, clip: Blob) => Promise<void>,
): InterviewView | null {
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const starts = useRef<number[]>([]);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const list = questions ?? [];
  const p = rec.phase;

  // The first question is put when recording starts; a new take starts over.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on the phase alone.
  useEffect(() => {
    if (p === 'recording' && !starts.current.length && list.length) {
      starts.current = [rec.mark(list[0]!)];
      setIndex(0);
    }
    if (p === 'idle') {
      starts.current = [];
      setIndex(0);
      setNote(null);
    }
  }, [p]);
  // A follow-up arriving after the last answer is put at once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: when the list grows.
  useEffect(() => {
    const on = p === 'recording' || p === 'paused';
    if (on && starts.current.length === index && index < list.length)
      starts.current.push(rec.mark(list[index]!));
  }, [list.length]);

  const send = (i: number, clip: Blob | null) => {
    if (!onAnswer || !clip) return;
    const at = starts.current[i] ?? 0;
    queue.current = queue.current.then(() =>
      onAnswer(i, at, clip).catch((e) =>
        setNote(
          `Answer ${i + 1} didn’t reach Hildegard (${(e as Error).message}). It’s still in the full recording.`,
        ),
      ),
    );
  };

  // Esc and Stop take the answer in progress with them.
  rec.stopKey.current = () => {
    const i = index;
    if (questions && starts.current.length > i && (p === 'recording' || p === 'paused'))
      void rec.finish().then((clip) => send(i, clip));
    else rec.stop();
  };

  if (!questions) return null;
  return {
    questions: list,
    index,
    busy,
    note,
    next: () => {
      const i = index;
      if (i >= list.length || busy) return;
      setBusy(true);
      void rec.cut().then((clip) => {
        send(i, clip);
        const n = i + 1;
        if (n < list.length) starts.current.push(rec.mark(list[n]!));
        setIndex(n);
        setBusy(false);
      });
    },
  };
}
