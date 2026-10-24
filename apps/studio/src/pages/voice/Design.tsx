// SPDX-License-Identifier: AGPL-3.0-only
/** Design a voice from words: three candidates to hear side by side, and keep the ones you like. */
import type { VoiceState } from '@hildegard/presets';
import { useState } from 'react';
import { Button, Icon, LiveRing, toastError } from '../../components/ui.tsx';
import { AskName, Orb, PlayButton, VoiceModelsSheet, Wave } from '../../components/voice.tsx';
import { api } from '../../lib/api.ts';
import { useLocal } from '../../lib/hooks.ts';
import { upsert } from '../../lib/store.ts';
import { langName } from '../../lib/voice.ts';

const LINE = 'The hill was too steep for a convent, they said. She built one anyway.';
const DESIGNER = 'qwen3-tts-design';

export function Design({ state, go }: { state: VoiceState; go: (to: string) => void }) {
  const [description, setDescription] = useLocal('hildegard.voice.design', '');
  const [line, setLine] = useLocal('hildegard.voice.designLine', LINE);
  const [language, setLanguage] = useLocal('hildegard.voice.designLang', 'en');
  const [jobId, setJobId] = useLocal<string | null>('hildegard.voice.designJob', null);
  const [editingLine, setEditingLine] = useState(false);
  const [sending, setSending] = useState(false);
  const [keeping, setKeeping] = useState<number | null>(null);
  const [kept, setKept] = useLocal<Record<string, Record<number, string>>>('hildegard.voice.kept', {});
  const [discarded, setDiscarded] = useState<Set<number>>(new Set());
  const [showModels, setShowModels] = useState(false);
  const model =
    state.catalog.models.find((m) => m.id === DESIGNER) ??
    state.catalog.models.find((m) => m.can.includes('design'));
  const ms = state.models.find((m) => m.id === model?.id);
  const installed = state.engine.fake || !!ms?.installed;
  const job = state.jobs.find((j) => j.id === jobId) ?? null;
  const running = job && (job.status === 'queued' || job.status === 'running');
  const keptHere = (job && kept[job.id]) || {};

  const design = async () => {
    if (!description.trim() || sending) return;
    setSending(true);
    try {
      const j = await api.designVoice({
        description: description.trim(),
        text: line.trim() || LINE,
        language,
        candidates: 3,
      });
      upsert({ type: 'voice-job', job: j });
      setJobId(j.id);
      setDiscarded(new Set());
    } catch (e) {
      toastError(e);
    } finally {
      setSending(false);
    }
  };

  const letters = ['A', 'B', 'C'];
  const candidates = job?.status === 'done' ? job.audio : [];
  return (
    <div className="st-page hg-design">
      <div className="hg-design__h">
        <h2 className="st-h1">Three voices from your words</h2>
        <span className="st-lead">Keep the ones you like. Discarded voices are gone for good.</span>
      </div>
      {running ? (
        <div className="st-tile hg-design__wait" role="status">
          <LiveRing
            value={job.progress ? job.progress.done / Math.max(1, job.progress.total) : null}
            size={40}
          />
          <span>
            <b>{job.status === 'queued' ? 'Waiting for the GPU' : 'Designing three voices…'}</b>
            <small className="body-sm muted">
              {job.status === 'queued' ? 'A render is finishing first.' : 'Each says your preview line.'}
            </small>
          </span>
          <Button kind="ghost" onClick={() => api.cancelVoiceJob(job.id).catch(toastError)}>
            Cancel
          </Button>
        </div>
      ) : job?.status === 'failed' && job.error ? (
        <div className="st-tile hg-banner" role="alert">
          <Icon name="alert" size={18} />
          <span>
            {job.error.message} {job.error.hint}
          </span>
        </div>
      ) : null}
      {candidates.length ? (
        <ul className="hg-cands" aria-label="Candidates">
          {candidates.map((url, i) => {
            const n = i + 1;
            if (discarded.has(n)) return null;
            const voiceId = keptHere[n];
            const name = voiceId
              ? (state.voices.find((v) => v.id === voiceId)?.name ?? `Candidate ${letters[i]}`)
              : `Candidate ${letters[i]}`;
            return (
              <li key={url} className={`st-tile hg-cand${voiceId ? ' on' : ''}`}>
                <div className="st-tile__h">
                  <Orb hue={(job!.seed ?? 0) * 37 + i * 120} size={44} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <b className="hg-cand__n">{name}</b>
                    <small>{description.slice(0, 60)}</small>
                  </span>
                  {voiceId ? <span className="cs-fit ok">Kept</span> : null}
                </div>
                <div className="hg-clip">
                  <PlayButton url={url} label={name} />
                  <Wave url={url} />
                </div>
                {voiceId ? (
                  <div className="st-row2">
                    <Button onClick={() => go(`/voice/voices`)}>In your library</Button>
                    <Button kind="primary" onClick={() => go(`/voice/speak/${voiceId}`)}>
                      Use voice
                    </Button>
                  </div>
                ) : (
                  <div className="st-row2">
                    <Button kind="ghost" onClick={() => setDiscarded((d) => new Set(d).add(n))}>
                      Discard
                    </Button>
                    <Button icon="keep" onClick={() => setKeeping(n)}>
                      Keep
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="st-tile hg-design__line">
        <Icon name="type" size={18} />
        {editingLine ? (
          <input
            value={line}
            maxLength={600}
            aria-label="Preview line"
            onChange={(e) => setLine(e.target.value)}
            onBlur={() => setEditingLine(false)}
            onKeyDown={(e) => e.key === 'Enter' && setEditingLine(false)}
            // biome-ignore lint/a11y/noAutofocus: opened by the person to edit the line.
            autoFocus
          />
        ) : (
          <button type="button" className="hg-linkbtn hg-design__linet" onClick={() => setEditingLine(true)}>
            “{line || LINE}”
          </button>
        )}
        <span className="body-sm muted">Preview line</span>
      </div>
      <div className="hg-design__prompt">
        <form
          className="st-tile hg-design__box"
          onSubmit={(e) => {
            e.preventDefault();
            void design();
          }}
        >
          <textarea
            value={description}
            maxLength={500}
            rows={2}
            aria-label="Describe the voice"
            placeholder="A weathered old monk with a low, gravelly voice and a gentle Rhineland accent. He speaks slowly and kindly."
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void design();
              }
            }}
          />
          <div className="hg-between hg-wrap">
            <div className="hg-pills">
              <button type="button" className="cs-pill" onClick={() => setShowModels(true)}>
                <Icon name="models" size={16} />
                {model?.name ?? 'No model'}
                {!installed ? <span className="cs-fit muted">Get</span> : null}
              </button>
              <label className="cs-pill hg-chipselect">
                <Icon name="translate" size={16} />
                <span className="sr">Language</span>
                <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                  {(model?.languages.length ? model.languages : ['en']).map((l) => (
                    <option key={l} value={l}>
                      {langName(l)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <button
              type="submit"
              className="cs-create"
              disabled={!description.trim() || !installed || sending || !!running}
            >
              <Icon name="sparkle" size={18} />
              <span>
                <b>Design 3 voices</b>
                <small>{installed ? `on ${state.device}` : `Get ${model?.name ?? 'the model'} first`}</small>
              </span>
            </button>
          </div>
        </form>
        <p className="st-cost body-sm muted">
          Est. <span className="num">$0.00</span> · Stays on your devices
        </p>
      </div>
      {keeping !== null && job ? (
        <AskName
          title="Keep this voice"
          sub="It joins your library, ready to speak any script."
          initial={
            description.split(/[,.]/)[0]!.replace(/^an? /i, '').slice(0, 40) ||
            `Voice ${letters[keeping - 1]}`
          }
          action="Keep voice"
          onClose={() => setKeeping(null)}
          onSubmit={async (name) => {
            const v = await api.keepDesign(job.id, keeping, name);
            setKept((k) => ({ ...k, [job.id]: { ...(k[job.id] ?? {}), [keeping]: v.id } }));
            setKeeping(null);
          }}
        />
      ) : null}
      <VoiceModelsSheet
        open={showModels}
        onClose={() => setShowModels(false)}
        models={state.catalog.models}
        states={state.models}
      />
    </div>
  );
}
