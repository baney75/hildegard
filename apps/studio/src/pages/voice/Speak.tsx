// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Text to speech: a script of paragraphs, each with a voice, an acting direction and [tags] that shape delivery and
 * are never spoken. Settings show every control, greyed out with the reason when the model doesn't honour it.
 */
import type { Voice, VoiceControl, VoiceJob, VoiceModel, VoiceState, VoiceTag } from '@hildegard/presets';
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button, Icon, LiveRing, Menu, Modal, SheetHead, Slider, toastError } from '../../components/ui.tsx';
import { Kind, Orb, PlayButton, VoiceModelsSheet } from '../../components/voice.tsx';
import { api } from '../../lib/api.ts';
import { clock } from '../../lib/format.ts';
import { useLocal, type WindowClass } from '../../lib/hooks.ts';
import { upsert } from '../../lib/store.ts';
import {
  CONTROL_NAMES,
  controlState,
  PAUSES,
  sayingSeconds,
  tagGroups,
  tokens,
  typingTag,
  usePlayer,
  voiceLine,
} from '../../lib/voice.ts';

interface Para {
  id: string;
  text: string;
  direction: string;
  /** This paragraph's voice, when it isn't the script's. */
  voice: string | null;
}
interface Settings {
  speed: number;
  expressiveness: number;
  stability: number;
  variety: number;
}
const DEFAULTS: Settings = { speed: 1, expressiveness: 0.5, stability: 0.5, variety: 0.5 };
const pid = () => Math.random().toString(36).slice(2, 10);
const blank = (): Para => ({ id: pid(), text: '', direction: '', voice: null });

const SLIDERS: Array<{
  key: keyof Settings;
  control: VoiceControl;
  ends: [string, string];
  min: number;
  max: number;
  step: number;
}> = [
  {
    key: 'expressiveness',
    control: 'expressiveness',
    ends: ['More stable', 'More expressive'],
    min: 0,
    max: 1,
    step: 0.05,
  },
  {
    key: 'stability',
    control: 'stability',
    ends: ['Looser', 'Closer to the voice'],
    min: 0,
    max: 1,
    step: 0.05,
  },
  { key: 'speed', control: 'speed', ends: ['Slower', 'Faster'], min: 0.5, max: 2, step: 0.05 },
  {
    key: 'variety',
    control: 'variety',
    ends: ['The same each time', 'More varied'],
    min: 0,
    max: 1,
    step: 0.05,
  },
];

export function Speak({
  state,
  wc,
  go,
  initialVoice,
}: {
  state: VoiceState;
  wc: WindowClass;
  go: (to: string) => void;
  initialVoice: string | null;
}) {
  const voices = state.voices;
  const usable = voices.filter((v) => v.kind !== 'clone' || v.consent?.status === 'active');
  const [voiceId, setVoiceId] = useLocal<string>('hildegard.voice.voice', usable[0]?.id ?? '');
  const [paras, setParas] = useLocal<Para[]>('hildegard.voice.script', [blank()]);
  const [settings, setSettings] = useLocal<Settings>('hildegard.voice.settings', DEFAULTS);
  const [seed, setSeed] = useLocal<number | null>('hildegard.voice.seed', null);
  const [modelPick, setModelPick] = useState<string | null>(null);
  const [jobId, setJobId] = useLocal<string | null>('hildegard.voice.job', null);
  const [tab, setTab] = useState<'settings' | 'history'>('settings');
  const [search, setSearch] = useState('');
  const [showModels, setShowModels] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showVoices, setShowVoices] = useState(false);
  const [sending, setSending] = useState(false);
  const focusNext = useRef<{ id: string; at: number } | null>(null);

  useEffect(() => {
    if (initialVoice && voices.some((v) => v.id === initialVoice)) setVoiceId(initialVoice);
  }, [initialVoice, voices, setVoiceId]);

  const voice = voices.find((v) => v.id === voiceId) ?? usable[0] ?? null;
  const byId = useMemo(() => new Map(voices.map((v) => [v.id, v])), [voices]);
  const models = state.catalog.models;
  const modelId = modelPick && voice?.models.includes(modelPick) ? modelPick : (voice?.model ?? null);
  const model = models.find((m) => m.id === modelId) ?? null;
  const modelState = state.models.find((m) => m.id === modelId);
  const job = state.jobs.find((j) => j.id === jobId) ?? null;
  const running = job && (job.status === 'queued' || job.status === 'running');
  const filled = paras.filter((p) => p.text.trim());
  const seconds = filled.reduce((n, p) => n + sayingSeconds(p.text), 0) / (settings.speed || 1);
  const speakers = [...new Set(filled.map((p) => p.voice ?? voice?.id).filter(Boolean))]
    .map((id) => byId.get(id as string)?.name)
    .filter(Boolean) as string[];
  const ready = !!voice && !!model && (state.engine.fake || !!modelState?.installed) && filled.length > 0;
  const why = !voice
    ? 'Choose a voice.'
    : !model
      ? 'No model speaks in this voice here.'
      : !(state.engine.fake || modelState?.installed)
        ? `${model.name} isn’t installed yet.`
        : !filled.length
          ? 'Write something to say.'
          : null;

  const update = (id: string, p: Partial<Para>) =>
    setParas((ps) => ps.map((x) => (x.id === id ? { ...x, ...p } : x)));

  const generate = async () => {
    if (!ready || !voice || sending) return;
    setSending(true);
    try {
      const j = await api.speak({
        paragraphs: filled.map((p) => ({
          text: p.text.trim(),
          ...(p.voice && p.voice !== voice.id ? { voice: p.voice } : {}),
          ...(p.direction.trim() ? { direction: p.direction.trim() } : {}),
        })),
        voice: voice.id,
        ...(modelPick && modelPick !== voice.model ? { model: modelPick } : {}),
        settings,
        ...(seed !== null ? { seed } : {}),
        title: filled[0]!.text
          .replace(/\[[^\]]*\]/g, '')
          .trim()
          .split(/\s+/)
          .slice(0, 8)
          .join(' '),
      });
      upsert({ type: 'voice-job', job: j });
      setJobId(j.id);
    } catch (e) {
      toastError(e);
    } finally {
      setSending(false);
    }
  };

  // Ctrl or Cmd and Enter generates from anywhere on the page.
  useEffect(() => {
    const on = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void generate();
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  });

  const player = usePlayer();
  const playingPara = (() => {
    if (!job?.segments || !job.audio[0] || player.url !== job.audio[0] || !player.playing) return -1;
    return job.segments.findIndex((s) => player.time >= s.start && player.time < s.end + 0.15);
  })();

  const list = (
    <VoiceList
      voices={voices}
      search={search}
      setSearch={setSearch}
      chosen={voice?.id ?? null}
      onChoose={(id) => {
        setVoiceId(id);
        setModelPick(null);
        setShowVoices(false);
      }}
      go={go}
    />
  );
  const inspector = (
    <Inspector
      tab={tab}
      setTab={setTab}
      state={state}
      model={model}
      voice={voice}
      modelId={modelId}
      setModel={setModelPick}
      settings={settings}
      setSettings={setSettings}
      seed={seed}
      setSeed={setSeed}
      openModels={() => setShowModels(true)}
      onOpen={(j) => setJobId(j.id)}
    />
  );
  const wide = wc === 'wide';
  const side = wc === 'wide' || wc === 'expanded';

  return (
    <div className="hg-voice">
      {side ? (
        <aside className="st-pane hg-voice__list" aria-label="Voices">
          {list}
        </aside>
      ) : null}
      <div className="hg-voice__main">
        {!wide ? (
          <div className="hg-voice__bar">
            {!side ? (
              <button type="button" className="cs-pill" onClick={() => setShowVoices(true)}>
                {voice ? <Orb hue={voice.hue} size={20} /> : null}
                {voice?.name ?? 'Choose a voice'}
                <Icon name="chevronr" size={16} />
              </button>
            ) : null}
            <span style={{ flex: 1 }} />
            <Button size="sm" icon="settings" onClick={() => setShowSettings(true)}>
              Settings
            </Button>
          </div>
        ) : null}
        <section className="st-script hg-script" aria-label="Script">
          {paras.map((p, i) => (
            <Paragraph
              key={p.id}
              para={p}
              index={i}
              voice={byId.get(p.voice ?? '') ?? voice}
              voices={usable}
              tags={state.catalog.tags}
              playing={playingPara === i}
              focus={focusNext.current?.id === p.id ? focusNext.current.at : null}
              onFocused={() => {
                focusNext.current = null;
              }}
              onChange={(x) => update(p.id, x)}
              onSplit={(before, after) => {
                const n = { ...blank(), text: after, voice: p.voice };
                focusNext.current = { id: n.id, at: 0 };
                setParas((ps) => {
                  const k = ps.findIndex((x) => x.id === p.id);
                  return [...ps.slice(0, k), { ...p, text: before }, n, ...ps.slice(k + 1)];
                });
              }}
              onJoinBack={() => {
                if (i === 0) return;
                const prev = paras[i - 1]!;
                focusNext.current = { id: prev.id, at: prev.text.length };
                setParas((ps) =>
                  ps
                    .filter((x) => x.id !== p.id)
                    .map((x) =>
                      x.id === prev.id ? { ...x, text: x.text + (x.text && p.text ? ' ' : '') + p.text } : x,
                    ),
                );
              }}
              onRemove={
                paras.length > 1 ? () => setParas((ps) => ps.filter((x) => x.id !== p.id)) : undefined
              }
            />
          ))}
          <div className="hg-script__add">
            <Button
              kind="ghost"
              size="sm"
              icon="plus"
              onClick={() => {
                const n = blank();
                focusNext.current = { id: n.id, at: 0 };
                setParas((ps) => [...ps, n]);
              }}
            >
              Add a paragraph
            </Button>
            <span className="body-sm muted">
              Type <kbd>[</kbd> for tags like <code>[whispers]</code> or <code>[pause 0.5s]</code>. They’re
              never spoken.
            </span>
          </div>
        </section>
        <div className="st-gen" role="group" aria-label="Generate">
          {running ? (
            <span className="hg-gen__ring">
              <LiveRing
                value={job.progress ? job.progress.done / Math.max(1, job.progress.total) : null}
                size={40}
              />
            </span>
          ) : (
            <PlayButton url={job?.status === 'done' ? (job.audio[0] ?? null) : null} label="the speech" />
          )}
          <div style={{ display: 'grid', gap: 2, minWidth: 0, flex: 1 }}>
            <span className="hg-gen__t">
              {running
                ? job.status === 'queued'
                  ? job.queuePosition
                    ? `Waiting · ${job.queuePosition === 1 ? 'next' : `${job.queuePosition - 1} ahead`}`
                    : 'Waiting for the GPU'
                  : job.progress
                    ? `Speaking paragraph ${Math.min(job.progress.total, job.progress.done + 1)} of ${job.progress.total}`
                    : 'Starting…'
                : `${speakers.join(' and ') || voice?.name || 'No voice'} · ${filled.length} ${filled.length === 1 ? 'paragraph' : 'paragraphs'} · about ${clock(seconds)}`}
            </span>
            <span className="st-cost">
              {job?.status === 'failed' && job.error ? (
                <span className="hg-err">{job.error.message}</span>
              ) : job?.status === 'done' && !running ? (
                <>
                  Last take {clock(job.seconds ?? 0)} ·{' '}
                  <a href={job.audio[0]} download className="hg-linkbtn">
                    Download
                  </a>
                </>
              ) : (
                <>
                  Est. <span className="num">$0.00</span> · Stays on your devices
                </>
              )}
            </span>
          </div>
          {running ? (
            <Button kind="ghost" onClick={() => api.cancelVoiceJob(job.id).catch(toastError)}>
              Cancel
            </Button>
          ) : (
            <button
              type="button"
              className="cs-create"
              onClick={() => void generate()}
              disabled={!ready || sending}
              aria-describedby={why ? 'speak-why' : undefined}
            >
              <Icon name="sparkle" size={18} />
              <span>
                <b>Generate speech</b>
                <small>{why ?? `on ${state.device}`}</small>
              </span>
            </button>
          )}
          {why ? (
            <span id="speak-why" className="sr">
              {why}
            </span>
          ) : null}
        </div>
      </div>
      {wide ? (
        <aside className="st-pane r hg-voice__insp" aria-label="Speech settings">
          {inspector}
        </aside>
      ) : null}
      <Modal
        open={showSettings && !wide}
        onClose={() => setShowSettings(false)}
        labelledBy="vset-t"
        variant="side-right"
        className="cs-sheet"
      >
        <SheetHead id="vset-t" title="Speech settings" onClose={() => setShowSettings(false)} />
        {inspector}
      </Modal>
      <Modal
        open={showVoices && !side}
        onClose={() => setShowVoices(false)}
        labelledBy="vlist-t"
        variant="bottom"
        className="cs-sheet"
      >
        <SheetHead id="vlist-t" title="Voices" onClose={() => setShowVoices(false)} />
        {list}
      </Modal>
      <VoiceModelsSheet
        open={showModels}
        onClose={() => setShowModels(false)}
        models={models}
        states={state.models}
      />
    </div>
  );
}

function VoiceList({
  voices,
  search,
  setSearch,
  chosen,
  onChoose,
  go,
}: {
  voices: Voice[];
  search: string;
  setSearch: (s: string) => void;
  chosen: string | null;
  onChoose: (id: string) => void;
  go: (to: string) => void;
}) {
  const q = search.trim().toLowerCase();
  const shown = voices.filter(
    (v) => !q || `${v.name} ${v.blurb} ${v.accent ?? ''} ${v.language}`.toLowerCase().includes(q),
  );
  return (
    <>
      <div className="st-pane__h">
        <h2>Voices</h2>
        <Menu
          label="New voice"
          icon="plus"
          size="sm"
          items={[
            { label: 'Design a voice', icon: 'sparkle', onSelect: () => go('/voice/design') },
            { label: 'Clone a voice', icon: 'mic', onSelect: () => go('/voice/clone') },
          ]}
        />
      </div>
      <label className="st-search">
        <Icon name="search" size={16} />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={`Search ${voices.length} voices`}
          aria-label="Search voices"
        />
      </label>
      <div className="st-vlist hg-scroll" role="listbox" aria-label="Voices">
        {shown.map((v) => {
          const off = v.kind === 'clone' && v.consent?.status !== 'active';
          return (
            <div
              key={v.id}
              className="st-v"
              role="option"
              tabIndex={chosen === v.id ? 0 : -1}
              aria-selected={chosen === v.id}
              aria-disabled={off || undefined}
              onClick={() => !off && onChoose(v.id)}
              onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ' ') && !off) {
                  e.preventDefault();
                  onChoose(v.id);
                }
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  const sib = (
                    e.key === 'ArrowDown'
                      ? e.currentTarget.nextElementSibling
                      : e.currentTarget.previousElementSibling
                  ) as HTMLElement | null;
                  sib?.focus();
                }
              }}
            >
              <Orb hue={v.hue} />
              <span style={{ minWidth: 0 }}>
                <b>{v.name}</b>
                <small>
                  {v.kind === 'clone' && v.consent?.relation === 'self' ? 'Your voice' : voiceLine(v)}
                </small>
              </span>
              <Kind voice={v} />
            </div>
          );
        })}
        {!shown.length ? (
          <p className="body-sm muted" style={{ padding: '8px 10px' }}>
            No voice matches “{search}”.
          </p>
        ) : null}
      </div>
    </>
  );
}

function Paragraph({
  para,
  index,
  voice,
  voices,
  tags,
  playing,
  focus,
  onFocused,
  onChange,
  onSplit,
  onJoinBack,
  onRemove,
}: {
  para: Para;
  index: number;
  voice: Voice | null;
  voices: Voice[];
  tags: VoiceTag[];
  playing: boolean;
  focus: number | null;
  onFocused: () => void;
  onChange: (p: Partial<Para>) => void;
  onSplit: (before: string, after: string) => void;
  onJoinBack: () => void;
  onRemove?: () => void;
}) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState<number | null>(null);
  const [pick, setPick] = useState(0);
  const [group, setGroup] = useState<'emotion' | 'delivery' | 'sound' | 'pause' | null>(null);
  const [voiceMenu, setVoiceMenu] = useState(false);
  const popId = useId();

  useEffect(() => {
    if (focus === null || !ta.current) return;
    ta.current.focus();
    ta.current.setSelectionRange(focus, focus);
    onFocused();
  }, [focus, onFocused]);

  const typing = caret !== null ? typingTag(para.text, caret) : null;
  const groups = tagGroups(tags);
  const q = typing?.query ?? '';
  const match = (id: string) => !q || id.startsWith(q) || id.includes(` ${q}`);
  const options: Record<'emotion' | 'delivery' | 'sound' | 'pause', string[]> = {
    emotion: groups.emotion.map((t) => t.id).filter(match),
    delivery: groups.delivery.map((t) => t.id).filter(match),
    sound: groups.sound.map((t) => t.id).filter(match),
    pause: PAUSES.filter(match),
  };
  const firstGroup =
    (['emotion', 'delivery', 'sound', 'pause'] as const).find((g) => options[g].length) ?? 'emotion';
  const g = group && options[group].length ? group : firstGroup;
  const shown = options[g];
  const open = !!typing && shown.length > 0;

  const insert = (tag: string) => {
    if (!typing) return;
    const before = para.text.slice(0, typing.start);
    const after = para.text.slice(caret ?? typing.start).replace(/^[a-z ]*\]?/i, '');
    const pad = after.startsWith(' ') || !after ? '' : ' ';
    const text = `${before}[${tag}]${pad}${after}`;
    onChange({ text });
    const at = before.length + tag.length + 2 + pad.length;
    requestAnimationFrame(() => {
      ta.current?.setSelectionRange(at, at);
      setCaret(at);
    });
    setGroup(null);
    setPick(0);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setPick((n) => (n + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length);
        return;
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const order = (['emotion', 'delivery', 'sound', 'pause'] as const).filter((x) => options[x].length);
        if (order.length > 1 && (e.altKey || q === '')) {
          e.preventDefault();
          const k = order.indexOf(g);
          setGroup(order[(k + (e.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length]!);
          setPick(0);
          return;
        }
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insert(shown[Math.min(pick, shown.length - 1)]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setCaret(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      const at = e.currentTarget.selectionStart;
      onSplit(para.text.slice(0, at).trimEnd(), para.text.slice(e.currentTarget.selectionEnd).trimStart());
      return;
    }
    if (
      e.key === 'Backspace' &&
      e.currentTarget.selectionStart === 0 &&
      e.currentTarget.selectionEnd === 0 &&
      index > 0
    ) {
      e.preventDefault();
      onJoinBack();
    }
  };

  return (
    <div className="st-para hg-para" data-playing={playing || undefined}>
      <div className="hg-menu">
        <button
          type="button"
          className="hg-para__orb"
          aria-label={`Voice for paragraph ${index + 1}: ${voice?.name ?? 'none'}`}
          aria-haspopup="listbox"
          aria-expanded={voiceMenu}
          onClick={() => setVoiceMenu((o) => !o)}
        >
          {voice ? (
            <Orb hue={voice.hue} size={36} />
          ) : (
            <span className="st-orb" style={{ width: 36, height: 36 }} />
          )}
        </button>
        {voiceMenu ? (
          <div
            className="hg-menu__list"
            role="listbox"
            aria-label={`Voice for paragraph ${index + 1}`}
            onKeyDown={(e) => e.key === 'Escape' && setVoiceMenu(false)}
          >
            {voices.map((v) => (
              <button
                key={v.id}
                type="button"
                role="option"
                aria-selected={voice?.id === v.id}
                onClick={() => {
                  onChange({ voice: v.id });
                  setVoiceMenu(false);
                }}
              >
                <Orb hue={v.hue} size={18} />
                {v.name}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="hg-para__body">
        <div className="hg-para__dir">
          <input
            className={`st-dir${para.direction ? '' : ' empty'}`}
            value={para.direction}
            maxLength={100}
            placeholder="Add a direction"
            aria-label={`Direction for paragraph ${index + 1}, like “hushed, close to the mic”`}
            onChange={(e) => onChange({ direction: e.target.value })}
          />
          {onRemove ? (
            <button
              type="button"
              className="hg-btn hg-btn--icon hg-btn--ghost hg-btn--sm hg-para__x"
              aria-label={`Remove paragraph ${index + 1}`}
              onClick={onRemove}
            >
              <Icon name="close" size={16} />
            </button>
          ) : null}
        </div>
        <div className="hg-para__ed">
          <div className="st-text hg-para__mirror" aria-hidden="true">
            {tokens(para.text).map((t, i) =>
              t.tag ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: tokens of one text, in order.
                <mark key={i} className="hg-tagmark">
                  {t.text}
                </mark>
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: tokens of one text, in order.
                <span key={i}>{t.text}</span>
              ),
            )}
            {'​'}
          </div>
          <textarea
            ref={ta}
            className="st-text hg-para__ta"
            value={para.text}
            rows={1}
            spellCheck
            placeholder={index === 0 ? 'Write what to say…' : ''}
            aria-label={`Paragraph ${index + 1}`}
            aria-autocomplete="list"
            aria-controls={open ? popId : undefined}
            onChange={(e) => {
              onChange({ text: e.target.value });
              setCaret(e.target.selectionStart);
              setPick(0);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onBlur={() => setTimeout(() => setCaret(null), 150)}
            onKeyDown={onKey}
          />
          {open ? (
            <div className="st-pop hg-tagpop" role="dialog" aria-label="Audio tags" id={popId}>
              <div className="st-pop__tabs" role="tablist">
                {(['emotion', 'delivery', 'sound', 'pause'] as const).map((x) => (
                  <button
                    key={x}
                    type="button"
                    role="tab"
                    aria-selected={g === x}
                    disabled={!options[x].length}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setGroup(x);
                      setPick(0);
                    }}
                  >
                    {x[0]!.toUpperCase() + x.slice(1)}
                  </button>
                ))}
              </div>
              <div role="listbox" aria-label={`${g} tags`}>
                {shown.slice(0, 6).map((t, i) => (
                  <div
                    key={t}
                    className={`st-opt${i === pick ? ' on' : ''}`}
                    role="option"
                    tabIndex={-1}
                    aria-selected={i === pick}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      insert(t);
                    }}
                  >
                    <span className="st-tag">{t}</span>
                    {i === pick ? <small>Enter</small> : null}
                  </div>
                ))}
              </div>
              <div className="st-opt hg-tagpop__foot">Tags shape the delivery and are never spoken.</div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Inspector({
  tab,
  setTab,
  state,
  model,
  voice,
  modelId,
  setModel,
  settings,
  setSettings,
  seed,
  setSeed,
  openModels,
  onOpen,
}: {
  tab: 'settings' | 'history';
  setTab: (t: 'settings' | 'history') => void;
  state: VoiceState;
  model: VoiceModel | null;
  voice: Voice | null;
  modelId: string | null;
  setModel: (id: string | null) => void;
  settings: Settings;
  setSettings: (s: Settings | ((p: Settings) => Settings)) => void;
  seed: number | null;
  setSeed: (s: number | null) => void;
  openModels: () => void;
  onOpen: (j: VoiceJob) => void;
}) {
  const ms = state.models.find((m) => m.id === modelId);
  const installed = state.engine.fake || !!ms?.installed;
  const history = state.jobs.filter((j) => j.kind === 'speak');
  const name = (id: string | null) => state.voices.find((v) => v.id === id)?.name ?? 'a voice';
  return (
    <div className="hg-insp">
      <div className="st-tabs" role="tablist" aria-label="Inspector">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'settings'}
          onClick={() => setTab('settings')}
        >
          Settings
        </button>
        <button type="button" role="tab" aria-selected={tab === 'history'} onClick={() => setTab('history')}>
          History{history.length ? ` · ${history.length}` : ''}
        </button>
      </div>
      {tab === 'settings' ? (
        <div className="st-body hg-scroll" role="tabpanel" aria-label="Settings">
          <div className="st-field">
            <span className="st-lbl">Model</span>
            <div className="st-model">
              <Icon name="models" size={18} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <b>{model?.name ?? 'None'}</b>
                <small>{model ? `${model.license} · ${state.device}` : 'Choose a voice first'}</small>
              </span>
              {model ? (
                installed ? (
                  ms?.fit === 'slow' ? (
                    <span className="cs-fit muted">Slow here</span>
                  ) : (
                    <span className="cs-fit ok">Ready</span>
                  )
                ) : (
                  <Button size="sm" kind="primary" icon="download" onClick={openModels}>
                    Get
                  </Button>
                )
              ) : null}
            </div>
            {voice && voice.models.length > 1 ? (
              <label className="hg-field--block">
                Speak with
                <select
                  className="hg-select"
                  value={modelId ?? ''}
                  onChange={(e) => setModel(e.target.value)}
                >
                  {voice.models.map((id) => (
                    <option key={id} value={id}>
                      {state.catalog.models.find((m) => m.id === id)?.name ?? id}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <button type="button" className="hg-linkbtn body-sm" onClick={openModels}>
              All voice models
            </button>
          </div>
          {SLIDERS.map((s) => {
            const st = model
              ? controlState(model, s.control, state.catalog.models)
              : { enabled: false, why: null };
            const v = settings[s.key];
            return (
              <fieldset
                key={s.key}
                className={`st-ctl hg-ctl${st.enabled ? '' : ' off'}`}
                disabled={!st.enabled}
              >
                <Slider
                  label={CONTROL_NAMES[s.control]}
                  value={v}
                  min={s.min}
                  max={s.max}
                  step={s.step}
                  valueText={s.key === 'speed' ? `${v.toFixed(2)} times` : `${Math.round(v * 100)} percent`}
                  ends={s.ends}
                  onChange={(n) => setSettings((p) => ({ ...p, [s.key]: n }))}
                  head={
                    <div className="st-ctl__h">
                      <b>{CONTROL_NAMES[s.control]}</b>
                      {s.key === 'speed' ? <span className="num muted">{v.toFixed(2)}×</span> : null}
                    </div>
                  }
                />
                {st.why ? (
                  <span className="st-why">
                    <Icon name="alert" size={14} /> {st.why}
                  </span>
                ) : null}
              </fieldset>
            );
          })}
          <div className="st-row2">
            <div className="st-field">
              <span className="st-lbl" id="seed-l">
                Seed
              </span>
              <div className="hg-seed">
                <button
                  type="button"
                  className="hg-btn hg-btn--icon hg-btn--ghost hg-btn--sm"
                  aria-pressed={seed !== null}
                  aria-label={
                    seed !== null
                      ? 'Unlock the seed: a new one each time'
                      : 'Lock the seed: the same take each time'
                  }
                  onClick={() => setSeed(seed === null ? Math.floor(Math.random() * 100000) : null)}
                >
                  <Icon name={seed !== null ? 'lock' : 'unlock'} size={16} />
                </button>
                <input
                  className="num"
                  inputMode="numeric"
                  aria-labelledby="seed-l"
                  value={seed ?? ''}
                  placeholder="Random"
                  onChange={(e) => {
                    const n = Number.parseInt(e.target.value, 10);
                    setSeed(Number.isFinite(n) && n >= 0 ? Math.min(n, 2 ** 32 - 1) : null);
                  }}
                />
              </div>
            </div>
            <div className="st-field">
              <span className="st-lbl">Output</span>
              <div className="hg-seed">
                <span className="body-sm">WAV · 24 kHz</span>
              </div>
            </div>
          </div>
          <p className="body-sm muted">
            Every clip carries an inaudible watermark, so anyone can check it was made with Hildegard.
          </p>
          <Button kind="ghost" size="sm" onClick={() => setSettings(DEFAULTS)}>
            Reset settings
          </Button>
        </div>
      ) : (
        <div className="st-body hg-scroll" role="tabpanel" aria-label="History" style={{ gap: 0 }}>
          {history.length ? (
            history.map((j) => (
              <div key={j.id} className="st-hrow">
                {j.status === 'done' ? (
                  <PlayButton url={j.audio[0] ?? null} label={j.title} size="sm" ghost />
                ) : (
                  <span className="st-playbtn sm ghost" aria-hidden="true">
                    <Icon name={j.status === 'failed' ? 'alert' : 'history'} size={16} />
                  </span>
                )}
                <button type="button" className="t hg-hrow__open" onClick={() => onOpen(j)}>
                  <b>{j.title}</b>
                  <small>
                    {j.status === 'done'
                      ? `${clock(j.seconds ?? 0)} · ${name(j.voice)} · ${new Date(j.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
                      : j.status === 'failed'
                        ? 'Failed'
                        : j.status === 'canceled'
                          ? 'Canceled'
                          : 'In progress'}
                    {j.source.kind === 'agent' ? ` · ${j.source.name}` : ''}
                  </small>
                </button>
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
                    j.status === 'done'
                      ? {
                          label: j.kept ? 'Don’t keep' : 'Keep',
                          icon: 'keep',
                          onSelect: () =>
                            api
                              .keepVoiceJob(j.id, !j.kept)
                              .then((x) => upsert({ type: 'voice-job', job: x }))
                              .catch(toastError),
                        }
                      : null,
                    j.status !== 'queued' && j.status !== 'running'
                      ? {
                          label: 'Delete',
                          icon: 'trash',
                          danger: true,
                          onSelect: () => api.deleteVoiceJob(j.id).catch(toastError),
                        }
                      : null,
                  ]}
                />
              </div>
            ))
          ) : (
            <p className="body-sm muted">What you generate shows here, with what each agent made.</p>
          )}
        </div>
      )}
    </div>
  );
}
