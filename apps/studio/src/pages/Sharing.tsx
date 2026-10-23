// SPDX-License-Identifier: AGPL-3.0-only
import type { NewInvite, PeopleResponse, Person, Role } from '@hildegard/presets';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { Button, Icon, Modal, Segmented, Status, toast, WithCode } from '../components/ui.tsx';
import { ApiError, api } from '../lib/api.ts';
import { setHost, signOut, useStore } from '../lib/store.ts';

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Run one action at a time, with its error shown in the section. */
function useRunner() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ text: string; fix: string | null } | null>(null);
  const run = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError({ text: (e as Error).message, fix: e instanceof ApiError ? e.fix : null });
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, run };
}

/** A fix is a page to open or a command to run. */
function Fix({ fix }: { fix: string }) {
  return /^https:\/\//.test(fix) ? (
    <a href={fix} target="_blank" rel="noreferrer noopener">
      Open Tailscale’s page to turn it on
    </a>
  ) : (
    <WithCode text={`Run \`${fix}\` on this computer.`} />
  );
}

function Problem({ error }: { error: { text: string; fix: string | null } | null }) {
  return error ? (
    <div className="hg-err body-sm" role="alert">
      <Icon name="alert" size={16} />
      <span>
        {error.text} {error.fix ? <Fix fix={error.fix} /> : null}
      </span>
    </div>
  ) : null;
}

/** A secret to hand over: shown once, copied with one press. */
function Secret({ label, value }: { label: string; value: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast('Copied');
    } catch {
      toast('Couldn’t copy. Select the link and copy it yourself.', { tone: 'error' });
    }
  };
  return (
    <div className="hg-code hg-joincode">
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: it scrolls sideways, so keyboards must be able to reach it. */}
      <pre role="region" tabIndex={0} aria-label={label}>
        {value}
      </pre>
      <Button kind="ghost" size="sm" icon="copy" onClick={copy}>
        Copy
      </Button>
    </div>
  );
}

/** Settings › Sharing: Hildegard at a link, and the owner account people sign in with. */
export function Sharing() {
  const auth = useStore((s) => s.auth);
  const host = useStore((s) => s.host);
  const local = !!auth?.local;
  const { busy, error, run } = useRunner();
  const [funnel, setFunnel] = useState(false);

  useEffect(() => {
    api
      .host()
      .then(setHost)
      .catch(() => {});
  }, []);

  const on = (via: 'tailscale' | 'funnel') =>
    run(via, async () => {
      setHost(await api.hostOn(via));
      setFunnel(false);
      toast(via === 'funnel' ? 'Hildegard is on the internet' : 'Hildegard is at its link');
    });

  return (
    <section className="hg-section" aria-labelledby="sh-h">
      <h2 id="sh-h" className="st-h2">
        Sharing
      </h2>
      <p className="body-sm sec-text">
        Put Hildegard at a link, for your phone and laptop and for people you invite. Everyone signs in there;
        this computer never has to.
      </p>
      <Problem error={error} />
      {host && !host.owner && local ? <OwnerForm /> : null}

      {host?.owner ? (
        <div className="st-tile hg-hfway">
          <b>
            {host.on ? 'At a link' : 'Not shared'}{' '}
            {host.on ? (
              <Status kind={host.url ? 'done' : 'error'}>{host.url ? 'Working' : 'Not working'}</Status>
            ) : null}
          </b>
          {host.on && host.url ? (
            <>
              <span className="body-sm sec-text">
                {host.via === 'funnel'
                  ? 'Anyone on the internet can reach its sign-in page. Only people you invite can get in.'
                  : host.via === 'tailscale'
                    ? 'Devices on your tailnet reach it over HTTPS. Invite people to your tailnet, or move it to the internet.'
                    : 'Devices on your tailnet reach it at this computer’s Tailscale address.'}
              </span>
              <Secret label="Link" value={host.url} />
            </>
          ) : host.on ? (
            <div className="hg-err body-sm" role="note">
              <Icon name="alert" size={16} />
              <span>
                {host.problem} {host.fix ? <Fix fix={host.fix} /> : null}
              </span>
            </div>
          ) : (
            <span className="body-sm muted">
              {host.tailscale.running
                ? `Tailscale is running here as ${host.tailscale.name ?? host.tailscale.ip}. The link uses its HTTPS.`
                : 'Tailscale isn’t running here. Install it from tailscale.com and sign in, then come back.'}
            </span>
          )}
          {local ? (
            <div className="hg-devices__btns">
              {!host.on || host.via !== 'tailscale' ? (
                <Button
                  kind={host.on ? undefined : 'primary'}
                  icon="link"
                  busy={busy === 'tailscale'}
                  disabled={!!busy || !host.tailscale.running}
                  onClick={() => on('tailscale')}
                >
                  {host.via === 'funnel' ? 'Only on your tailnet' : 'Put Hildegard at a link'}
                </Button>
              ) : null}
              {host.via !== 'funnel' ? (
                <Button
                  kind="ghost"
                  disabled={!!busy || !host.tailscale.running}
                  onClick={() => setFunnel(true)}
                >
                  On the public internet…
                </Button>
              ) : null}
              {host.on ? (
                <Button
                  kind="ghost"
                  busy={busy === 'off'}
                  disabled={!!busy}
                  onClick={() =>
                    run('off', async () => {
                      setHost(await api.hostOff());
                      toast('The link is off');
                    })
                  }
                >
                  Turn the link off
                </Button>
              ) : null}
            </div>
          ) : (
            <span className="body-sm muted">Turn the link on or off on the computer Hildegard runs on.</span>
          )}
        </div>
      ) : null}
      {host?.owner && local ? (
        <p className="body-sm muted">
          Forgot the owner’s passphrase? Run <code>hildegard host owner</code> on this computer to set a new
          one.
        </p>
      ) : null}

      <Modal
        open={funnel}
        onClose={() => setFunnel(false)}
        labelledBy="fu-t"
        variant="dialog"
        className="st-dialog"
      >
        <div className="st-dialog__h">
          <div style={{ flex: 1 }}>
            <h2 id="fu-t">Put Hildegard on the public internet?</h2>
            <p>Tailscale Funnel gives it a link anyone can open, not only your tailnet.</p>
          </div>
        </div>
        <div className="st-dialog__b">
          <div className="st-agent" style={{ gridTemplateColumns: '44px minmax(0, 1fr)' }}>
            <span className="av">
              <Icon name="alert" />
            </span>
            <span>
              <b>Anyone can reach the sign-in page</b>
              <small>
                Strangers who find the link can try passphrases. Hildegard slows them down, and only people
                you invite can get in. Use a long passphrase.
              </small>
            </span>
          </div>
          <div className="st-agent" style={{ gridTemplateColumns: '44px minmax(0, 1fr)' }}>
            <span className="av">
              <Icon name="shield" />
            </span>
            <span>
              <b>Still private inside</b>
              <small>It’s HTTPS all the way, and each person sees only their own films.</small>
            </span>
          </div>
        </div>
        <div className="st-dialog__f">
          <Button
            kind="ghost"
            onClick={() => setFunnel(false)}
            style={{ marginRight: 'auto' }}
            data-autofocus=""
          >
            Keep it on my tailnet
          </Button>
          <Button kind="primary" busy={busy === 'funnel'} onClick={() => on('funnel')}>
            Put it on the internet
          </Button>
        </div>
      </Modal>
    </section>
  );
}

/** The owner's account, made here: the name and passphrase they sign in with elsewhere. */
function OwnerForm() {
  const [name, setName] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [again, setAgain] = useState('');
  const { busy, error, run } = useRunner();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run('owner', async () => {
      if (passphrase !== again) throw new Error('The two passphrases don’t match.');
      await api.makeOwner(name, passphrase);
      setPassphrase('');
      setAgain('');
      setHost(await api.host());
      toast(`${name.trim()} owns this Hildegard`);
    });
  };
  return (
    <form className="st-tile hg-hfway" onSubmit={submit}>
      <b>Make the owner account</b>
      <span className="body-sm muted">
        You sign in with it on your other devices. Choose a passphrase of at least 10 characters; a few words
        you’ll remember work well.
      </span>
      <Problem error={error} />
      <label className="hg-field hg-field--block">
        Your name
        <input
          value={name}
          autoComplete="username"
          maxLength={40}
          required
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="hg-field hg-field--block">
        Passphrase
        <input
          type="password"
          value={passphrase}
          autoComplete="new-password"
          required
          onChange={(e) => setPassphrase(e.target.value)}
        />
      </label>
      <label className="hg-field hg-field--block">
        The same passphrase again
        <input
          type="password"
          value={again}
          autoComplete="new-password"
          required
          onChange={(e) => setAgain(e.target.value)}
        />
      </label>
      <Button
        kind="primary"
        type="submit"
        busy={busy === 'owner'}
        disabled={!name.trim() || !passphrase || !again}
      >
        Make the owner account
      </Button>
    </form>
  );
}

const ROLE_WORDS: Record<Role, string> = {
  director: 'Directs their own films. Only they and owners see them.',
  owner: 'Everything you can do: models, devices, people and settings.',
};

/** How many takes each director may have waiting at once, so one person can’t fill the GPU’s night. */
function QueueLimit({ list, onSaved }: { list: PeopleResponse; onSaved: (l: PeopleResponse) => void }) {
  const [value, setValue] = useState(String(list.directorQueue));
  const id = useId();
  const { busy, error, run } = useRunner();
  useEffect(() => setValue(String(list.directorQueue)), [list.directorQueue]);
  const n = Number(value);
  const valid = Number.isInteger(n) && n >= 1 && n <= 100;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run('limit', async () => {
      const saved = await api.setDirectorQueue(n);
      onSaved(saved);
      toast(
        `Each director may have ${saved.directorQueue === 1 ? '1 take' : `${saved.directorQueue} takes`} waiting`,
      );
    });
  };
  return (
    <form className="st-tile hg-hfway" onSubmit={submit}>
      <b>Takes waiting, per director</b>
      <span className="body-sm muted">
        How many takes each director may have queued or rendering at once. Owners, and you at this computer,
        have no limit.
      </span>
      <Problem error={error} />
      <div className="hg-field hg-field--block hg-limit">
        <label htmlFor={`${id}-n`}>Takes each director may have waiting</label>
        <div className="hg-limit__row">
          <input
            id={`${id}-n`}
            type="number"
            inputMode="numeric"
            min={1}
            max={100}
            step={1}
            value={value}
            required
            aria-invalid={!valid}
            aria-describedby={valid ? undefined : `${id}-hint`}
            onChange={(e) => setValue(e.target.value)}
          />
          <Button
            kind="ghost"
            type="submit"
            busy={busy === 'limit'}
            disabled={!valid || n === list.directorQueue}
          >
            Save
          </Button>
        </div>
        {!valid ? (
          <span id={`${id}-hint`} className="body-sm muted">
            A whole number from 1 to 100.
          </span>
        ) : null}
      </div>
    </form>
  );
}

/** Settings › People: who may sign in, invites, roles, and removing someone. */
export function People() {
  const auth = useStore((s) => s.auth);
  const host = useStore((s) => s.host);
  const [list, setList] = useState<PeopleResponse | null>(null);
  const [role, setRole] = useState<Role>('director');
  const [invite, setInvite] = useState<NewInvite | null>(null);
  const [removing, setRemoving] = useState<Person | null>(null);
  const { busy, error, run } = useRunner();

  useEffect(() => {
    api
      .people()
      .then(setList)
      .catch(() => {});
    api
      .host()
      .then(setHost)
      .catch(() => {});
  }, []);
  const me = auth?.person?.id ?? null;
  // From this computer an invite needs the link to lead somewhere; from elsewhere, it leads where they are.
  const canInvite = !!host?.owner && (!auth?.local || (host.on && !!host.url));

  return (
    <section className="hg-section" aria-labelledby="pp-h">
      <h2 id="pp-h" className="st-h2">
        People
      </h2>
      <p className="body-sm sec-text">
        Invite people to direct on this GPU. Each invite link works once, for one person, for three days.
      </p>
      <Problem error={error} />

      <div className="st-tile hg-hfway">
        <b>Invite someone</b>
        {invite ? (
          <>
            <span className="body-sm sec-text">
              Send this link to the person you’re inviting, as a {invite.invite.role}. It works once, until{' '}
              {when(invite.invite.expiresAt)}. Keep it private.
            </span>
            <Secret label="Invite link" value={invite.url} />
            <Button kind="ghost" onClick={() => setInvite(null)}>
              Invite someone else
            </Button>
          </>
        ) : (
          <>
            <Segmented<Role>
              label="Role"
              value={role}
              onChange={setRole}
              options={[
                { value: 'director', label: 'Director' },
                { value: 'owner', label: 'Owner' },
              ]}
            />
            <span className="body-sm muted">{ROLE_WORDS[role]}</span>
            {!canInvite ? (
              <span className="body-sm muted">
                {host?.owner ? (
                  <>
                    Put Hildegard at a link first, in <a href="#/settings/sharing">Settings › Sharing</a>, so
                    invites lead there.
                  </>
                ) : (
                  <>
                    Make the owner account first, in <a href="#/settings/sharing">Settings › Sharing</a>.
                  </>
                )}
              </span>
            ) : null}
            <Button
              kind="primary"
              icon="link"
              busy={busy === 'invite'}
              disabled={!canInvite}
              onClick={() =>
                run('invite', async () => {
                  setInvite(await api.invite(role));
                  setList(await api.people());
                })
              }
            >
              Make an invite link
            </Button>
          </>
        )}
      </div>

      {list ? <QueueLimit list={list} onSaved={setList} /> : null}

      {list?.people.length ? (
        <div className="st-tile hg-devices" role="list" aria-label="People">
          {list.people.map((p) => (
            <div className="hg-devices__row" key={p.id} role="listitem">
              <span className="st-dev__g">
                <Icon name="person" size={22} />
              </span>
              <span className="hg-devices__name">
                <b>
                  {p.name}
                  {p.id === me ? ' (you)' : ''}
                </b>
                <small className="body-sm muted">
                  {p.role === 'owner' ? 'Owner · ' : 'Director · '}
                  {p.sessions
                    ? `Signed in on ${p.sessions === 1 ? 'one device' : `${p.sessions} devices`}`
                    : 'Not signed in'}
                  {p.lastSeenAt ? ` · last here ${when(p.lastSeenAt)}` : ''}
                </small>
              </span>
              {p.id !== me ? (
                <span className="hg-devices__act">
                  <Button
                    kind="ghost"
                    size="sm"
                    busy={busy === `role-${p.id}`}
                    onClick={() =>
                      run(`role-${p.id}`, async () => {
                        setList(await api.setRole(p.id, p.role === 'owner' ? 'director' : 'owner'));
                        toast(`${p.name} is ${p.role === 'owner' ? 'a director' : 'an owner'} now`);
                      })
                    }
                  >
                    {p.role === 'owner' ? 'Make director' : 'Make owner'}
                  </Button>
                  <Button
                    kind="ghost"
                    size="sm"
                    icon="trash"
                    aria-label={`Remove ${p.name}`}
                    onClick={() => setRemoving(p)}
                  />
                </span>
              ) : null}
            </div>
          ))}
          {list.invites.map((i) => (
            <div className="hg-devices__row" key={i.id} role="listitem">
              <span className="st-dev__g">
                <Icon name="link" size={22} />
              </span>
              <span className="hg-devices__name">
                <b>Invite for a {i.role}</b>
                <small className="body-sm muted">Not used yet · works until {when(i.expiresAt)}</small>
              </span>
              <span className="hg-devices__act">
                <Button
                  kind="ghost"
                  size="sm"
                  busy={busy === `cancel-${i.id}`}
                  onClick={() =>
                    run(`cancel-${i.id}`, async () => {
                      setList(await api.cancelInvite(i.id));
                      toast('Invite canceled');
                    })
                  }
                >
                  Cancel invite
                </Button>
              </span>
            </div>
          ))}
        </div>
      ) : null}

      <Modal
        open={!!removing}
        onClose={() => setRemoving(null)}
        labelledBy="rm-t"
        variant="dialog"
        className="st-dialog"
      >
        <div className="st-dialog__h">
          <div style={{ flex: 1 }}>
            <h2 id="rm-t">Remove {removing?.name}?</h2>
            <p>
              They’re signed out everywhere at once and can’t sign in again. Their films stay here, for
              owners.
            </p>
          </div>
        </div>
        <div className="st-dialog__f">
          <Button
            kind="ghost"
            onClick={() => setRemoving(null)}
            style={{ marginRight: 'auto' }}
            data-autofocus=""
          >
            Keep {removing?.name}
          </Button>
          <Button
            kind="danger"
            icon="trash"
            busy={busy === 'remove'}
            onClick={() =>
              run('remove', async () => {
                const who = removing!;
                setList(await api.removePerson(who.id));
                setRemoving(null);
                toast(`Removed ${who.name}`);
              })
            }
          >
            Remove
          </Button>
        </div>
      </Modal>
    </section>
  );
}

/** Settings › Your account, for someone signed in from another device. */
export function Account() {
  const person = useStore((s) => s.auth?.person);
  const [busy, setBusy] = useState(false);
  if (!person) return null;
  return (
    <section className="hg-section" aria-labelledby="ac-h">
      <h2 id="ac-h" className="st-h2">
        Your account
      </h2>
      <div className="st-tile hg-linked">
        <span className="st-dev__g">
          <Icon name="person" size={22} />
        </span>
        <span style={{ minWidth: 0 }}>
          <b>{person.name}</b>
          <small className="body-sm muted">
            {person.role === 'owner'
              ? 'An owner: films, models, devices, people and settings.'
              : 'A director: your own films, on this GPU. Only you and its owners see them.'}
          </small>
        </span>
        <Button
          kind="ghost"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            await signOut();
          }}
        >
          Sign out
        </Button>
      </div>
      <p className="body-sm muted">Signing out ends your session on this device only.</p>
      <PassphraseForm />
    </section>
  );
}

/** Change your own passphrase. It needs the current one, and signs you out everywhere but here. */
function PassphraseForm() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const { busy, error, run } = useRunner();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run('passphrase', async () => {
      if (next !== again) throw new Error('The two new passphrases don’t match.');
      if (next === current) throw new Error('That’s your passphrase already. Choose a new one.');
      await api.changePassphrase(current, next);
      setCurrent('');
      setNext('');
      setAgain('');
      toast('Passphrase changed. You’re signed out everywhere else.');
    });
  };
  return (
    <form className="st-tile hg-hfway" onSubmit={submit} aria-labelledby="pw-h">
      <b id="pw-h">Change your passphrase</b>
      <span className="body-sm muted">
        At least 10 characters. Every other device signed in as you is signed out; this one stays.
      </span>
      <Problem error={error} />
      <label className="hg-field hg-field--block">
        Current passphrase
        <input
          type="password"
          value={current}
          autoComplete="current-password"
          required
          onChange={(e) => setCurrent(e.target.value)}
        />
      </label>
      <label className="hg-field hg-field--block">
        New passphrase
        <input
          type="password"
          value={next}
          autoComplete="new-password"
          required
          onChange={(e) => setNext(e.target.value)}
        />
      </label>
      <label className="hg-field hg-field--block">
        The new passphrase again
        <input
          type="password"
          value={again}
          autoComplete="new-password"
          required
          onChange={(e) => setAgain(e.target.value)}
        />
      </label>
      <Button
        kind="primary"
        type="submit"
        busy={busy === 'passphrase'}
        disabled={!current || !next || !again}
      >
        Change passphrase
      </Button>
    </form>
  );
}
