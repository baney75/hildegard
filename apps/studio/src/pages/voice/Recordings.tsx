// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Work on a recording: transcribe it with word timings, say it again in another voice, dub it into another
 * language, or check whether Hildegard made it.
 */
import type { VoiceJob, VoiceState } from '@hildegard/presets';
import { useState } from 'react';
import { Button, Icon, LiveRing, Menu, Segmented, toastError } from '../../components/ui.tsx';
import { Clip, DropAudio, PlayButton } from '../../components/voice.tsx';
import { type AudioUpload, api } from '../../lib/api.ts';
import { clock } from '../../lib/format.ts';
import { useLocal } from '../../lib/hooks.ts';
import { upsert } from '../../lib/store.ts';
import { LANGS, langName } from '../../lib/voice.ts';
import { IsOurs } from './Clone.tsx';

type Action = 'transcribe' | 'convert' | 'dub';
const KINDS = new Set(['transcribe', 'convert', 'dub']);
const DUB_LANGS = ['en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'zh', 'ko', 'hi', 'nl', 'pl', 'ru', 'ar', 'tr'];

export function Recordings({ state }: { state: VoiceState }) {
  const [file, setFile] = useLocal<(AudioUpload & { label: string }) | null>(
    'hildegard.voice.recording',
    null,
  );
  const [action, setAction] = useState<Action>('transcribe');
  const [voice, setVoice] = useState(
    state.voices.find((v) => v.kind !== 'builtin')?.id ?? state.voices[0]?.id ?? '',
  );
  const [language, setLanguage] = useState('');
  const [dubTo, setDubTo] = useState('es');
  const [busy, setBusy] = useState(false);
  const jobs = state.jobs.filter((j) => KINDS.has(j.kind));
  const usable = state.voices.filter((v) => v.kind !== 'clone' || v.consent?.status === 'active');

  const run = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const j =
        action === 'transcribe'
          ? await api.transcribe(file.name, language || undefined)
          : action === 'convert'
            ? await api.convertVoice(file.name, voice)
            : await api.dub(file.name, dubTo, voice);
      upsert({ type: 'voice-job', job: j });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="st-page hg-recs">
      <div className="hg-recs__grid">
        <section className="st-tile hg-recs__work" aria-labelledby="rec-h">
          <h2 id="rec-h" className="st-h2">
            A recording
          </h2>
          {file ? (
            <div className="hg-stack">
              <div className="hg-between">
                <b className="body-sm" style={{ overflowWrap: 'anywhere' }}>
                  {file.label}
                </b>
                <Button size="sm" kind="ghost" onClick={() => setFile(null)}>
                  Change
                </Button>
              </div>
              <Clip url={file.url} label={file.label} seconds={file.seconds} />
            </div>
          ) : (
            <DropAudio onUploaded={(u, f) => setFile({ ...u, label: f.name })} />
          )}
          <Segmented
            className="hg-seg hg-seg--fill"
            label="What to do"
            value={action}
            onChange={setAction}
            options={[
              { value: 'transcribe', label: 'Transcribe' },
              { value: 'convert', label: 'Change the voice' },
              { value: 'dub', label: 'Dub' },
            ]}
          />
          {action === 'transcribe' ? (
            <label className="hg-field--block">
              Language
              <select className="hg-select" value={language} onChange={(e) => setLanguage(e.target.value)}>
                <option value="">Find out by listening</option>
                {Object.keys(LANGS).map((l) => (
                  <option key={l} value={l}>
                    {langName(l)}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className={action === 'dub' ? 'st-row2' : undefined}>
              <label className="hg-field--block">
                {action === 'dub' ? 'Voice of the dub' : 'Say it in'}
                <select className="hg-select" value={voice} onChange={(e) => setVoice(e.target.value)}>
                  {usable.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </label>
              {action === 'dub' ? (
                <label className="hg-field--block">
                  Into
                  <select className="hg-select" value={dubTo} onChange={(e) => setDubTo(e.target.value)}>
                    {DUB_LANGS.map((l) => (
                      <option key={l} value={l}>
                        {langName(l)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
          )}
          <p className="body-sm muted">
            {action === 'transcribe'
              ? 'Whisper writes it down with the time of every word.'
              : action === 'convert'
                ? 'The same words, timing and feeling, in another voice.'
                : 'Hildegard transcribes it, translates each line with a local model, and voices it over the original.'}
          </p>
          <Button
            kind="primary"
            size="lg"
            onClick={run}
            busy={busy}
            disabled={!file || (action !== 'transcribe' && !voice)}
          >
            {action === 'transcribe'
              ? 'Transcribe'
              : action === 'convert'
                ? 'Change the voice'
                : `Dub into ${langName(dubTo)}`}
          </Button>
        </section>
        <IsOurs />
      </div>
      <section aria-labelledby="recjobs-h" className="hg-stack">
        <h2 id="recjobs-h" className="st-h2">
          Results
        </h2>
        {jobs.length ? (
          jobs.map((j) => <Result key={j.id} j={j} state={state} />)
        ) : (
          <p className="body-sm muted">Transcripts, voice changes and dubs show here.</p>
        )}
      </section>
    </div>
  );
}

function Result({ j, state }: { j: VoiceJob; state: VoiceState }) {
  const [open, setOpen] = useState(false);
  const running = j.status === 'queued' || j.status === 'running';
  const voiceName = state.voices.find((v) => v.id === j.voice)?.name;
  const t = j.transcript;
  return (
    <article className="st-tile hg-result" aria-label={j.title}>
      <div className="hg-result__h">
        {running ? (
          <LiveRing value={j.progress ? j.progress.done / Math.max(1, j.progress.total) : null} size={32} />
        ) : j.audio[0] ? (
          <PlayButton url={j.audio[0]} label={j.title} size="sm" ghost />
        ) : (
          <span className="st-playbtn sm ghost" aria-hidden="true">
            <Icon name={j.status === 'failed' ? 'alert' : 'text'} size={16} />
          </span>
        )}
        <span style={{ flex: 1, minWidth: 0 }}>
          <b>{j.title}</b>
          <small className="body-sm muted">
            {running
              ? j.status === 'queued'
                ? 'Waiting'
                : 'Working…'
              : j.status === 'failed'
                ? (j.error?.message ?? 'Failed')
                : j.status === 'canceled'
                  ? 'Canceled'
                  : [
                      j.kind === 'transcribe' ? 'Transcript' : j.kind === 'dub' ? 'Dub' : 'New voice',
                      voiceName,
                      j.seconds ? clock(j.seconds) : null,
                      t ? langName(t.language) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
          </small>
        </span>
        {running ? (
          <Button size="sm" kind="ghost" onClick={() => api.cancelVoiceJob(j.id).catch(toastError)}>
            Cancel
          </Button>
        ) : (
          <>
            {t ? (
              <Button size="sm" kind="ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
                {open ? 'Hide' : 'Show'} transcript
              </Button>
            ) : null}
            <Menu
              label={`More for ${j.title}`}
              size="sm"
              items={[
                j.audio[0]
                  ? {
                      label: 'Download',
                      icon: 'download',
                      onSelect: () => {
                        const a = document.createElement('a');
                        a.href = j.audio[0]!;
                        a.download = `${j.title}.wav`;
                        a.click();
                      },
                    }
                  : null,
                t
                  ? {
                      label: 'Copy the text',
                      icon: 'copy',
                      onSelect: () =>
                        navigator.clipboard
                          .writeText(t.segments.map((s) => s.text).join('\n'))
                          .catch(toastError),
                    }
                  : null,
                {
                  label: 'Delete',
                  icon: 'trash',
                  danger: true,
                  onSelect: () => api.deleteVoiceJob(j.id).catch(toastError),
                },
              ]}
            />
          </>
        )}
      </div>
      {open && t ? (
        <ol className="hg-transcript">
          {t.segments.map((s) => (
            <li key={`${s.start}-${s.end}`}>
              <span className="num muted">{clock(s.start)}</span>
              <span>{s.text}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </article>
  );
}
