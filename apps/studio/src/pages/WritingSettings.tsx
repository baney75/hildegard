// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Settings › Writing: your own voice. Samples of what you have written, the notes an AI app keeps about how you
 * write, and what you changed in its drafts. Only you and this Hildegard’s owners can see what is here.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button, Icon, toast, toastError } from '../components/ui.tsx';
import { api, type WritingEdit, type WritingState } from '../lib/api.ts';

/** The most one sample can hold, as the server counts it. */
const SAMPLE_CHARS = 50_000;
const VOICE_CHARS = 50_000;

const day = (iso: string) =>
  new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
const words = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'word' : 'words'}`;
const quoted = (l: string[], n = 5) =>
  l.length
    ? `${l
        .slice(0, n)
        .map((x) => `“${x}”`)
        .join(', ')}${l.length > n ? `, and ${l.length - n} more` : ''}`
    : 'nothing';

function editLine(e: WritingEdit): string {
  const lint = (c: { fails: number; warns: number }) =>
    `${c.fails} fail${c.fails === 1 ? '' : 's'}, ${c.warns} warning${c.warns === 1 ? '' : 's'}`;
  return `${day(e.at)}: ${words(e.draftWords)} became ${words(e.finalWords)}. You cut ${quoted(e.removed)} and added ${quoted(e.added)}. Prose lint went from ${lint(e.lintBefore)} to ${lint(e.lintAfter)}.${e.note ? ` “${e.note}”` : ''}`;
}

export function WritingSettings() {
  const [state, setState] = useState<WritingState | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const load = useCallback(
    () =>
      api
        .writing()
        .then((s) => {
          setState(s);
          setFailed(null);
        })
        .catch((e: Error) => setFailed(e.message)),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="hg-section" aria-labelledby="wr-h">
      <h2 id="wr-h" className="st-h2">
        Writing
      </h2>
      <p className="body-sm sec-text">
        Hildegard learns how you write from your own words. An AI app reads your voice notes before it writes
        for you, and sends back what you change in its drafts, so the next one needs fewer fixes. Only you and
        this Hildegard’s owners can see these.
      </p>
      {failed ? (
        <p className="body-sm" role="alert">
          {failed}
        </p>
      ) : null}
      {state ? (
        <>
          <Samples state={state} onChange={load} />
          <Voice state={state} onChange={load} />
          <Edits state={state} />
        </>
      ) : failed ? null : (
        <p className="body-sm muted" role="status">
          Loading your writing…
        </p>
      )}
    </section>
  );
}

function Samples({ state, onChange }: { state: WritingState; onChange: () => Promise<void> }) {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [source, setSource] = useState('pasted');
  const [busy, setBusy] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const id = useId();

  const pick = async (f: File | undefined) => {
    if (!f) return;
    if (!/\.(md|markdown|txt)$/i.test(f.name) && !f.type.startsWith('text/')) {
      toast('Choose a .md or .txt file.', { tone: 'error' });
      return;
    }
    const body = await f.text();
    setText(body);
    setSource(f.name);
    if (!title.trim()) setTitle(f.name.replace(/\.[^.]+$/, ''));
  };
  const add = async () => {
    setBusy('add');
    try {
      await api.addWritingSample({ title, text, source });
      setTitle('');
      setText('');
      setSource('pasted');
      toast('Added to your samples');
      await onChange();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };
  const remove = async (s: WritingState['samples'][number]) => {
    setBusy(s.id);
    try {
      await api.removeWritingSample(s.id);
      toast(`Removed “${s.title}”`);
      await onChange();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="st-tile hg-hfway">
        <b id={`${id}-h`}>Samples of your writing</b>
        <span className="body-sm muted">
          Add things you wrote yourself: a letter, an essay, a post. Only your own words, up to{' '}
          {SAMPLE_CHARS.toLocaleString('en-US')} characters each and 200 in all.
        </span>
        <label className="hg-field hg-field--block">
          <span>Title</span>
          <input
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Letter to the parish, March"
          />
        </label>
        <label className="hg-field hg-field--block">
          <span>Your writing</span>
          <textarea
            className="cs-area"
            rows={7}
            maxLength={SAMPLE_CHARS}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setSource('pasted');
            }}
            placeholder="Paste it here, or choose a file."
          />
        </label>
        <span className="body-sm muted" aria-live="polite">
          {text.trim()
            ? `${words(text.trim().split(/\s+/).length)}, ${text.length.toLocaleString('en-US')} of ${SAMPLE_CHARS.toLocaleString('en-US')} characters`
            : ' '}
        </span>
        <div className="hg-wrap" style={{ display: 'flex', gap: 8 }}>
          <Button
            kind="primary"
            busy={busy === 'add'}
            disabled={!title.trim() || !text.trim()}
            onClick={() => void add()}
          >
            Add sample
          </Button>
          <Button kind="ghost" icon="upload" onClick={() => file.current?.click()}>
            Choose a .md or .txt file
          </Button>
          <input
            ref={file}
            type="file"
            accept=".md,.markdown,.txt,text/plain,text/markdown"
            hidden
            aria-label="Choose a .md or .txt file"
            onChange={(e) => {
              void pick(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>
      </div>

      {state.samples.length ? (
        <div className="st-tile hg-devices" role="list" aria-label="Your samples">
          {state.samples.map((s) => (
            <div className="hg-devices__row" key={s.id} role="listitem">
              <span className="st-dev__g">
                <Icon name="text" size={22} />
              </span>
              <span className="hg-devices__name">
                <b>{s.title}</b>
                <small className="body-sm muted">
                  {words(s.words)} · {s.source} · added {day(s.addedAt)}
                </small>
              </span>
              <span className="hg-devices__act">
                <Button
                  kind="ghost"
                  size="sm"
                  icon="trash"
                  aria-label={`Remove ${s.title}`}
                  busy={busy === s.id}
                  onClick={() => void remove(s)}
                />
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="body-sm muted">No samples yet.</p>
      )}
    </>
  );
}

function Voice({ state, onChange }: { state: WritingState; onChange: () => Promise<void> }) {
  const [md, setMd] = useState(state.voice.md);
  const [busy, setBusy] = useState(false);
  // An AI app can change the notes while this page is open; take its version unless there are unsaved edits.
  const base = useRef(state.voice.md);
  useEffect(() => {
    setMd((cur) => (cur === base.current ? state.voice.md : cur));
    base.current = state.voice.md;
  }, [state.voice.md]);
  const dirty = md !== state.voice.md;
  const save = async () => {
    setBusy(true);
    try {
      await api.setWritingVoice(md);
      toast('Saved your voice notes');
      await onChange();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="st-tile hg-hfway">
      <b>Your voice notes</b>
      <span className="body-sm muted">
        Short rules in your own words: what to do, what never to do, and a phrase of yours for each. An AI app
        can write these from your samples and edits; you can change them any time.
      </span>
      <label className="hg-field hg-field--block">
        <span>Voice notes</span>
        <textarea
          className="cs-area"
          rows={12}
          maxLength={VOICE_CHARS}
          value={md}
          onChange={(e) => setMd(e.target.value)}
          placeholder="Short sentences. Say it plain. Never “delve”."
        />
      </label>
      <div className="hg-wrap" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button kind="primary" busy={busy} disabled={!dirty} onClick={() => void save()}>
          Save voice notes
        </Button>
        <span className="body-sm muted">
          {state.voice.versions
            ? `${state.voice.versions} earlier ${state.voice.versions === 1 ? 'version is' : 'versions are'} kept.`
            : 'Each time you save, the version it replaces is kept.'}
          {state.voice.updatedAt ? ` Last saved ${day(state.voice.updatedAt)}.` : ''}
        </span>
      </div>
    </div>
  );
}

function Edits({ state }: { state: WritingState }) {
  return (
    <div className="st-tile hg-hfway">
      <b>What you changed in drafts</b>
      {state.edits.length ? (
        <ul className="hg-prose">
          {state.edits.map((e) => (
            <li key={e.at + e.draftWords + e.finalWords} className="body-sm">
              {editLine(e)}
            </li>
          ))}
        </ul>
      ) : (
        <span className="body-sm muted">
          Nothing yet. When you change a draft an AI app wrote, it sends both versions here.
        </span>
      )}
      {state.topCut.length ? (
        <>
          <b>Phrases you cut most often</b>
          <ul className="hg-prose">
            {state.topCut.map((p) => (
              <li key={p.phrase} className="body-sm">
                “{p.phrase}”{p.count > 1 ? `, ${p.count} times` : ''}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
