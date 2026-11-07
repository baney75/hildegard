// SPDX-License-Identifier: AGPL-3.0-only
import type {
  ConnectCode,
  HostState,
  NewInvite,
  PeopleResponse,
  Person,
  Role,
  TunnelReport,
} from '@hildegard/presets';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { OneTimeCode } from '../components/OneTimeCode.tsx';
import { loopbackOnly, Qr } from '../components/Qr.tsx';
import { Button, Icon, Modal, Segmented, Status, toast, WithCode } from '../components/ui.tsx';
import { ApiError, api } from '../lib/api.ts';
import { isOwner, setHost, signOut, useStore } from '../lib/store.ts';

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

/** Whose page a fix opens, by its address. */
const site = (url: string) =>
  /(^|\.)tailscale\.com$/.test(new URL(url).hostname)
    ? 'Tailscale’s page'
    : /(^|\.)cloudflare\.com$/.test(new URL(url).hostname)
      ? 'Cloudflare’s page'
      : 'the page';

/** A fix is a page to open, a log to read, or a command to run. */
function Fix({ fix }: { fix: string }) {
  if (/^https:\/\//.test(fix))
    return (
      <a href={fix} target="_blank" rel="noreferrer noopener">
        Open {site(fix)}
      </a>
    );
  if (fix.startsWith('See ')) return <span>{fix}.</span>;
  return <WithCode text={`Run \`${fix}\` on this computer.`} />;
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

type Provider = 'tailscale' | 'cloudflare';

/** One step of a provider's setup: done steps say so and are skipped. */
function Step({
  n,
  title,
  done,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  children?: ReactNode;
}) {
  return (
    <li className="hg-tstep" data-done={done || undefined}>
      <span className="hg-tstep__n" aria-hidden="true">
        {done ? <Icon name="check" size={14} /> : n}
      </span>
      <div className="hg-tstep__b">
        <b>
          {title} {done ? <Status kind="done">Done</Status> : null}
        </b>
        {done ? null : children}
      </div>
    </li>
  );
}

/**
 * How other devices reach this Hildegard, through an account the owner holds: Tailscale (their own devices, or the
 * public internet with Funnel) or Cloudflare (a name on their own domain, or a temporary quick link with no account).
 * Each provider makes the account on its own page; Hildegard reads what is already done here and skips it.
 */
function Tunnels({ host, onFunnel }: { host: HostState; onFunnel: () => void }) {
  const [report, setReport] = useState<TunnelReport | null>(null);
  const [provider, setProvider] = useState<Provider>('tailscale');
  const [have, setHave] = useState<Record<Provider, boolean>>({ tailscale: false, cloudflare: false });
  const [hostname, setHostname] = useState('');
  const [waiting, setWaiting] = useState(false);
  const { busy, error, run } = useRunner();
  const nameId = useId();

  const refresh = () =>
    api
      .tunnel()
      .then((r) => {
        setReport(r);
        setHostname((h) => h || r.cloudflare.hostname || '');
        return r;
      })
      .catch(() => null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read once, and again when the link changes.
  useEffect(() => {
    void refresh();
  }, [host.on, host.url]);
  // Pick the provider that is furthest along, once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the first report decides.
  useEffect(() => {
    if (report && report.tailscale.state !== 'ready' && report.cloudflare.state === 'ready')
      setProvider('cloudflare');
  }, [!!report]);
  // While Cloudflare's sign-in page is open, look every 2 seconds for it to finish.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is stable enough for a poll.
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(async () => {
      const r = await refresh();
      if (r?.cloudflare.signedIn || (r && !r.cloudflare.signingIn)) setWaiting(false);
    }, 2000);
    return () => clearInterval(t);
  }, [waiting]);

  if (!report) return <span className="body-sm muted">Looking at what’s set up here…</span>;
  const ts = report.tailscale;
  const cf = report.cloudflare;
  const p = provider === 'tailscale' ? ts : cf;

  const account = (
    <>
      <span className="body-sm sec-text">
        {provider === 'tailscale'
          ? 'Free for personal use. Make it on Tailscale’s own page; Hildegard never makes one for you.'
          : 'Free. A name that stays needs a domain in the account. Make it on Cloudflare’s own page; Hildegard never makes one for you.'}
      </span>
      <div className="hg-devices__btns">
        <a className="hg-btn" href={p.signup} target="_blank" rel="noreferrer noopener">
          Create a free account
        </a>
        <Button
          onClick={() => {
            setHave((h) => ({ ...h, [provider]: true }));
            if (provider === 'cloudflare' && cf.installed) signIn();
          }}
        >
          I already have one
        </Button>
      </div>
      {have[provider] && (!p.installed || provider === 'tailscale') ? (
        <span className="body-sm muted">
          {p.installed
            ? 'Good. Sign this computer in to it in step 3.'
            : 'Good. Get the app in step 2, then sign this computer in to your account in step 3.'}
        </span>
      ) : null}
    </>
  );

  const signIn = () =>
    run('signin', async () => {
      // Opened now, on the click, so the browser doesn't block it; pointed at Cloudflare's page once it is known.
      const tab = window.open('about:blank', '_blank');
      const r = await api.cloudflareLogin();
      if (r.done) {
        tab?.close();
        await refresh();
        return;
      }
      if (tab && r.url && !r.opened) tab.location.href = r.url;
      else tab?.close();
      setWaiting(true);
      await refresh();
    });

  return (
    <div className="hg-tunnels">
      <Segmented
        label="How other devices reach Hildegard"
        value={provider}
        options={[
          { value: 'tailscale', label: 'Tailscale' },
          { value: 'cloudflare', label: 'Cloudflare' },
        ]}
        onChange={setProvider}
      />
      <span className="body-sm sec-text">
        {provider === 'tailscale'
          ? 'Your own phone and laptop, on your tailnet: nobody else can even reach the sign-in page. The public internet is a separate choice.'
          : 'A name on your own domain, such as hildegard.example.com, that anyone can open and sign in at, through a tunnel in your Cloudflare account.'}
      </span>
      <Problem error={error} />
      <ol className="hg-tsteps">
        <Step n={1} title="An account" done={p.signedIn}>
          {account}
        </Step>
        <Step
          n={2}
          title={provider === 'tailscale' ? 'Tailscale on this computer' : 'cloudflared on this computer'}
          done={p.installed}
        >
          {provider === 'cloudflare' && cf.canFetch ? (
            <>
              <span className="body-sm sec-text">
                Hildegard fetches Cloudflare’s own build, checked against its pinned hash, into its own
                folder. Nothing else on this computer changes.
              </span>
              <Button
                kind="primary"
                busy={busy === 'install'}
                disabled={!!busy}
                onClick={() =>
                  run('install', async () => {
                    await api.cloudflareInstall();
                    await refresh();
                    toast('cloudflared is installed');
                  })
                }
              >
                Install cloudflared
              </Button>
            </>
          ) : (
            <span className="body-sm sec-text">
              {p.install ? <WithCode text={`Run \`${p.install}\`, or get it from `} /> : 'Get it from '}
              <a href={p.download} target="_blank" rel="noreferrer noopener">
                {provider === 'tailscale' ? 'Tailscale' : 'Cloudflare'}’s download page
              </a>
              .{' '}
              <Button kind="ghost" size="sm" onClick={() => void refresh()}>
                Check again
              </Button>
            </span>
          )}
        </Step>
        <Step n={3} title="This computer signed in" done={p.signedIn}>
          {!p.installed ? (
            <span className="body-sm muted">After step 2.</span>
          ) : provider === 'tailscale' ? (
            <span className="body-sm sec-text">
              {ts.signIn.startsWith('Open ') ? (
                `${ts.signIn}.`
              ) : (
                <WithCode text={`Run \`${ts.signIn}\` on this computer.`} />
              )}{' '}
              <Button kind="ghost" size="sm" onClick={() => void refresh()}>
                Check again
              </Button>
            </span>
          ) : waiting || cf.signingIn ? (
            <span className="body-sm sec-text">
              <span className="hg-spin" /> Waiting for you on Cloudflare’s page: sign in and pick the domain
              for Hildegard.{' '}
              {cf.signingIn ? (
                <a href={cf.signingIn} target="_blank" rel="noreferrer noopener">
                  Open it again
                </a>
              ) : null}
            </span>
          ) : (
            <Button kind="primary" busy={busy === 'signin'} disabled={!!busy} onClick={signIn}>
              Sign in to Cloudflare
            </Button>
          )}
        </Step>
        <Step n={4} title="Turn on the link" done={false}>
          {provider === 'tailscale' ? (
            <div className="hg-devices__btns">
              <Button
                kind="primary"
                icon="link"
                busy={busy === 'tailscale'}
                disabled={!!busy || ts.state !== 'ready'}
                onClick={() =>
                  run('tailscale', async () => {
                    setHost(await api.hostOn('tailscale'));
                    toast('Hildegard is at its link');
                  })
                }
              >
                Turn on for my devices
              </Button>
              <Button kind="ghost" disabled={!!busy || ts.state !== 'ready'} onClick={onFunnel}>
                On the public internet…
              </Button>
            </div>
          ) : (
            <form
              className="hg-hfway"
              onSubmit={(e) => {
                e.preventDefault();
                void run('cloudflare', async () => {
                  setHost(await api.cloudflareOn(hostname));
                  toast('Hildegard is at its link');
                });
              }}
            >
              <label className="hg-field hg-field--block" htmlFor={nameId}>
                The name people will open, on a domain in your account
              </label>
              <input
                id={nameId}
                value={hostname}
                placeholder="hildegard.example.com"
                autoComplete="off"
                spellCheck={false}
                maxLength={253}
                disabled={!cf.signedIn}
                onChange={(e) => setHostname(e.target.value)}
              />
              <Button
                kind="primary"
                type="submit"
                icon="link"
                busy={busy === 'cloudflare'}
                disabled={!!busy || !cf.signedIn || !cf.installed || !hostname.trim()}
              >
                Turn on
              </Button>
            </form>
          )}
        </Step>
      </ol>
      {provider === 'cloudflare' && cf.installed ? (
        <span className="body-sm muted">
          No account or domain yet?{' '}
          <Button
            kind="ghost"
            size="sm"
            busy={busy === 'quick'}
            disabled={!!busy}
            onClick={() =>
              run('quick', async () => {
                setHost(await api.hostOn('quick'));
                toast('Hildegard is at a temporary link');
              })
            }
          >
            Use a temporary link
          </Button>{' '}
          A quick tunnel needs no account, but its name changes each time Hildegard starts and live updates
          don’t come through it.
        </span>
      ) : null}
    </div>
  );
}

/** A secret to hand over: shown once, copied with one press. */
export function Secret({ label, value }: { label: string; value: string }) {
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

/**
 * An invite as a QR code, for someone sitting with you. The link signs up whoever opens it, so the code shows only
 * when asked for (a screen share or a camera across the room can read one), and never for a link only this computer
 * can open.
 */
function InviteQr({ url }: { url: string }) {
  const [shown, setShown] = useState(false);
  if (loopbackOnly(url)) return null;
  return shown ? (
    <Qr
      value={url}
      label="QR code for the invite link"
      hint="Next to them? They can point their phone’s camera here instead."
    />
  ) : (
    <Button kind="ghost" size="sm" icon="phone" onClick={() => setShown(true)}>
      Show as a QR code
    </Button>
  );
}

/** Settings › Sharing: Hildegard at a link, and the owner account people sign in with. */
export function Sharing() {
  const auth = useStore((s) => s.auth);
  const host = useStore((s) => s.host);
  const local = !!auth?.local;
  const { busy, error, run } = useRunner();
  const [funnel, setFunnel] = useState(false);
  const [connect, setConnect] = useState<ConnectCode | null>(null);
  // With several owners and no session (this computer), the server asks whose code it is.
  const [owners, setOwners] = useState<string[] | null>(null);
  const [asOwner, setAsOwner] = useState('');
  const getConnectCode = (person?: string) =>
    run('connect', async () => {
      try {
        setConnect(await api.connectCode(person));
        setOwners(null);
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && e.owners?.length) {
          setOwners(e.owners);
          setAsOwner((cur) => (e.owners?.includes(cur) ? cur : e.owners![0]!));
          return;
        }
        throw e;
      }
    });

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
                  : host.via === 'custom' && host.tunnel === 'quick'
                    ? 'A temporary Cloudflare quick tunnel: its name changes each time Hildegard starts, and Cloudflare doesn’t pass live updates through it, so reload to see new takes. Anyone who finds the link can reach its sign-in page; only people you invite can get in.'
                    : host.via === 'custom' && host.tunnel === 'cloudflare'
                      ? 'Your Cloudflare tunnel, at a name on your own domain. Anyone who finds the link can reach its sign-in page; only people you invite can get in.'
                      : host.via === 'custom'
                        ? 'HTTPS through your own front door, such as a Cloudflare tunnel. Anyone who finds the link can reach its sign-in page; only people you invite can get in. Change it with hildegard host --public-url on the computer Hildegard runs on.'
                        : host.via === 'tailscale'
                          ? 'Devices on your tailnet reach it over HTTPS. Invite people to your tailnet, or move it to the internet.'
                          : 'Devices on your tailnet reach it at this computer’s Tailscale address.'}
              </span>
              <Secret label="Link" value={host.url} />
              <Qr
                value={host.url}
                label="QR code for the link"
                hint="On your phone, point the camera here to open Hildegard, then sign in."
              />
            </>
          ) : host.on ? (
            <div className="hg-err body-sm" role="note">
              <Icon name="alert" size={16} />
              <span>
                {host.problem} {host.fix ? <Fix fix={host.fix} /> : null}
              </span>
            </div>
          ) : local ? (
            <Tunnels host={host} onFunnel={() => setFunnel(true)} />
          ) : (
            <span className="body-sm muted">Only this computer can use Hildegard now.</span>
          )}
          {local && host.on ? (
            <div className="hg-devices__btns">
              {host.via === 'funnel' ? (
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
              {host.via === 'tailscale' || host.via === 'address' ? (
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
          ) : !local ? (
            <span className="body-sm muted">Turn the link on or off on the computer Hildegard runs on.</span>
          ) : null}
        </div>
      ) : null}
      {host?.owner && isOwner(auth) ? (
        <div className="st-tile hg-hfway">
          <b>Connect claude.ai, ChatGPT or Grok</b>
          <span className="body-sm muted">
            {host.on && host.url
              ? 'Add this address as a custom connector, then on Hildegard’s page choose Use a connect code and type the code. Only use a code you made yourself, for a connection you are making.'
              : 'Put Hildegard at a link first (above); a chatbot needs an address to connect to.'}
          </span>
          {host.on && host.url ? <Secret label="Connector address" value={`${host.url}/mcp`} /> : null}
          {connect ? (
            <OneTimeCode
              code={connect.code}
              expiresAt={connect.expiresAt}
              label="Connect code"
              onExpired={() => setConnect(null)}
            />
          ) : null}
          {owners ? (
            <label className="body-sm">
              Whose code is it?{' '}
              <select value={asOwner} onChange={(e) => setAsOwner(e.target.value)} aria-label="Owner">
                {owners.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="hg-devices__btns">
            <Button
              kind={connect ? undefined : 'primary'}
              icon="link"
              busy={busy === 'connect'}
              disabled={!!busy}
              onClick={() => getConnectCode(owners ? asOwner : undefined)}
            >
              {owners ? 'Get the code' : connect ? 'New connect code' : 'Get a connect code'}
            </Button>
          </div>
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
            <InviteQr url={invite.url} />
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
