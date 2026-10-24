// SPDX-License-Identifier: AGPL-3.0-only
/** The voice library: built-in voices, designed ones and consented clones, to preview and use. */
import type { Voice, VoiceState } from '@hildegard/presets';
import { useState } from 'react';
import { Menu, Segmented, toastError } from '../../components/ui.tsx';
import { AskName, Confirm, Kind, Orb, PlayButton } from '../../components/voice.tsx';
import { api } from '../../lib/api.ts';
import { upsert, whenVoiceJob } from '../../lib/store.ts';
import { langName, toggle, voiceLine } from '../../lib/voice.ts';

type Show = 'all' | 'mine' | 'designed' | 'clone' | 'builtin';

export function Library({ state, go }: { state: VoiceState; go: (to: string) => void }) {
  const [show, setShow] = useState<Show>('all');
  const [lang, setLang] = useState<string>('');
  const [gender, setGender] = useState<'' | 'female' | 'male'>('');
  const langs = [...new Set(state.voices.map((v) => v.language))].sort();
  const shown = state.voices.filter(
    (v) =>
      (show === 'all' || (show === 'mine' ? v.kind !== 'builtin' : v.kind === show)) &&
      (!lang || v.language === lang) &&
      (!gender || v.gender === gender),
  );
  return (
    <div className="st-page hg-library">
      <div className="hg-between hg-wrap">
        <div className="st-chipset" role="group" aria-label="Filter voices">
          <label className="st-chip hg-chipselect">
            <span className="sr">Language</span>
            <select value={lang} onChange={(e) => setLang(e.target.value)}>
              <option value="">Every language</option>
              {langs.map((l) => (
                <option key={l} value={l}>
                  {langName(l)}
                </option>
              ))}
            </select>
          </label>
          {(['female', 'male'] as const).map((g) => (
            <button
              key={g}
              type="button"
              className="st-chip"
              aria-pressed={gender === g}
              onClick={() => setGender(gender === g ? '' : g)}
            >
              {g === 'female' ? 'Female' : 'Male'}
            </button>
          ))}
        </div>
        <Segmented
          className="hg-seg"
          label="Kind of voice"
          value={show}
          onChange={setShow}
          options={[
            { value: 'all', label: 'All' },
            { value: 'mine', label: 'Mine' },
            { value: 'designed', label: 'Designed' },
            { value: 'clone', label: 'Clones' },
            { value: 'builtin', label: 'Built-in' },
          ]}
        />
      </div>
      {shown.length ? (
        <ul className="st-cardgrid hg-vgrid" aria-label="Voices">
          {shown.map((v) => (
            <VoiceCard key={v.id} v={v} go={go} />
          ))}
        </ul>
      ) : (
        <div className="hg-empty">
          <b>
            {show === 'mine' || show === 'designed' || show === 'clone'
              ? 'No voices of your own yet'
              : 'No voice matches'}
          </b>
          <span className="body-sm muted">
            Design one from a few words, or clone a voice with its owner’s recorded consent.
          </span>
        </div>
      )}
    </div>
  );
}

function VoiceCard({ v, go }: { v: Voice; go: (to: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const off = v.kind === 'clone' && v.consent?.status !== 'active';
  const preview = async () => {
    setBusy(true);
    try {
      const r = await api.previewVoice(v.id);
      if ('id' in r) upsert({ type: 'voice-job', job: r });
      const done = 'id' in r ? await whenVoiceJob(r.id) : null;
      if (done && done.status !== 'done') throw new Error(done.error?.message ?? 'The sample stopped.');
      const url = done ? done.audio[0] : 'id' in r ? null : r.audio;
      if (url) toggle(url);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="st-tile hg-vcard">
      <div className="st-tile__h">
        <Orb hue={v.hue} size={48} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <b>{v.name}</b>
          <small>{voiceLine(v)}</small>
        </span>
        <PlayButton
          url={v.preview}
          onNeed={preview}
          busy={busy}
          label={`a sample of ${v.name}`}
          size="sm"
          ghost
        />
      </div>
      <p className="body-sm sec-text hg-vcard__blurb">
        {v.kind === 'clone' && v.consent ? cloneLine(v) : v.blurb}
      </p>
      <div className="hg-between">
        <Kind voice={v} />
        <span style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          {v.kind !== 'builtin' ? (
            <Menu
              label={`More for ${v.name}`}
              size="sm"
              items={[
                v.kind === 'clone'
                  ? { label: 'Consent and uses', icon: 'shield', onSelect: () => go(`/voice/voices/${v.id}`) }
                  : null,
                {
                  label: 'Rename',
                  icon: 'pen',
                  onSelect: () => setRenaming(true),
                },
                {
                  label: 'Delete',
                  icon: 'trash',
                  danger: true,
                  onSelect: () => setDeleting(true),
                },
              ]}
            />
          ) : null}
          <button
            type="button"
            className="hg-btn hg-btn--ghost hg-btn--sm"
            disabled={off}
            onClick={() => go(`/voice/speak/${v.id}`)}
          >
            Use voice<span className="sr"> {v.name}</span>
          </button>
        </span>
      </div>
      {renaming ? (
        <AskName
          title="Rename this voice"
          initial={v.name}
          action="Rename"
          onClose={() => setRenaming(false)}
          onSubmit={async (name) => {
            await api.renameVoice(v.id, name);
            setRenaming(false);
          }}
        />
      ) : null}
      {deleting ? (
        <Confirm
          title={`Delete ${v.name}?`}
          body={
            v.kind === 'clone'
              ? 'Its reference recordings are deleted, so it can’t speak again. Its consent record and what you already made stay.'
              : 'What you already made with it stays.'
          }
          action="Delete voice"
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            await api.deleteVoice(v.id);
            setDeleting(false);
          }}
        />
      ) : null}
    </li>
  );
}

function cloneLine(v: Voice): string {
  const c = v.consent!;
  const when = new Date(c.recordedAt).toLocaleDateString([], { month: 'short', day: 'numeric' });
  if (c.status === 'revoked') return `${c.speaker} revoked consent. It can’t speak any more.`;
  if (c.status === 'expired') return `The license from ${c.speaker} has ended.`;
  if (c.relation === 'self') return `Your voice, recorded ${when}`;
  if (c.relation === 'licensed')
    return `Licensed from ${c.speaker}${c.until ? ` until ${new Date(c.until).toLocaleDateString([], { month: 'short', year: 'numeric' })}` : ''}`;
  return `${c.speaker} agreed on ${when}`;
}
