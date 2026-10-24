// SPDX-License-Identifier: AGPL-3.0-only
import type { Character, CharacterRef, CharacterView, Still } from '@hildegard/presets';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Icon,
  LiveRing,
  Menu,
  Modal,
  Segmented,
  Status,
  toast,
  toastError,
} from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import type { WindowClass } from '../lib/hooks.ts';
import { upsert, useStore } from '../lib/store.ts';
import { Secret } from './Sharing.tsx';

/** A character keeps up to this many references, as the server does. */
const MAX_REFS = 8;
const VIEWS: Array<{ view: CharacterView; name: string }> = [
  { view: 'portrait', name: 'Portrait' },
  { view: 'three-quarter', name: 'Three-quarter' },
  { view: 'profile', name: 'Profile' },
  { view: 'full-body', name: 'Full body' },
];
const viewName = (v: CharacterView | null) => VIEWS.find((x) => x.view === v)?.name ?? 'Reference';
const refUrl = (file: string) => `/media/uploads/${file}`;
const date = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';

type Voice = Awaited<ReturnType<typeof api.voices>>[number];

/** Whether a character may be drawn now: a real person only while their consent stands. */
export function canDraw(c: Character): { ok: true } | { ok: false; why: string } {
  if (c.likeness === 'real' && c.consent?.status !== 'active')
    return {
      ok: false,
      why:
        c.consent?.status === 'revoked'
          ? `${c.name}’s consent was taken back.`
          : `${c.name} hasn’t given consent yet.`,
    };
  if (!c.references.length) return { ok: false, why: `${c.name} has no references yet.` };
  return { ok: true };
}

/** Who a character is, in a line: for cards, pickers and the composer. */
export function characterLine(c: Character): string {
  if (c.likeness === 'real') {
    if (c.consent?.status === 'active') return `Real person · ${c.consent.person ?? c.name} consented`;
    if (c.consent?.status === 'revoked') return 'Real person · consent taken back';
    return 'Real person · waiting for consent';
  }
  const n = c.references.length;
  return n ? `Character · ${n} ${n === 1 ? 'reference' : 'references'}` : 'Character · no references yet';
}

export function Characters({
  wc,
  go,
  selectedParam,
}: {
  wc: WindowClass;
  go: (to: string) => void;
  selectedParam: string | null;
}) {
  const characters = useStore((s) => s.characters);
  const takes = useStore((s) => s.takes);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const selected = selectedParam ? characters.get(selectedParam) : undefined;

  const list = useMemo(
    () =>
      [...characters.values()]
        .filter((c) => !query.trim() || c.name.toLowerCase().includes(query.trim().toLowerCase()))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [characters, query],
  );
  // The shots each character is cast in, from their takes' requests.
  const cast = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const t of takes.values())
      for (const id of t.request.characters ?? []) m.set(id, (m.get(id) ?? new Set()).add(t.shotId));
    return m;
  }, [takes]);
  const inShots = (id: string) => cast.get(id)?.size ?? 0;
  const select = (id: string | null) => go(id ? `/characters/${id}` : '/characters');
  const docked = wc === 'wide' && !!selected;
  const panel = selected ? (
    <CharacterPanel
      key={selected.id}
      character={selected}
      onClose={() => select(null)}
      onDeleted={() => select(null)}
    />
  ) : null;

  return (
    <>
      <header className="hg-app__top">
        <div className="cs-crumb">
          <span className="t">Characters</span>
          <span className="s">
            {characters.size
              ? `${characters.size} ${characters.size === 1 ? 'character' : 'characters'} · the same face in every shot`
              : 'The same face and clothes in every shot'}
          </span>
        </div>
        <div className="hg-app__topactions">
          {characters.size > 3 && wc !== 'compact' ? (
            <label className="hg-search">
              <Icon name="search" size={16} />
              <span className="sr">Search characters</span>
              <input
                type="search"
                placeholder="Search characters"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
          ) : null}
          <Button kind="primary" icon="plus" onClick={() => setCreating(true)}>
            {wc === 'compact' ? null : 'New character'}
          </Button>
        </div>
      </header>
      <main className="cs-stage hg-scroll" id="main">
        <div className="st-page">
          {characters.size ? (
            <div className="cs-elgrid">
              {list.map((c) => {
                const n = inShots(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    className="cs-el"
                    aria-current={selected?.id === c.id || undefined}
                    onClick={() => select(c.id)}
                  >
                    <span className="cover">
                      {c.cover ? (
                        <img src={refUrl(c.cover)} alt="" loading="lazy" decoding="async" />
                      ) : (
                        <span className="cs-el__ph" aria-hidden="true">
                          <Icon name="person" size={24} />
                        </span>
                      )}
                    </span>
                    <span className="hg-between">
                      <h4>{c.name}</h4>
                      <span className="cs-kind">
                        <Icon name={c.likeness === 'real' ? 'shield' : 'person'} size={14} />
                        {c.likeness === 'real' ? 'Real person' : 'Character'}
                      </span>
                    </span>
                    {c.references.length > 1 ? (
                      <span className="refs" aria-hidden="true">
                        {c.references.slice(0, 6).map((r) => (
                          <img key={r.file} src={refUrl(r.file)} alt="" loading="lazy" />
                        ))}
                      </span>
                    ) : null}
                    <span className="meta">
                      {c.likeness === 'real' && c.consent?.status !== 'active' ? (
                        <span>{characterLine(c).replace(/^Real person · /, '')}</span>
                      ) : c.voice ? (
                        <span className="cs-voice">
                          <span className="cs-orb" />
                          Has a voice
                        </span>
                      ) : null}
                      <span>{n ? `in ${n} ${n === 1 ? 'shot' : 'shots'}` : 'in no shots yet'}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="hg-empty">
              <Icon name="person" size={24} />
              <b>No characters yet</b>
              <span className="body-sm muted" style={{ maxWidth: 460 }}>
                Describe someone once, pick their face from a few portraits, and Hildegard keeps them the same
                in every shot you cast them in.
              </span>
              <Button kind="primary" icon="plus" onClick={() => setCreating(true)}>
                New character
              </Button>
            </div>
          )}
        </div>
      </main>
      {docked ? <aside className="hg-insp-dock">{panel}</aside> : null}
      {!docked && selected ? (
        <Modal
          open
          onClose={() => select(null)}
          labelledBy="ch-t"
          variant={wc === 'compact' ? 'bottom' : 'side-right'}
          className="hg-insp-sheet"
        >
          <span id="ch-t" className="sr">
            {selected.name}
          </span>
          {panel}
        </Modal>
      ) : null}
      {creating ? (
        <NewCharacter
          compact={wc === 'compact'}
          onClose={() => setCreating(false)}
          onCreated={(c) => {
            setCreating(false);
            select(c.id);
          }}
        />
      ) : null}
    </>
  );
}

function NewCharacter({
  compact,
  onClose,
  onCreated,
}: {
  compact: boolean;
  onClose: () => void;
  onCreated: (c: Character) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [wardrobe, setWardrobe] = useState('');
  const [likeness, setLikeness] = useState<'invented' | 'real'>('invented');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const c = await api.createCharacter({ name, description, wardrobe, likeness });
      upsert({ type: 'character', character: c });
      // An invented character starts from four portraits to pick a face from.
      if (likeness === 'invented') {
        const r = await api.makeStills(c.id, { view: 'portrait', count: 4 }).catch((e) => {
          toastError(e);
          return null;
        });
        if (r) upsert(r.stills.map((still) => ({ type: 'still' as const, still })));
      }
      onCreated(c);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      labelledBy="nc-t"
      variant={compact ? 'bottom' : 'dialog'}
      className="st-dialog"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="st-dialog__h">
          <h2 id="nc-t">New character</h2>
        </div>
        <div className="st-dialog__b" style={{ display: 'grid', gap: 14 }}>
          <Segmented
            label="Who they are"
            value={likeness}
            onChange={setLikeness}
            options={[
              { value: 'invented', label: 'Someone invented' },
              { value: 'real', label: 'A real person' },
            ]}
          />
          {likeness === 'real' ? (
            <p className="body-sm sec-text" style={{ margin: 0 }}>
              You send them a link. On their own phone or computer they read what they’re agreeing to, take
              three photos of themselves, and agree in their own name. Hildegard draws them only from those
              photos, and they can take it back at any time.
            </p>
          ) : (
            <p className="body-sm sec-text" style={{ margin: 0 }}>
              Hildegard draws four portraits from your words. Keep the face you like, and every shot you cast
              them in starts from it.
            </p>
          )}
          <label className="hg-field hg-field--block">
            <span>Name</span>
            <input
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
              placeholder={likeness === 'real' ? 'Anna' : 'Mara'}
              data-autofocus=""
            />
          </label>
          <label className="hg-field hg-field--block">
            <span>{likeness === 'real' ? 'Description · optional' : 'Description'}</span>
            <textarea
              className="cs-area"
              rows={3}
              maxLength={600}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Early thirties, auburn side braid, light freckles, gray-green eyes"
            />
          </label>
          <label className="hg-field hg-field--block">
            <span>Outfit · optional</span>
            <input
              value={wardrobe}
              maxLength={300}
              onChange={(e) => setWardrobe(e.target.value)}
              placeholder="An undyed linen shirt and a canvas apron"
            />
          </label>
          {error ? (
            <p className="hg-err body-sm" role="alert" style={{ margin: 0 }}>
              {error}
            </p>
          ) : null}
        </div>
        <div className="st-dialog__f">
          <Button kind="ghost" onClick={onClose} style={{ marginRight: 'auto' }}>
            Cancel
          </Button>
          <Button kind="primary" type="submit" busy={busy} disabled={!name.trim()}>
            {likeness === 'invented' ? 'Create and draw portraits' : 'Create'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Editing one character: their references, the stills being drawn, words, voice, and consent for real people. */
function CharacterPanel({
  character: c,
  onClose,
  onDeleted,
}: {
  character: Character;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const allStills = useStore((s) => s.stills);
  const auth = useStore((s) => s.auth);
  const [description, setDescription] = useState(c.description);
  const [wardrobe, setWardrobe] = useState(c.wardrobe);
  const [name, setName] = useState(c.name);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState<{ name: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const real = c.likeness === 'real';
  const consented = !real || c.consent?.status === 'active';

  useEffect(() => {
    api
      .voices()
      .then(setVoices)
      .catch(() => setVoices([]));
  }, []);

  // Stills still to choose from: once kept, a still is one of the references above.
  const stills = useMemo(
    () =>
      [...allStills.values()]
        .filter((s) => s.characterId === c.id && !s.kept)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [allStills, c.id],
  );
  const settled = stills.filter((s) => s.status !== 'queued' && s.status !== 'running');
  const clear = async () => {
    for (const s of settled) {
      await api.deleteStill(s.id).catch(() => {});
      upsert({ type: 'removed', kind: 'still', id: s.id });
    }
  };
  const missing = VIEWS.filter((v) => v.view !== 'portrait' && !c.references.some((r) => r.view === v.view));
  const dirty = name !== c.name || description !== c.description || wardrobe !== c.wardrobe;

  const run = async (p: Promise<Character>) => {
    try {
      upsert({ type: 'character', character: await p });
    } catch (e) {
      toastError(e);
    }
  };
  const save = async () => {
    setSaving(true);
    await run(api.editCharacter(c.id, { name, description, wardrobe }));
    setSaving(false);
  };
  const draw = async (view: CharacterView, count = 1) => {
    try {
      const r = await api.makeStills(c.id, { view, count });
      upsert(r.stills.map((still) => ({ type: 'still' as const, still })));
    } catch (e) {
      toastError(e);
    }
  };
  const drawSheet = async () => {
    for (const v of missing) await draw(v.view);
  };
  const upload = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) return toast('Reference images up to 10 MB', { tone: 'error' });
    setUploading(true);
    try {
      const r = await api.upload(f);
      setAdding({ name: r.name });
    } catch (e) {
      toastError(e);
    } finally {
      setUploading(false);
    }
  };
  const remove = async () => {
    if (!window.confirm(`Delete ${c.name}? Their references and stills go too. Shots already made stay.`))
      return;
    try {
      await api.deleteCharacter(c.id);
      upsert({ type: 'removed', kind: 'character', id: c.id });
      onDeleted();
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <div className="cs-insp v2" role="region" aria-label={`Edit ${c.name}`}>
      <div className="cs-insp__body hg-scroll">
        <button
          type="button"
          className="hg-btn hg-btn--icon hg-btn--ghost hg-insp__close"
          aria-label="Close"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
        <div className="cs-insp__title">
          <div>
            <span className="ovl">{real ? 'Real person' : 'Editing character'}</span>
            <h3>{c.name}</h3>
          </div>
          <Menu
            label={`More for ${c.name}`}
            items={[
              c.references.length && consented
                ? {
                    label: 'Draw four more portraits',
                    icon: 'sparkle',
                    onSelect: () => void draw('portrait', 4),
                  }
                : null,
              { label: `Delete ${c.name}`, icon: 'trash', danger: true, onSelect: () => void remove() },
            ]}
          />
        </div>

        {real ? <ConsentPanel character={c} maker={auth?.person?.name ?? null} /> : null}

        <section className="cs-sec" aria-labelledby={`refs-${c.id}`}>
          <div className="cs-sec__h">
            <span className="ovl" id={`refs-${c.id}`}>
              References · {c.references.length} of {MAX_REFS}
            </span>
            <span className="body-sm muted">
              {real ? 'Only their own photos' : 'The face first, then other angles'}
            </span>
          </div>
          <div className="cs-refs">
            {c.references.map((r) => (
              <Reference
                key={r.file}
                r={r}
                cover={r.file === c.cover}
                name={c.name}
                onCover={() => void run(api.editCharacter(c.id, { cover: r.file }))}
                onRemove={r.source === 'consent' ? null : () => void run(api.removeReference(c.id, r.file))}
              />
            ))}
            {!real && c.references.length < MAX_REFS ? (
              <button
                type="button"
                className="cs-refs__add"
                aria-label="Add a reference image"
                aria-busy={uploading || undefined}
                onClick={() => file.current?.click()}
              >
                <Icon name={uploading ? 'upload' : 'plus'} size={22} />
              </button>
            ) : null}
          </div>
          <input
            ref={file}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={(e) => {
              void upload(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          {consented ? (
            <div className="hg-wrap" style={{ display: 'flex', gap: 8 }}>
              {!c.references.length && !real ? (
                <Button size="sm" icon="sparkle" onClick={() => void draw('portrait', 4)}>
                  Draw four portraits
                </Button>
              ) : null}
              {c.references.length && missing.length ? (
                <Button size="sm" icon="sparkle" onClick={() => void drawSheet()}>
                  {missing.length === 3
                    ? 'Draw the other angles'
                    : `Draw ${missing.map((m) => m.name.toLowerCase()).join(' and ')}`}
                </Button>
              ) : null}
            </div>
          ) : null}
        </section>

        {stills.length ? (
          <section className="cs-sec" aria-labelledby={`stills-${c.id}`}>
            <div className="cs-sec__h">
              <span className="ovl" id={`stills-${c.id}`}>
                Drawn for {c.name}
              </span>
              {settled.length > 1 ? (
                <button type="button" className="hg-linkbtn body-sm" onClick={() => void clear()}>
                  Discard {settled.length === stills.length ? 'all' : 'finished'}
                </button>
              ) : (
                <span className="body-sm muted">Keep the ones that look like them</span>
              )}
            </div>
            <div className="cs-stills">
              {stills.map((s) => (
                <StillCard key={s.id} still={s} />
              ))}
            </div>
          </section>
        ) : null}

        <label className="hg-field hg-field--block">
          <span>Name</span>
          <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="hg-field hg-field--block">
          <span>Description</span>
          <textarea
            className="cs-area"
            rows={3}
            maxLength={600}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label className="hg-field hg-field--block">
          <span>Outfit</span>
          <input value={wardrobe} maxLength={300} onChange={(e) => setWardrobe(e.target.value)} />
        </label>
        {dirty ? (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button
              kind="ghost"
              onClick={() => {
                setName(c.name);
                setDescription(c.description);
                setWardrobe(c.wardrobe);
              }}
            >
              Undo
            </Button>
            <Button kind="primary" busy={saving} disabled={!name.trim()} onClick={() => void save()}>
              Save
            </Button>
          </div>
        ) : null}

        <VoicePick
          character={c}
          voices={voices}
          onPick={(voice) => void run(api.editCharacter(c.id, { voice }))}
        />
      </div>
      {adding ? (
        <AddReference
          name={c.name}
          file={adding.name}
          onClose={() => setAdding(null)}
          onAdd={async (view) => {
            await run(api.addReference(c.id, adding.name, view));
            setAdding(null);
          }}
        />
      ) : null}
    </div>
  );
}

function Reference({
  r,
  cover,
  name,
  onCover,
  onRemove,
}: {
  r: CharacterRef;
  cover: boolean;
  name: string;
  onCover: () => void;
  onRemove: (() => void) | null;
}) {
  return (
    <figure className="cs-ref">
      <img src={refUrl(r.file)} alt={`${name}, ${viewName(r.view).toLowerCase()}`} loading="lazy" />
      {cover ? <span className="cs-tag">Face</span> : null}
      <figcaption className="sr">
        {viewName(r.view)}
        {r.source === 'consent' ? ', their own photo' : ''}
      </figcaption>
      <span className="cs-ref__acts">
        <Menu
          label={`${viewName(r.view)} reference`}
          size="sm"
          items={[
            cover ? null : { label: 'Use as their face', icon: 'person', onSelect: onCover },
            onRemove ? { label: 'Remove', icon: 'trash', danger: true, onSelect: onRemove } : null,
          ]}
        />
      </span>
    </figure>
  );
}

function StillCard({ still: s }: { still: Still }) {
  const live = s.status === 'running';
  const src =
    s.image ?? (live && s.previewVersion ? `/api/stills/${s.id}/preview?v=${s.previewVersion}` : null);
  const keep = async () => {
    try {
      upsert({ type: 'character', character: await api.keepStill(s.id) });
    } catch (e) {
      toastError(e);
    }
  };
  const drop = async () => {
    try {
      if (s.status === 'queued' || s.status === 'running') await api.cancelStill(s.id);
      await api.deleteStill(s.id);
      upsert({ type: 'removed', kind: 'still', id: s.id });
    } catch (e) {
      toastError(e);
    }
  };
  const label = `${viewName(s.view)} still`;
  return (
    <figure className={`cs-still${s.status === 'failed' || s.status === 'canceled' ? ' dim' : ''}`}>
      <span className="cs-still__img" style={{ aspectRatio: `${s.width} / ${s.height}` }}>
        {src ? <img src={src} alt={label} /> : null}
        {live ? (
          <span className="cs-live">
            <LiveRing value={s.progress?.value ?? null} size={40} />
          </span>
        ) : null}
      </span>
      <figcaption>
        {s.status === 'done' ? (
          <Button size="sm" kind="primary" icon="keep" onClick={() => void keep()}>
            Keep
          </Button>
        ) : s.status === 'queued' ? (
          <Status kind="queued">Waiting</Status>
        ) : live ? (
          <Status kind="running">Drawing</Status>
        ) : (
          <span className="body-sm hg-err" title={s.error?.message}>
            {s.status === 'canceled' ? 'Stopped' : (s.error?.message ?? 'Failed')}
          </span>
        )}
        <Button
          size="sm"
          kind="ghost"
          icon={s.status === 'queued' || live ? 'close' : 'trash'}
          aria-label={
            s.status === 'queued' || live
              ? `Stop this ${label.toLowerCase()}`
              : `Discard this ${label.toLowerCase()}`
          }
          onClick={() => void drop()}
        />
      </figcaption>
    </figure>
  );
}

/** An upload becomes a reference only once the person says it shows no real person: real people consent themselves. */
function AddReference({
  name,
  file,
  onClose,
  onAdd,
}: {
  name: string;
  file: string;
  onClose: () => void;
  onAdd: (view: CharacterView | null) => Promise<void>;
}) {
  const [view, setView] = useState<CharacterView | 'none'>('portrait');
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onClose={onClose} labelledBy="ar-t" variant="dialog" className="st-dialog">
      <div className="st-dialog__h">
        <h2 id="ar-t">Add a reference for {name}</h2>
      </div>
      <div className="st-dialog__b" style={{ display: 'grid', gap: 14 }}>
        <img src={refUrl(file)} alt="" className="cs-ref__preview" />
        <Segmented
          label="What it shows"
          value={view}
          onChange={setView}
          options={[
            ...VIEWS.map((v) => ({ value: v.view, label: v.name })),
            { value: 'none' as const, label: 'Other' },
          ]}
        />
        <label className="cs-check">
          <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
          <span>
            This image shows no real person, or only artwork you have the rights to. To draw a real person,
            make a character for them and let them consent themselves.
          </span>
        </label>
      </div>
      <div className="st-dialog__f">
        <Button kind="ghost" onClick={onClose} style={{ marginRight: 'auto' }}>
          Cancel
        </Button>
        <Button
          kind="primary"
          busy={busy}
          disabled={!sure}
          onClick={async () => {
            setBusy(true);
            await onAdd(view === 'none' ? null : view);
            setBusy(false);
          }}
        >
          Add reference
        </Button>
      </div>
    </Modal>
  );
}

function VoicePick({
  character: c,
  voices,
  onPick,
}: {
  character: Character;
  voices: Voice[] | null;
  onPick: (id: string | null) => void;
}) {
  const usable = (v: Voice) => v.kind !== 'clone' || v.consent?.status === 'active';
  const current = voices?.find((v) => v.id === c.voice);
  return (
    <section className="cs-sec">
      <span className="ovl">Voice · optional</span>
      {voices && !voices.length ? (
        <span className="body-sm muted">
          {c.voice
            ? 'Their voice isn’t on this Hildegard anymore.'
            : 'Make a voice in Voice, then give it to them here.'}
        </span>
      ) : (
        <label className="cs-pick">
          <span
            className="cs-orb"
            style={{
              width: 28,
              height: 28,
              flex: 'none',
              filter: current?.hue ? `hue-rotate(${current.hue}deg)` : undefined,
            }}
          />
          <span className="v">
            <b>{current?.name ?? (c.voice ? 'A voice that’s gone' : 'No voice')}</b>
            <small>
              {current ? current.blurb || 'Speaks for them in Voice' : 'Pick one to speak for them'}
            </small>
          </span>
          <select
            aria-label={`${c.name}’s voice`}
            value={c.voice ?? ''}
            disabled={!voices}
            onChange={(e) => onPick(e.target.value || null)}
          >
            <option value="">No voice</option>
            {(voices ?? []).map((v) => (
              <option key={v.id} value={v.id} disabled={!usable(v)}>
                {v.name}
                {usable(v) ? '' : ' (consent taken back)'}
              </option>
            ))}
          </select>
          <Icon name="chevronr" size={16} />
        </label>
      )}
    </section>
  );
}

/** For a real person: ask for consent with a one-time link, see where it stands, and take it back. */
function ConsentPanel({ character: c, maker }: { character: Character; maker: string | null }) {
  const [link, setLink] = useState<{ url: string; local: boolean } | null>(null);
  const [who, setWho] = useState(maker ?? '');
  const [busy, setBusy] = useState(false);
  const status = c.consent?.status ?? 'waiting';
  const ask = async () => {
    setBusy(true);
    try {
      const r = await api.askConsent(c.id, who.trim() || undefined);
      upsert({ type: 'character', character: r.character });
      setLink({ url: r.url, local: r.local });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const revoke = async () => {
    if (
      !window.confirm(
        `Take back ${c.consent?.person ?? c.name}’s consent? Hildegard stops drawing them at once and deletes their photos and the stills made from them.`,
      )
    )
      return;
    try {
      upsert({ type: 'character', character: await api.revokeConsent(c.id) });
      setLink(null);
    } catch (e) {
      toastError(e);
    }
  };

  if (status === 'active')
    return (
      <div className="cs-consent ok" role="status">
        <Icon name="shield" size={18} />
        <div>
          <b>{c.consent?.person} consented</b>
          <span className="body-sm sec-text">
            On {date(c.consent?.givenAt ?? null)}, with three photos they took themselves. They can take it
            back with their own link at any time.
          </span>
          <div className="hg-wrap" style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <a className="hg-btn hg-btn--sm hg-btn--ghost" href={`/api/characters/${c.id}/consent`} download>
              <Icon name="download" size={16} />
              Signed record
            </a>
            <Button size="sm" kind="danger" onClick={() => void revoke()}>
              Take back consent
            </Button>
          </div>
        </div>
      </div>
    );

  const head =
    status === 'revoked'
      ? `${c.consent?.person ?? c.name} took back their consent${c.consent?.revokedAt ? ` on ${date(c.consent.revokedAt)}` : ''}`
      : status === 'declined'
        ? `${c.name} said no`
        : c.consent?.expiresAt
          ? `Waiting for ${c.name}`
          : `${c.name} hasn’t consented yet`;
  return (
    <div className="cs-consent" role="status">
      <Icon name="shield" size={18} />
      <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
        <b>{head}</b>
        <span className="body-sm sec-text">
          {status === 'revoked'
            ? 'Hildegard won’t draw them, and their photos are gone. You can ask again with a new link.'
            : 'Send them a link. They read what they’re agreeing to, take three photos of themselves and agree in their own name. Until then Hildegard won’t draw them.'}
        </span>
        {link ? (
          <>
            <Secret label={`Consent link for ${c.name}`} value={link.url} />
            <span className="body-sm muted">
              Works once, for 24 hours.
              {link.local
                ? ' Only this computer can open it until Hildegard is at a link (Settings › Sharing).'
                : ' Send it to them yourself: Hildegard never sends it anywhere.'}
            </span>
          </>
        ) : (
          <form
            className="cs-consent__ask"
            onSubmit={(e) => {
              e.preventDefault();
              void ask();
            }}
          >
            {maker ? null : (
              <label className="hg-field hg-field--block">
                <span>Your name, as they’ll see it</span>
                <input value={who} maxLength={80} onChange={(e) => setWho(e.target.value)} />
              </label>
            )}
            <Button kind="primary" size="sm" icon="link" type="submit" busy={busy} disabled={!who.trim()}>
              {c.consent?.expiresAt ? 'Make a new link' : 'Make a consent link'}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
