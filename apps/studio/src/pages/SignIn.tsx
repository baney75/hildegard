// SPDX-License-Identifier: AGPL-3.0-only
import type { Role } from '@hildegard/presets';
import { type ReactNode, useEffect, useState } from 'react';
import markGreen from '../assets/mark-green.svg';
import markVellum from '../assets/mark-vellum.svg';
import wordmarkGreen from '../assets/wordmark-green.svg';
import wordmarkVellum from '../assets/wordmark-vellum.svg';
import { Button, Icon } from '../components/ui.tsx';
import { ApiError, api } from '../lib/api.ts';
import { connect, useStore } from '../lib/store.ts';
import { useTheme } from '../lib/theme.ts';

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** The frame both pages share: the brand and a quote at the side, the form in the middle. */
function Frame({ children }: { children: ReactNode }) {
  const light = useTheme().theme === 'light';
  // Inside .hg-root, so fields get the Studio's own box sizing and type.
  return (
    <div className="hg-root">
      <div className="st-ob hg-welcome">
        <div className="st-ob__side">
          <div className="hg-welcome__brand">
            <img src={light ? markGreen : markVellum} alt="" height={34} />
            <img src={light ? wordmarkGreen : wordmarkVellum} alt="Hildegard" height={26} />
          </div>
          <p className="hg-welcome__quote">
            “A feather on the breath of God.”
            <br />
            <span>Hildegard of Bingen, 1098–1179</span>
          </p>
        </div>
        <main className="st-ob__main hg-signin" id="main">
          {children}
        </main>
      </div>
    </div>
  );
}

function Problem({ text }: { text: string | null }) {
  return text ? (
    <p className="hg-err body-sm" role="alert">
      <Icon name="alert" size={16} /> {text}
    </p>
  ) : null;
}

/** Someone on another device, not signed in yet. */
export function SignIn() {
  const owner = useStore((s) => s.auth?.owner ?? true);
  const [name, setName] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.signIn(name, passphrase);
      setPassphrase('');
      await connect();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Frame>
      <h1 className="st-h1">Sign in to Hildegard.</h1>
      <p className="st-lead">
        A film studio on someone’s own GPU, shared with the people they invite. Sign in with the name and
        passphrase you chose.
      </p>
      {owner ? (
        <form
          className="st-tile hg-hfway"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Problem text={error} />
          <label className="hg-field hg-field--block">
            Name
            <input
              value={name}
              autoComplete="username"
              autoCapitalize="off"
              spellCheck={false}
              required
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="hg-field hg-field--block">
            Passphrase
            <input
              type="password"
              value={passphrase}
              autoComplete="current-password"
              required
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </label>
          <Button kind="primary" type="submit" busy={busy} disabled={!name.trim() || !passphrase}>
            Sign in
          </Button>
        </form>
      ) : (
        <div className="st-tile hg-prose">
          <p>No one can sign in here yet.</p>
          <p className="body-sm sec-text">
            The owner makes their account first, on the computer Hildegard runs on: in Settings › Sharing
            there, or with <code>hildegard host owner</code>.
          </p>
        </div>
      )}
      <p className="body-sm muted">
        New here? Ask the owner for an invite link. It signs you up in one step.
      </p>
    </Frame>
  );
}

/** An invite link: choose a name and passphrase, once. */
export function AcceptInvite({ token, go }: { token: string; go: (to: string) => void }) {
  const [invite, setInvite] = useState<{ role: Role; expiresAt: string } | null | undefined>(undefined);
  const [name, setName] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .checkInvite(token)
      .then(setInvite)
      .catch((e) => {
        setInvite(null);
        if (e instanceof ApiError && e.status !== 404) setError(e.message);
      });
  }, [token]);

  const submit = async () => {
    setError(null);
    if ([...passphrase].length < 10)
      return setError('Use a passphrase of at least 10 characters. A few words you’ll remember work well.');
    if (passphrase !== again) return setError('The two passphrases don’t match.');
    setBusy(true);
    try {
      await api.acceptInvite(token, name, passphrase);
      go('/');
      await connect();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (invite === undefined)
    return (
      <Frame>
        <p className="body-sm muted" role="status">
          <span className="hg-spin" aria-hidden="true" /> Opening your invite…
        </p>
      </Frame>
    );
  if (invite === null)
    return (
      <Frame>
        <h1 className="st-h1">This invite can’t be used.</h1>
        <p className="st-lead">
          {error ?? 'It has been used already, or it has expired. Ask whoever sent it for a new one.'}
        </p>
        <div>
          <Button kind="primary" onClick={() => go('/')}>
            Sign in instead
          </Button>
        </div>
      </Frame>
    );
  return (
    <Frame>
      <span className="ovl">You’re invited</span>
      <h1 className="st-h1">Join this Hildegard.</h1>
      <p className="st-lead">
        {invite.role === 'owner'
          ? 'You’ll be one of its owners: films, models, devices, people and settings, all of it.'
          : 'You’ll direct films of your own here, on its GPU. Only you and its owner see them.'}
      </p>
      <form
        className="st-tile hg-hfway"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <b>Choose how you’ll sign in</b>
        <Problem text={error} />
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
          Passphrase, at least 10 characters
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
        <Button kind="primary" type="submit" busy={busy} disabled={!name.trim() || !passphrase || !again}>
          Join
        </Button>
      </form>
      <p className="body-sm muted">This link works once, until {when(invite.expiresAt)}.</p>
    </Frame>
  );
}
