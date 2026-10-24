// SPDX-License-Identifier: AGPL-3.0-only
/** A voice's page: for a clone, whose consent it rests on, the certificate, every use, and revoking it. */
import type { VoiceState, VoiceUse } from '@hildegard/presets';
import { useEffect, useState } from 'react';
import { Button, Icon } from '../../components/ui.tsx';
import { AskName, Confirm, Kind, Orb, PlayButton } from '../../components/voice.tsx';
import { api } from '../../lib/api.ts';
import { voiceLine } from '../../lib/voice.ts';

const RELATION = {
  self: 'Their own voice',
  agreed: 'Someone who agreed',
  licensed: 'A voice actor, under license',
} as const;

const when = (iso: string) =>
  new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function Rights({
  state,
  voiceId,
  go,
}: {
  state: VoiceState;
  voiceId: string;
  go: (to: string) => void;
}) {
  const v = state.voices.find((x) => x.id === voiceId);
  const [uses, setUses] = useState<VoiceUse[] | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new job may be a new use, so look again.
  useEffect(() => {
    if (v?.kind !== 'clone') return;
    api
      .voiceUses(voiceId)
      .then(setUses)
      .catch(() => setUses([]));
  }, [voiceId, v?.kind, state.jobs.length]);
  if (!v)
    return (
      <div className="hg-empty">
        <b>That voice isn’t here</b>
        <span className="body-sm muted">It may have been deleted.</span>
        <Button onClick={() => go('/voice/voices')}>Back to voices</Button>
      </div>
    );
  const c = v.consent;
  const who = c?.relation === 'self' ? 'you' : (c?.speaker ?? 'they');
  return (
    <div className="st-page hg-rights">
      <div className="hg-rights__col">
        <div className="hg-rights__h">
          <Orb hue={v.hue} size={64} />
          <span style={{ flex: 1, minWidth: 0 }}>
            <h2 className="st-h1">{v.name}</h2>
            <span className="body-sm muted">
              {c
                ? `Clone · made ${new Date(c.recordedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })} · consent on file`
                : `${v.kind === 'designed' ? 'Designed' : 'Built-in'} · ${voiceLine(v)}`}
            </span>
          </span>
          {c ? (
            <span className={`cs-fit ${c.status === 'active' ? 'ok' : 'no'}`}>
              {c.status === 'active'
                ? 'Consent active'
                : c.status === 'revoked'
                  ? 'Consent revoked'
                  : 'License ended'}
            </span>
          ) : (
            <Kind voice={v} />
          )}
        </div>
        {c ? (
          <>
            <section className="st-tile hg-rights__consent" aria-label="Consent">
              <PlayButton url={c.recording} label={`${c.speaker}’s consent`} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <b>{c.relation === 'self' ? 'Your consent' : `${c.speaker}’s consent`}</b>
                <small className="body-sm muted">Recorded {when(c.recordedAt)} · every sample matched</small>
              </span>
              <a className="hg-btn hg-btn--sm" href={`/api/voice/voices/${v.id}/certificate`} download>
                <Icon name="download" size={16} />
                Consent certificate
              </a>
            </section>
            <section className="st-tile hg-uses" aria-labelledby="uses-h">
              <h3 id="uses-h" className="st-h2">
                Every use
              </h3>
              <p className="body-sm muted">
                Each clip carries its own watermark, so it can always be traced back here.
              </p>
              {uses === null ? (
                <span className="hg-spin" role="status" />
              ) : uses.length ? (
                <table className="st-table">
                  <thead>
                    <tr>
                      <th scope="col">When</th>
                      <th scope="col">What</th>
                      <th scope="col">By</th>
                      <th scope="col">Fingerprint</th>
                    </tr>
                  </thead>
                  <tbody>
                    {uses.map((u) => (
                      <tr key={u.job}>
                        <td className="num muted">{when(u.at)}</td>
                        <td>{u.title}</td>
                        <td className="muted">{u.by}</td>
                        <td className="num muted">
                          {u.sha256 ? `${u.sha256.slice(0, 4)}·${u.sha256.slice(4, 8)}` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="body-sm sec-text">Not used yet.</p>
              )}
            </section>
          </>
        ) : (
          <section className="st-tile" aria-label="About">
            <p className="body-sm sec-text">{v.description ?? v.blurb}</p>
            <PlayButton url={v.preview} label={`a sample of ${v.name}`} />
          </section>
        )}
      </div>
      <div className="hg-rights__col">
        {c ? (
          <section className="st-tile hg-terms-card" aria-labelledby="terms-h">
            <h3 id="terms-h" className="st-h2">
              Terms
            </h3>
            <dl className="hg-terms-list">
              <div>
                <dt>Whose voice</dt>
                <dd>{RELATION[c.relation]}</dd>
              </div>
              <div>
                <dt>Speaker</dt>
                <dd>{c.speaker}</dd>
              </div>
              <div>
                <dt>Ends</dt>
                <dd>
                  {c.until ? new Date(c.until).toLocaleDateString([], { dateStyle: 'long' }) : 'When revoked'}
                </dd>
              </div>
              <div>
                <dt>Who can use it</dt>
                <dd>The owner of this Hildegard</dd>
              </div>
              <div>
                <dt>Likeness</dt>
                <dd className="num">{Math.round(c.match * 100)}% at the lowest</dd>
              </div>
            </dl>
          </section>
        ) : null}
        <section className="st-tile hg-mind" aria-labelledby="mind-h">
          <h3 id="mind-h">
            {c
              ? c.relation === 'self'
                ? 'If you change your mind'
                : `If ${c.speaker} changes their mind`
              : 'This voice'}
          </h3>
          {c ? (
            <p className="body-sm sec-text">
              Revoking deletes the recordings it speaks from, so it stops working at once. What you already
              made stays, under the terms {who === 'you' ? 'you' : who} agreed to, and the consent record
              stays as proof.
            </p>
          ) : null}
          <div className="hg-stack">
            {v.kind !== 'builtin' ? (
              <Button onClick={() => setRenaming(true)} icon="pen">
                Rename
              </Button>
            ) : null}
            {c?.status === 'active' ? (
              <Button kind="danger" onClick={() => setRevoking(true)}>
                Revoke consent
              </Button>
            ) : null}
            {v.kind !== 'builtin' ? (
              <Button kind="danger" onClick={() => setDeleting(true)}>
                Delete this voice
              </Button>
            ) : null}
            {v.kind === 'builtin' || c?.status === 'active' || v.kind === 'designed' ? (
              <Button kind="primary" onClick={() => go(`/voice/speak/${v.id}`)}>
                Use voice
              </Button>
            ) : null}
          </div>
        </section>
      </div>
      {revoking ? (
        <Confirm
          title={`Revoke ${c?.relation === 'self' ? 'your' : `${c?.speaker}’s`} consent?`}
          body="The recordings this voice speaks from are deleted now. It can’t speak again, and this can’t be undone."
          action="Revoke consent"
          onClose={() => setRevoking(false)}
          onConfirm={async () => {
            await api.revokeVoice(v.id);
            setRevoking(false);
          }}
        />
      ) : null}
      {deleting ? (
        <Confirm
          title={`Delete ${v.name}?`}
          body={
            c
              ? 'Its recordings are deleted. Its consent record and what you already made stay.'
              : 'What you already made with it stays.'
          }
          action="Delete voice"
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            await api.deleteVoice(v.id);
            go('/voice/voices');
          }}
        />
      ) : null}
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
    </div>
  );
}
