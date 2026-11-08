// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Record in the Studio, the full recorder: the camera, the screen, the screen with the camera in a bubble, or the
 * voice alone; the microphone and camera of your choice; a teleprompter; and a practice interview with questions you
 * type, each one a chapter. What you keep lands with your recordings, chapters and all.
 */
import { useEffect, useId, useState } from 'react';
import { BrowserDemo } from '../components/BrowserDemo.tsx';
import { Recorder, RecordingPlayer, useInterview } from '../components/Recorder.tsx';
import { Button, Icon, Segmented, Switch, toastError } from '../components/ui.tsx';
import { api, type RecordingInfo } from '../lib/api.ts';
import { hasPicture, remember, remembered, useStudioRecorder } from '../lib/capture.ts';
import { recordingLabel, useRecordings } from '../lib/recordings.ts';
import { useStore } from '../lib/store.ts';

const SCRIPT_KEY = 'hildegard.record.script';
const QUESTIONS_KEY = 'hildegard.record.questions';

export function RecordStudio() {
  const id = useId();
  const rec = useStudioRecorder({ sources: ['camera', 'screen', 'screen+camera', 'voice'] });
  const [script, setScriptState] = useState(() => remembered(SCRIPT_KEY) ?? '');
  const setScript = (s: string) => {
    setScriptState(s);
    remember(SCRIPT_KEY, s || null);
  };
  const [practice, setPractice] = useState(false);
  const [typed, setTyped] = useState(() => remembered(QUESTIONS_KEY) ?? '');
  const questions = practice
    ? typed
        .split('\n')
        .map((q) => q.trim())
        .filter(Boolean)
        .slice(0, 30)
    : null;
  const interview = useInterview(rec, questions?.length ? questions : null);
  const [busy, setBusy] = useState(false);
  const [kept, setKept] = useState<RecordingInfo | null>(null);
  const mine = useRecordings();
  const live = rec.phase === 'recording' || rec.phase === 'paused' || rec.phase === 'countdown';
  const [mode, setMode] = useState<'record' | 'demo'>(() =>
    remembered('hildegard.record.mode') === 'demo' ? 'demo' : 'record',
  );
  const here = useStore((s) => !!s.auth?.local);

  useEffect(() => {
    if (rec.phase === 'countdown') setKept(null);
  }, [rec.phase]);

  const keep = async () => {
    const c = rec.clip;
    if (!c) return;
    setBusy(true);
    try {
      const kind = hasPicture(rec.source) || c.blob.type.startsWith('video') ? 'video' : 'voice';
      const r = await api.keepRecording(c.blob, kind);
      if (c.chapters.length) await api.recordChapters(r.id, c.chapters);
      setKept({ ...r, chapters: c.chapters });
      rec.again();
      mine.refresh();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="hg-app__top">
        <div className="cs-crumb">
          <span className="t">Record</span>
        </div>
      </header>
      <main className="cs-stage hg-scroll" id="main">
        <div className="st-page hg-recstudio">
          <Segmented
            className="hg-seg hg-recstudio__mode"
            label="What to make"
            value={mode}
            onChange={(m: 'record' | 'demo') => {
              setMode(m);
              remember('hildegard.record.mode', m);
            }}
            options={[
              { value: 'record', label: 'Record yourself or your screen', disabled: live },
              { value: 'demo', label: 'Browser demo', disabled: live },
            ]}
          />
          {mode === 'demo' ? <BrowserDemo here={here} onKept={mine.refresh} /> : null}
          {kept && mode === 'record' ? (
            <div className="st-tile hg-banner" role="status">
              <Icon name="check" size={18} />
              <span>
                Kept with your recordings
                {kept.chapters?.length ? `, with ${kept.chapters.length} chapters` : ''}.
              </span>
            </div>
          ) : null}
          {mode === 'record' ? (
            <Recorder
              rec={rec}
              script={script}
              setScript={setScript}
              interview={interview}
              intro={<p>Nothing starts until you press Record, and nothing leaves this computer.</p>}
              footer={
                <section className="hg-rec__group" aria-labelledby={`${id}-pi`}>
                  <div className="hg-between">
                    <h3 id={`${id}-pi`} className="hg-rec__label">
                      Practice interview
                    </h3>
                    <Switch checked={practice} onChange={setPractice} label="Practice interview" />
                  </div>
                  {practice ? (
                    <label className="hg-field--block">
                      Your questions, one on each line
                      <textarea
                        className="cs-area"
                        rows={5}
                        value={typed}
                        disabled={live}
                        onChange={(e) => {
                          setTyped(e.target.value);
                          remember(QUESTIONS_KEY, e.target.value || null);
                        }}
                        placeholder={'What are you making?\nWho is it for?'}
                      />
                    </label>
                  ) : (
                    <p className="body-sm muted">
                      Questions you write show one at a time, and each starts a chapter.
                    </p>
                  )}
                </section>
              }
              review={() => (
                <div className="hg-record-actions">
                  <Button icon="rotate" onClick={rec.again} disabled={busy}>
                    Record again
                  </Button>
                  <Button icon="keep" kind="primary" onClick={() => void keep()} busy={busy}>
                    {busy ? 'Keeping…' : 'Keep'}
                  </Button>
                </div>
              )}
            />
          ) : null}
          <section aria-labelledby={`${id}-mine`} className="hg-stack">
            <h2 id={`${id}-mine`} className="st-h2">
              Your recordings
            </h2>
            {mine.list?.length ? (
              <div className="hg-recstudio__list">
                {mine.list.slice(0, 6).map((r) => (
                  <article key={r.id} className="st-tile" aria-label={recordingLabel(r)}>
                    <b className="body-sm">{recordingLabel(r)}</b>
                    {r.url ? (
                      <RecordingPlayer
                        url={r.url}
                        kind={r.kind}
                        label={recordingLabel(r)}
                        chapters={r.chapters ?? []}
                      />
                    ) : null}
                  </article>
                ))}
              </div>
            ) : (
              <p className="body-sm muted">What you keep shows here, and in Voice › Recordings for sound.</p>
            )}
          </section>
        </div>
      </main>
    </>
  );
}
