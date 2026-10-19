// SPDX-License-Identifier: AGPL-3.0-only
import type { Catalog, Take } from '@hildegard/presets';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Board, EmptyHero } from '../components/Board.tsx';
import { Composer } from '../components/Composer.tsx';
import { ExportDialog, useChosenTakes } from '../components/ExportDialog.tsx';
import { ForceDialog } from '../components/ForceDialog.tsx';
import { Inspector } from '../components/Inspector.tsx';
import { takeLabel } from '../components/TakeCard.tsx';
import { Button, Menu, Modal, toastError } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { estimateMs, leftMs, roman } from '../lib/format.ts';
import { useLocal, useNow, type WindowClass } from '../lib/hooks.ts';
import { upsert, useStore } from '../lib/store.ts';

export function Cinema({
  catalog,
  wc,
  go,
  projectParam,
  takeParam,
}: {
  catalog: Catalog;
  wc: WindowClass;
  go: (to: string) => void;
  projectParam: string | null;
  takeParam: string | null;
}) {
  const projects = useStore((s) => s.projects);
  const shots = useStore((s) => s.shots);
  const takes = useStore((s) => s.takes);
  const [lastProject, setLastProject] = useLocal<string | null>('hildegard.project', null);
  const [selected, setSelected] = useState<string | null>(null);
  const [forcing, setForcing] = useState<string | null>(null);
  const [scrollTo, setScrollTo] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [exporting, setExporting] = useState(false);

  const project = useMemo(() => {
    const byId = projectParam ?? lastProject;
    if (byId && projects.has(byId)) return projects.get(byId)!;
    return [...projects.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
  }, [projects, projectParam, lastProject]);

  useEffect(() => {
    if (project && project.id !== lastProject) setLastProject(project.id);
  }, [project, lastProject, setLastProject]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the link changes, not on every take update
  useEffect(() => {
    if (takeParam) {
      setSelected(takeParam);
      setScrollTo(takes.get(takeParam)?.shotId ?? null);
    }
  }, [takeParam]);

  // A selection that no longer exists (deleted elsewhere) clears itself.
  const take = selected ? takes.get(selected) : undefined;
  useEffect(() => {
    if (selected && !takes.has(selected)) setSelected(null);
  }, [selected, takes]);

  const anyRunning = useMemo(() => [...takes.values()].some((t) => t.status === 'running'), [takes]);
  const now = useNow(anyRunning, 1000);
  const left = useCallback((t: Take) => leftMs(t, estimateMs(takes.values(), t), now), [takes, now]);

  const prompt = () => document.getElementById('hg-prompt')?.focus();
  const frame = () => document.querySelector<HTMLButtonElement>('.cs-attach')?.click();

  // F forces the selected waiting take; Escape clears the selection.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, dialog, [contenteditable]')) return;
      if (e.key === 'f' && !e.metaKey && !e.ctrlKey && take?.status === 'queued') setForcing(take.id);
      if (e.key === 'Escape' && selected && wc === 'wide') setSelected(null);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [take, selected, wc]);

  const shotCount = project?.shotIds.length ?? 0;
  const chosen = useChosenTakes(project ?? null);
  const shotIndex = take ? (project?.shotIds.indexOf(take.shotId) ?? -1) + 1 : 0;
  const ambient = useMemo(() => {
    const t = take?.poster
      ? take
      : [...takes.values()].reverse().find((x) => x.projectId === project?.id && x.poster);
    return t?.poster ?? null;
  }, [take, takes, project]);

  const docked = wc === 'wide' && !!take;
  const forceTake = forcing ? takes.get(forcing) : undefined;

  const inspector = take ? (
    <Inspector
      take={take}
      shot={shots.get(take.shotId)}
      shotNo={shotIndex}
      catalog={catalog}
      left={left(take)}
      onForce={setForcing}
      onSelect={setSelected}
      onClose={() => setSelected(null)}
      focusPrompt={() => {
        if (wc !== 'wide') setSelected(null);
        setTimeout(prompt, 0);
      }}
    />
  ) : null;

  return (
    <>
      <header className="hg-app__top">
        <div className="cs-crumb">
          <span className="t">{project?.title ?? 'Untitled film'}</span>
          <span className="s">
            {shotCount ? `${shotCount} ${shotCount === 1 ? 'shot' : 'shots'}` : 'No shots yet'}
          </span>
        </div>
        <div className="hg-app__topactions">
          {project && shotCount ? (
            <Button
              icon="film"
              onClick={() => setExporting(true)}
              disabled={!chosen.length}
              title={chosen.length ? undefined : 'Export film: no shot has a finished take yet'}
              aria-label={wc === 'compact' ? 'Export film' : undefined}
            >
              {wc === 'compact' ? null : 'Export film'}
            </Button>
          ) : null}
          <Menu
            label="Films: rename, start a new film, switch films"
            items={[
              project ? { label: 'Rename this film', icon: 'pen', onSelect: () => setRenaming(true) } : null,
              {
                label: 'Start a new film',
                icon: 'plus',
                onSelect: () =>
                  api
                    .createProject()
                    .then((p) => {
                      upsert({ type: 'project', project: p });
                      setSelected(null);
                      go(`/film/${p.id}`);
                    })
                    .catch(toastError),
              },
              ...[...projects.values()]
                .filter((p) => p.id !== project?.id)
                .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                .slice(0, 8)
                .map((p) => ({
                  label: `Open ${p.title}`,
                  icon: 'film',
                  onSelect: () => {
                    setSelected(null);
                    go(`/film/${p.id}`);
                  },
                })),
            ]}
          />
        </div>
      </header>
      <main className="cs-stage" id="main">
        {ambient ? <div className="cs-ambient" style={{ backgroundImage: `url(${ambient})` }} /> : null}
        {project && shotCount ? (
          <Board
            project={project}
            selected={selected}
            leftMs={left}
            scrollTo={scrollTo}
            onSelect={setSelected}
            onForce={setForcing}
          />
        ) : (
          <EmptyHero onStart={prompt} onFrame={frame} />
        )}
        <div className="cs-fade" />
        <Composer
          catalog={catalog}
          projectId={project?.id ?? null}
          wc={wc}
          go={go}
          onCreated={(shotId, takeId) => {
            setScrollTo(shotId);
            if (wc === 'wide' && takeId) setSelected(takeId);
            const p = [...projects.values()].find((x) => x.shotIds.includes(shotId));
            if (p && p.id !== project?.id) go(`/film/${p.id}`);
          }}
        />
      </main>
      {docked ? <aside className="hg-insp-dock">{inspector}</aside> : null}
      {!docked && take ? (
        <Modal
          open
          onClose={() => setSelected(null)}
          labelledBy="insp-t"
          variant={wc === 'compact' ? 'bottom' : 'side-right'}
          className="hg-insp-sheet"
        >
          <span id="insp-t" className="sr">
            Shot {roman(shotIndex)} · {takeLabel(take)}
          </span>
          {inspector}
        </Modal>
      ) : null}
      {exporting && project ? (
        <ExportDialog project={project} compact={wc === 'compact'} onClose={() => setExporting(false)} />
      ) : null}
      {forceTake ? (
        <ForceDialog
          take={forceTake}
          title={`${shots.get(forceTake.shotId)?.title ?? 'this take'} · ${takeLabel(forceTake)}`}
          compact={wc === 'compact'}
          onClose={() => setForcing(null)}
        />
      ) : null}
      {renaming && project ? (
        <RenameDialog
          title={project.title}
          onClose={() => setRenaming(false)}
          onSave={(t) =>
            api.renameProject(project.id, t).then((p) => upsert({ type: 'project', project: p }))
          }
        />
      ) : null}
    </>
  );
}

function RenameDialog({
  title,
  onClose,
  onSave,
}: {
  title: string;
  onClose: () => void;
  onSave: (t: string) => Promise<unknown>;
}) {
  const [value, setValue] = useState(title);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.select(), []);
  const save = async () => {
    if (!value.trim()) return;
    setBusy(true);
    try {
      await onSave(value.trim());
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} labelledBy="rn-t" variant="dialog" className="st-dialog">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="st-dialog__h">
          <h2 id="rn-t">Rename this film</h2>
        </div>
        <div className="st-dialog__b">
          <label className="hg-field hg-field--block">
            <span>Title</span>
            <input
              ref={input}
              value={value}
              maxLength={120}
              onChange={(e) => setValue(e.target.value)}
              data-autofocus=""
            />
          </label>
        </div>
        <div className="st-dialog__f">
          <Button kind="ghost" onClick={onClose} style={{ marginRight: 'auto' }}>
            Cancel
          </Button>
          <Button kind="primary" type="submit" busy={busy} disabled={!value.trim()}>
            Rename
          </Button>
        </div>
      </form>
    </Modal>
  );
}
