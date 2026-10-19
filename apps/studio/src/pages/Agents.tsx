// SPDX-License-Identifier: AGPL-3.0-only
import type { AgentInfo, AgentsResponse, Take } from '@hildegard/presets';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { Button, Icon, Modal, Status, type StatusKind, toast, toastError } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import type { WindowClass } from '../lib/hooks.ts';
import { useStore } from '../lib/store.ts';

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const STATUS: Record<Take['status'], [StatusKind, string]> = {
  queued: ['queued', 'Queued'],
  running: ['running', 'Rendering'],
  done: ['done', 'Done'],
  failed: ['error', 'Failed'],
  canceled: ['idle', 'Stopped'],
};
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

function useAgents() {
  const [data, setData] = useState<AgentsResponse | null>(null);
  const refresh = useCallback(() => api.agents().then(setData).catch(toastError), []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { data, setData, refresh };
}

export function Agents({ wc }: { wc: WindowClass }) {
  const { data, setData } = useAgents();
  const [linking, setLinking] = useState(false);
  const takes = useStore((s) => s.takes);
  const work = useMemo(
    () =>
      [...takes.values()]
        .filter((t): t is Take & { source: { kind: 'agent'; name: string } } => t.source.kind === 'agent')
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 40),
    [takes],
  );
  const linked = data?.agents.filter((a) => a.connected) ?? [];
  const today = new Date();

  const toggle = async (a: AgentInfo, link: boolean) => {
    try {
      const r = await api.linkAgent(a.id, link);
      setData((d) => (d ? { ...d, agents: r.agents } : d));
      toast(r.step.detail.split('\n')[0] ?? '', {
        tone: r.step.status === 'needs-owner' ? 'error' : undefined,
      });
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <>
      <header className="hg-app__top">
        <div className="cs-crumb">
          <span className="t">Agents</span>
          <span className="s">{data ? (linked.length ? `${linked.length} linked` : 'None linked') : ''}</span>
        </div>
        <div className="hg-app__topactions">
          <Button icon="plus" onClick={() => setLinking(true)}>
            {wc === 'compact' ? 'Link' : 'Link an app'}
          </Button>
        </div>
      </header>
      <main className="cs-stage hg-scroll" id="main">
        <div className="st-page">
          <p className="body sec-text hg-measure">
            AI apps like Claude Code and Codex can direct shots here, on your own GPU, as tools. They see your
            films and takes, and nothing they make costs money.
          </p>

          <section className="hg-section" aria-labelledby="ag-linked">
            <h2 id="ag-linked" className="st-h2">
              Linked apps
            </h2>
            {!data ? (
              <div className="st-tile body-sm muted">Looking for AI apps on this computer…</div>
            ) : linked.length ? (
              <div className="hg-stack">
                {linked.map((a) => (
                  <div key={a.id} className="st-tile hg-linked">
                    <span className="st-dev__g">
                      <Icon name="agent" size={22} />
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <b>{a.name}</b>
                      <small className="body-sm muted hg-path">{a.file}</small>
                    </span>
                    <Button kind="ghost" onClick={() => toggle(a, false)} disabled={!data.local}>
                      Unlink
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="st-tile hg-empty-tile">
                <span className="body-sm sec-text">No apps linked yet.</span>
                <Button kind="primary" icon="plus" onClick={() => setLinking(true)}>
                  Link an app
                </Button>
              </div>
            )}
          </section>

          <section className="hg-section" aria-labelledby="ag-work">
            <h2 id="ag-work" className="st-h2">
              What agents made
            </h2>
            {work.length ? (
              <ul className="hg-activity st-tile">
                {work.map((t) => (
                  <li key={t.id}>
                    <time className="num muted body-sm" dateTime={t.createdAt}>
                      {sameDay(new Date(t.createdAt), today)
                        ? time(t.createdAt)
                        : new Date(t.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                    </time>
                    <a href={`#/film/${t.projectId}/take/${t.id}`}>
                      <b>{t.request.prompt}</b>
                      <small className="body-sm muted">
                        {t.source.name} · {t.seconds} s · {t.quality === 'final' ? 'Final' : 'Draft'}
                      </small>
                    </a>
                    <Status kind={STATUS[t.status][0]}>{STATUS[t.status][1]}</Status>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="body-sm muted">
                Shots that linked apps direct show up here, with the app that asked.
              </p>
            )}
          </section>
        </div>
      </main>
      <LinkDialog open={linking} onClose={() => setLinking(false)} data={data} onToggle={toggle} />
    </>
  );
}

function LinkDialog({
  open,
  onClose,
  data,
  onToggle,
}: {
  open: boolean;
  onClose: () => void;
  data: AgentsResponse | null;
  onToggle: (a: AgentInfo, link: boolean) => Promise<void>;
}) {
  const id = useId();
  const [busy, setBusy] = useState<string | null>(null);
  const agents = [...(data?.agents ?? [])].sort((a, b) => Number(b.installed) - Number(a.installed));
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(data?.snippet ?? '');
      toast('Copied');
    } catch {
      toast('Couldn’t copy. Select the text and copy it yourself.', { tone: 'error' });
    }
  };
  return (
    <Modal open={open} onClose={onClose} labelledBy={id} variant="dialog" className="st-dialog hg-agentsdlg">
      <div className="st-dialog__h">
        <div style={{ flex: 1 }}>
          <h2 id={id}>Link an app</h2>
          <p>Linked apps can direct shots on this computer’s GPU. They never spend money.</p>
        </div>
      </div>
      <div className="st-dialog__b">
        {data && !data.local ? (
          <p className="body-sm hg-err" role="note">
            <Icon name="alert" size={16} /> Link apps from the computer Hildegard runs on. This device can see
            them, but not change them.
          </p>
        ) : null}
        <ul className="hg-agents">
          {agents.map((a) => (
            <li key={a.id} data-missing={a.installed || a.connected ? undefined : ''}>
              <Icon name="agent" size={18} />
              <span>
                <b>{a.name}</b>
                <small className="body-sm muted">
                  {a.connected
                    ? 'Linked'
                    : a.installed
                      ? 'Found on this computer'
                      : 'Not found on this computer'}
                </small>
              </span>
              <Button
                kind={a.connected || !a.installed ? 'ghost' : 'primary'}
                size="sm"
                busy={busy === a.id}
                disabled={!data?.local}
                aria-label={`${a.connected ? 'Unlink' : 'Link'} ${a.name}`}
                onClick={async () => {
                  setBusy(a.id);
                  await onToggle(a, !a.connected);
                  setBusy(null);
                }}
              >
                {a.connected ? 'Unlink' : 'Link'}
              </Button>
            </li>
          ))}
        </ul>
        <p className="body-sm sec-text">
          Something else? Hildegard is an MCP server. Add this to any app that takes one, or run{' '}
          <code>hildegard connect --print</code>.
        </p>
        <div className="hg-code">
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: it scrolls sideways, so keyboards must be able to reach it. */}
          <pre role="region" tabIndex={0} aria-label="MCP configuration">
            {data?.snippet ?? ''}
          </pre>
          <Button kind="ghost" size="sm" icon="copy" onClick={copy}>
            Copy
          </Button>
        </div>
      </div>
      <div className="st-dialog__f">
        <Button kind="primary" onClick={onClose} data-autofocus="">
          Done
        </Button>
      </div>
    </Modal>
  );
}
