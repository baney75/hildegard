// SPDX-License-Identifier: AGPL-3.0-only
import type { Catalog } from '@hildegard/presets';
import { useEffect, useState } from 'react';
import { ModelRow } from '../components/sheets.tsx';
import { Button, Icon, toast, WithCode } from '../components/ui.tsx';
import { ApiError, api, type DeviceStart } from '../lib/api.ts';
import { comfyDown } from '../lib/format.ts';
import type { WindowClass } from '../lib/hooks.ts';
import { getState, useStore } from '../lib/store.ts';

const SECTIONS = [
  { id: 'models', label: 'Models', icon: 'models' },
  { id: 'huggingface', label: 'Hugging Face', icon: 'link' },
  { id: 'computer', label: 'This computer', icon: 'desktop' },
  { id: 'privacy', label: 'Privacy', icon: 'privacy' },
  { id: 'about', label: 'About', icon: 'book' },
] as const;
type Section = (typeof SECTIONS)[number]['id'];

export function Settings({
  catalog,
  wc,
  section,
  go,
}: {
  catalog: Catalog;
  wc: WindowClass;
  section: string | null;
  go: (to: string) => void;
}) {
  const current = (SECTIONS.find((s) => s.id === section)?.id ??
    (wc === 'compact' ? null : 'models')) as Section | null;
  const title = SECTIONS.find((s) => s.id === current)?.label;
  return (
    <>
      <header className="hg-app__top">
        {wc === 'compact' && current ? (
          <Button kind="ghost" icon="chevronl" onClick={() => go('/settings')}>
            Settings
          </Button>
        ) : null}
        <div className="cs-crumb">
          <span className="t">{wc === 'compact' && current ? title : 'Settings'}</span>
        </div>
      </header>
      <main className="cs-stage hg-scroll" id="main">
        <div className="hg-settings">
          {wc !== 'compact' || !current ? (
            <nav className="st-pane hg-settings__nav" aria-label="Settings sections">
              <div className="st-vlist">
                {SECTIONS.map((s) => (
                  <a
                    key={s.id}
                    className="st-v"
                    href={`#/settings/${s.id}`}
                    aria-current={s.id === current ? 'page' : undefined}
                  >
                    <Icon name={s.icon} size={18} />
                    <span>
                      <b>{s.label}</b>
                    </span>
                    {wc === 'compact' ? <Icon name="chevronr" size={16} className="muted" /> : null}
                  </a>
                ))}
              </div>
            </nav>
          ) : null}
          {current ? (
            <div className="st-page hg-settings__body">
              {current === 'models' ? <Models catalog={catalog} go={go} /> : null}
              {current === 'huggingface' ? <HuggingFace catalog={catalog} /> : null}
              {current === 'computer' ? <Computer /> : null}
              {current === 'privacy' ? <Privacy /> : null}
              {current === 'about' ? <About /> : null}
            </div>
          ) : null}
        </div>
      </main>
    </>
  );
}

function Models({ catalog, go }: { catalog: Catalog; go: (to: string) => void }) {
  const models = useStore((s) => s.models);
  const hf = useStore((s) => s.hf);
  return (
    <section className="hg-section" aria-labelledby="models-h">
      <h2 id="models-h" className="st-h2">
        Models
      </h2>
      <p className="body-sm sec-text">
        Downloads come straight from each model's Hugging Face page to this computer and are checked file by
        file. Stop at any time; the next start picks up where it left off.
      </p>
      <div style={{ display: 'grid', gap: 12 }}>
        {catalog.models.map((m) => (
          <ModelRow
            key={m.id}
            model={m}
            detail={`${m.license} · needs a ${m.minVramGb} GB GPU or more`}
            state={models.find((x) => x.id === m.id)}
            needsLink={m.gated && !hf?.linked}
            onLink={() => go('/settings/huggingface')}
          />
        ))}
      </div>
      {catalog.models.some((m) => m.gated) ? (
        <p className="body-sm muted">
          Some models ask you to accept their license on Hugging Face before they download:{' '}
          {catalog.models
            .filter((m) => m.gated)
            .map((m, i) => (
              <span key={m.id}>
                {i ? ', ' : ''}
                <a href={m.licenseUrl} target="_blank" rel="noreferrer noopener">
                  {m.name}
                </a>
              </span>
            ))}
          .
        </p>
      ) : null}
    </section>
  );
}

function HuggingFace({ catalog }: { catalog: Catalog }) {
  const hf = useStore((s) => s.hf);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [device, setDevice] = useState<DeviceStart | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (hf?.linked) setDevice(null);
  }, [hf?.linked]);

  const run = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const browser = () =>
    run('oauth', async () => {
      // Open the tab first, inside the click, so pop-up blockers allow it.
      const tab = window.open('about:blank', '_blank');
      try {
        const { url } = await api.hfOAuth();
        if (tab) tab.location.href = url;
        else window.location.href = url;
      } catch (e) {
        tab?.close();
        if (e instanceof ApiError && e.status === 409) {
          setDevice(await api.hfDevice());
          return;
        }
        throw e;
      }
    });
  const gated = catalog.models.filter((m) => m.gated);

  if (hf?.linked) {
    return (
      <section className="hg-section" aria-labelledby="hf-h">
        <h2 id="hf-h" className="st-h2">
          Hugging Face
        </h2>
        <div className="st-tile hg-linked">
          <span className="st-dev__g">
            <Icon name="check" size={22} />
          </span>
          <span style={{ minWidth: 0 }}>
            <b>{hf.user ? `Linked as ${hf.user}` : 'Linked'}</b>
            <small className="body-sm muted">
              {hf.storage === 'keychain'
                ? 'Kept in your system keychain.'
                : hf.storage === 'file'
                  ? 'Kept in a file only your account can read (this system has no keychain).'
                  : 'Using HF_TOKEN from the environment Hildegard was started in.'}
            </small>
          </span>
          {hf.storage === 'env' ? null : (
            <Button
              kind="ghost"
              onClick={() => run('unlink', () => api.hfUnlink().then(() => toast('Hugging Face unlinked')))}
              busy={busy === 'unlink'}
            >
              Unlink
            </Button>
          )}
        </div>
        <p className="body-sm sec-text">
          Hildegard uses it only to download models. It never writes to your account and never shares it.
          {gated.length ? (
            <>
              {' '}
              Accept the license on{' '}
              {gated.map((m, i) => (
                <span key={m.id}>
                  {i ? ', ' : ''}
                  <a href={m.licenseUrl} target="_blank" rel="noreferrer noopener">
                    {m.name}'s page
                  </a>
                </span>
              ))}{' '}
              before installing it.
            </>
          ) : null}
        </p>
      </section>
    );
  }

  return (
    <section className="hg-section" aria-labelledby="hf-h">
      <h2 id="hf-h" className="st-h2">
        Link Hugging Face
      </h2>
      <p className="body-sm sec-text">
        Most models download without an account. {gated.map((m) => m.name).join(' and ') || 'Some models'} ask
        {gated.length === 1 ? 's' : ''} you to sign in and accept a license first. Hildegard only ever reads
        model files with it.
      </p>
      {error ? (
        <p className="hg-err body-sm" role="alert">
          <Icon name="alert" size={16} /> {error}
        </p>
      ) : null}

      {hf?.oauth ? (
        <div className="st-tile hg-hfway">
          <b>Sign in with your browser</b>
          <span className="body-sm muted">Opens Hugging Face in a new tab. Nothing to copy.</span>
          <Button kind="primary" icon="link" onClick={browser} busy={busy === 'oauth'}>
            Sign in with Hugging Face
          </Button>
        </div>
      ) : null}

      {hf?.oauth ? (
        <div className="st-tile hg-hfway">
          <b>Sign in from another device</b>
          {device ? (
            <div className="hg-device" aria-live="polite">
              <span className="body-sm sec-text">
                On your phone or another computer, open{' '}
                <a href={device.verificationUri} target="_blank" rel="noreferrer noopener">
                  {device.verificationUri.replace(/^https:\/\//, '').replace(/\?.*$/, '')}
                </a>{' '}
                and enter:
              </span>
              <span className="st-code hg-usercode">{device.userCode}</span>
              <span className="body-sm muted">
                <span className="hg-spin" aria-hidden="true" /> Waiting for you to approve. This page updates
                on its own.
              </span>
            </div>
          ) : (
            <>
              <span className="body-sm muted">
                For a computer without a browser, like a server. You get a short code to enter elsewhere.
              </span>
              <Button
                onClick={() => run('device', async () => setDevice(await api.hfDevice()))}
                busy={busy === 'device'}
              >
                Get a code
              </Button>
            </>
          )}
        </div>
      ) : null}

      <form
        className="st-tile hg-hfway"
        onSubmit={(e) => {
          e.preventDefault();
          void run('token', async () => {
            // Same check the server makes, without a round trip.
            if (!/^hf_[A-Za-z0-9]{20,}$/.test(token.trim()))
              throw new Error('That does not look like a Hugging Face token (they start with hf_).');
            await api.hfToken(token);
            setToken('');
            toast(`Linked as ${getState().hf?.user ?? 'your account'}`);
          });
        }}
      >
        <b>{hf?.oauth ? 'Or paste a token' : 'Paste a token'}</b>
        <ol className="body-sm sec-text hg-steps">
          <li>
            Open{' '}
            <a
              href="https://huggingface.co/settings/tokens/new?tokenType=fineGrained"
              target="_blank"
              rel="noreferrer noopener"
            >
              a new token on Hugging Face
            </a>
            .
          </li>
          <li>
            Name it Hildegard and tick only “Read access to contents of all public gated repos you can
            access”.
          </li>
          <li>Create it, copy it, and paste it here. It is checked with Hugging Face before it is kept.</li>
        </ol>
        <label className="hg-field hg-field--block">
          <span className="sr">Hugging Face token</span>
          <input
            type="password"
            value={token}
            placeholder="hf_…"
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        <Button
          kind={hf?.oauth ? undefined : 'primary'}
          type="submit"
          busy={busy === 'token'}
          disabled={!token.trim()}
        >
          Link this token
        </Button>
      </form>
      <p className="body-sm muted">
        Your token is kept in your system keychain where there is one, and in a file only your account can
        read where there is not. It is never written to Hugging Face's own cache.
      </p>
    </section>
  );
}

function Computer() {
  const engine = useStore((s) => s.engine);
  const version = useStore((s) => s.version);
  return (
    <section className="hg-section" aria-labelledby="pc-h">
      <h2 id="pc-h" className="st-h2">
        This computer
      </h2>
      <dl className="hg-kv st-tile">
        <dt>ComfyUI</dt>
        <dd>
          {engine?.online
            ? engine.paused
              ? 'Running · rendering paused'
              : 'Running'
            : comfyDown(engine).short}
        </dd>
        {!engine?.online && engine?.comfy !== 'external' ? (
          <>
            <dt>Status</dt>
            <dd>
              <WithCode text={comfyDown(engine).long} />
            </dd>
          </>
        ) : null}
        <dt>Address</dt>
        <dd className="num">{engine?.url}</dd>
        <dt>Hildegard</dt>
        <dd className="num">{version}</dd>
      </dl>
      {engine?.fake ? (
        <p className="body-sm hg-err" role="note">
          <Icon name="alert" size={16} /> This is the stand-in GPU for testing. It makes placeholder clips,
          not real video.
        </p>
      ) : null}
    </section>
  );
}

function About() {
  const version = useStore((s) => s.version);
  const source = useStore((s) => s.source);
  const code = source ? (source.commit ? `${source.url}/tree/${source.commit}` : source.url) : null;
  return (
    <section className="hg-section" aria-labelledby="ab-h">
      <h2 id="ab-h" className="st-h2">
        About Hildegard
      </h2>
      <div className="st-tile hg-prose">
        <p>
          Version <span className="num">{version}</span>
          {source?.commit ? (
            <>
              {' '}
              · build <span className="num">{source.commit.slice(0, 7)}</span>
            </>
          ) : null}
        </p>
        <p>
          Hildegard is free software under the GNU Affero General Public License 3.0. Presets, workflows and
          the film-look node are under Apache-2.0. You can read, change and share all of it.
        </p>
        <ul className="hg-links">
          {code ? (
            <li>
              <a href={code} target="_blank" rel="noreferrer noopener">
                Source code for this version
              </a>
            </li>
          ) : null}
          <li>
            <a href="./THIRD_PARTY_NOTICES.txt" target="_blank" rel="noopener">
              Third-party notices and font licenses
            </a>
          </li>
        </ul>
        <p className="body-sm muted">
          Models are not part of Hildegard. Each comes from its publisher under its own license, which you
          accept before it downloads.
        </p>
      </div>
    </section>
  );
}

function Privacy() {
  return (
    <section className="hg-section" aria-labelledby="pv-h">
      <h2 id="pv-h" className="st-h2">
        Privacy
      </h2>
      <div className="st-tile hg-prose">
        <p>
          Everything you make stays on your devices. Prompts, frames and finished takes never leave this
          computer.
        </p>
        <p>
          Hildegard answers only on this computer unless you add another address, such as your Tailscale name,
          yourself.
        </p>
        <p>
          The only connections it makes are to Hugging Face, to download the models you choose, and only with
          the account you link.
        </p>
      </div>
    </section>
  );
}
