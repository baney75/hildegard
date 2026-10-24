// SPDX-License-Identifier: AGPL-3.0-only
import type { Character } from '@hildegard/presets';
import { useMemo, useState } from 'react';
import { setDraft } from '../lib/draft.ts';
import { useStore } from '../lib/store.ts';
import { canDraw, characterLine } from '../pages/Characters.tsx';
import { Button, Icon, Modal, SheetHead, toast } from './ui.tsx';

/** Characters a shot can cast at most, as the server allows. */
export const MAX_CAST = 3;
const cover = (c: Character) => (c.cover ? `/media/uploads/${c.cover}` : null);

/** Add someone to the cast, or say why not. */
export function addToCast(cast: string[], c: Character): string[] {
  if (cast.includes(c.id)) return cast;
  const ok = canDraw(c);
  if (!ok.ok) {
    toast(ok.why, { tone: 'error' });
    return cast;
  }
  if (cast.length >= MAX_CAST) {
    toast(`A shot casts up to ${MAX_CAST} characters.`, { tone: 'error' });
    return cast;
  }
  return [...cast, c.id];
}

/** Faces of the cast, where the start frame would be: the cast draws it. */
export function CastFaces({ cast, onOpen }: { cast: Character[]; onOpen: () => void }) {
  return (
    <button
      type="button"
      className="cs-attach cs-castfaces"
      aria-label={`Cast: ${cast.map((c) => c.name).join(', ')}. Change the cast`}
      onClick={onOpen}
    >
      {cast.map((c) =>
        cover(c) ? (
          <img key={c.id} src={cover(c)!} alt="" />
        ) : (
          <span key={c.id} className="ph">
            <Icon name="person" size={16} />
          </span>
        ),
      )}
      <span className="lbl">Cast</span>
    </button>
  );
}

export function CastSheet({
  cast,
  variant,
  onClose,
  go,
}: {
  cast: string[];
  variant: 'center' | 'bottom';
  onClose: () => void;
  go: (to: string) => void;
}) {
  const characters = useStore((s) => s.characters);
  const [picked, setPicked] = useState(cast.filter((id) => characters.has(id)));
  const list = useMemo(
    () => [...characters.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [characters],
  );
  const toggle = (c: Character) =>
    setPicked((p) => (p.includes(c.id) ? p.filter((x) => x !== c.id) : addToCast(p, c)));
  return (
    <Modal
      open
      onClose={onClose}
      labelledBy="cast-t"
      variant={variant === 'center' ? 'dialog' : variant}
      className="cs-sheet hg-sheet--md"
    >
      <SheetHead
        id="cast-t"
        title="Cast"
        sub={`Up to ${MAX_CAST} characters. Hildegard draws the shot’s first frame from their references, so their faces and clothes stay the same from shot to shot.`}
        onClose={onClose}
      />
      <div className="hg-sheet__body" style={{ gap: 8 }}>
        {list.length ? (
          list.map((c) => {
            const on = picked.includes(c.id);
            const ok = canDraw(c);
            return (
              <button
                key={c.id}
                type="button"
                role="checkbox"
                aria-checked={on}
                className={`cs-mi cs-castrow${on ? ' on' : ''}`}
                disabled={!on && !ok.ok}
                onClick={() => toggle(c)}
              >
                {cover(c) ? (
                  <img src={cover(c)!} alt="" />
                ) : (
                  <span className="cs-castrow__ph" aria-hidden="true">
                    <Icon name="person" size={16} />
                  </span>
                )}
                <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                  <b>{c.name}</b>
                  <small>{ok.ok ? characterLine(c) : ok.why}</small>
                </span>
                <Icon name={on ? 'check' : 'plus'} size={16} />
              </button>
            );
          })
        ) : (
          <p className="body-sm muted">
            No characters yet. Make one, keep a face you like, and cast them here or with @ in the prompt.
          </p>
        )}
      </div>
      <div className="cs-sheet__f hg-wrap">
        <Button
          kind="ghost"
          icon="person"
          onClick={() => {
            onClose();
            go('/characters');
          }}
          style={{ marginRight: 'auto' }}
        >
          Characters
        </Button>
        <Button kind="ghost" onClick={() => setPicked([])} disabled={!picked.length}>
          Clear
        </Button>
        <Button
          kind="primary"
          onClick={() => {
            setDraft(picked.length ? { cast: picked } : { cast: [] });
            onClose();
          }}
        >
          {picked.length ? `Cast ${picked.length}` : 'No cast'}
        </Button>
      </div>
    </Modal>
  );
}

/** "@ma" just before the caret: who it could be. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)@([\p{L}\p{N}'’ -]{0,30})$/u.exec(text.slice(0, caret));
  // Names can have spaces ("Brother Konrad"): the picker shows only while some name still matches.
  if (!m) return null;
  return { start: caret - m[2]!.length - 1, query: m[2]! };
}

/** The @ picker over the prompt: characters whose names match, best first. */
export function MentionPop({
  query,
  matches,
  active,
  onPick,
  onHover,
}: {
  query: string;
  matches: Character[];
  active: number;
  onPick: (c: Character) => void;
  onHover: (i: number) => void;
}) {
  return (
    <div
      className="cs-pop cs-mention"
      role="dialog"
      aria-label={`Characters matching ${query || 'anything'}`}
    >
      <div className="cs-menuh hg-between">
        <span className="ovl">Characters{query ? ` · “${query}”` : ''}</span>
        <span className="body-sm muted">↑↓ to move · Enter to cast</span>
      </div>
      <div role="listbox" id="hg-mention" aria-label="Characters">
        {matches.map((c, i) => {
          const ok = canDraw(c);
          return (
            <div
              key={c.id}
              id={`hg-mention-${i}`}
              role="option"
              tabIndex={-1}
              aria-selected={i === active}
              aria-disabled={!ok.ok || undefined}
              className={`cs-mi${i === active ? ' on' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(c);
              }}
              onMouseEnter={() => onHover(i)}
            >
              {cover(c) ? (
                <img src={cover(c)!} alt="" />
              ) : (
                <span className="cs-castrow__ph" aria-hidden="true">
                  <Icon name="person" size={16} />
                </span>
              )}
              <span style={{ flex: 1, minWidth: 0 }}>
                <b>{c.name}</b>
                <small>{ok.ok ? characterLine(c) : ok.why}</small>
              </span>
              {i === active ? <span className="kbd">Enter</span> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
