// SPDX-License-Identifier: AGPL-3.0-only
import type { Catalog, ChoirDevice, UpdateState } from '@hildegard/presets';
import { useEffect, useState } from 'react';
import { ModelRow } from '../components/sheets.tsx';
import { Button, Icon, RadioGroup, Segmented, Status, Switch, toast, WithCode } from '../components/ui.tsx';
import { ApiError, api, type DeviceStart } from '../lib/api.ts';
import { comfyDown } from '../lib/format.ts';
import type { WindowClass } from '../lib/hooks.ts';
import { getState, isOwner, upsert, useStore } from '../lib/store.ts';
import { setThemeMode, type ThemeMode, useTheme } from '../lib/theme.ts';
import { Account, People, Sharing } from './Sharing.tsx';

const ALL = [
  { id: 'models', label: 'Models', icon: 'models', who: 'owner' },
  { id: 'huggingface', label: 'Hugging Face', icon: 'link', who: 'owner' },
  { id: 'computer', label: 'This computer', icon: 'desktop', who: 'all' },
  { id: 'devices', label: 'Devices', icon: 'server', who: 'owner' },
  { id: 'sharing', label: 'Sharing', icon: 'phone', who: 'owner' },
  { id: 'people', label: 'People', icon: 'person', who: 'owner' },
  { id: 'account', label: 'Your account', icon: 'key', who: 'signed-in' },
  { id: 'privacy', label: 'Privacy', icon: 'privacy', who: 'all' },
  { id: 'about', label: 'About', icon: 'book', who: 'all' },
] as const;
type Section = (typeof ALL)[number]['id'];

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
  const auth = useStore((s) => s.auth);
  // Directors see their own account and this Studio's look; models, devices, sharing and people are the owner's.
  const SECTIONS = ALL.filter((s) => s.who === 'all' || (s.who === 'owner' ? isOwner(auth) : !!auth?.person));
  const current = (SECTIONS.find((s) => s.id === section)?.id ??
    (wc === 'compact' ? null : SECTIONS[0]!.id)) as Section | null;
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
              {current === 'devices' ? <Devices catalog={catalog} /> : null}
              {current === 'sharing' ? <Sharing /> : null}
              {current === 'people' ? <People /> : null}
              {current === 'account' ? <Account /> : null}
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
        Downloads come straight from each model’s Hugging Face page to this computer and are checked file by
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
                    {m.name}’s page
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

      {hf?.found ? (
        <div className="st-tile hg-hfway">
          <b>Use this computer’s Hugging Face sign-in</b>
          <span className="body-sm muted">
            You’re signed in with Hugging Face’s own tools here. Hildegard checks that sign-in with Hugging
            Face, then keeps a copy in your keychain.
          </span>
          <Button
            kind="primary"
            icon="check"
            onClick={() =>
              run('import', async () => {
                const s = await api.hfImport();
                toast(`Linked as ${s.user ?? 'your account'}`);
              })
            }
            busy={busy === 'import'}
          >
            Use it
          </Button>
        </div>
      ) : null}

      {hf?.oauth ? (
        <div className="st-tile hg-hfway">
          <b>{hf.found ? 'Or sign in with your browser' : 'Sign in with your browser'}</b>
          <span className="body-sm muted">Opens Hugging Face in a new tab. Nothing to copy.</span>
          <Button
            kind={hf.found ? undefined : 'primary'}
            icon="link"
            onClick={browser}
            busy={busy === 'oauth'}
          >
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
          kind={hf?.oauth || hf?.found ? undefined : 'primary'}
          type="submit"
          busy={busy === 'token'}
          disabled={!token.trim()}
        >
          Link this token
        </Button>
      </form>
      <p className="body-sm muted">
        Your token is kept in your system keychain where there is one, and in a file only your account can
        read where there is not. It is never written to Hugging Face’s own cache.
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
        {engine?.comfy === 'remote' ? (
          <>
            <dt>Takes</dt>
            <dd>
              Render on {engine.device}. <a href="#/settings/devices">Devices</a>
            </dd>
          </>
        ) : null}
        <dt>ComfyUI</dt>
        <dd>
          {engine?.comfy === 'remote'
            ? 'Not used while takes render on another device'
            : engine?.online
              ? engine.paused
                ? 'Running · rendering paused'
                : 'Running'
              : comfyDown(engine).short}
        </dd>
        {!engine?.online && engine?.comfy !== 'external' && engine?.comfy !== 'remote' ? (
          <>
            <dt>Status</dt>
            <dd>
              <WithCode text={comfyDown(engine).long} />
            </dd>
          </>
        ) : null}
        {engine?.url ? (
          <>
            <dt>Address</dt>
            <dd className="num">{engine.url}</dd>
          </>
        ) : null}
        <dt>Hildegard</dt>
        <dd className="num">{version}</dd>
      </dl>
      <Appearance />
      {engine?.fake ? (
        <p className="body-sm hg-note" role="note">
          <Icon name="alert" size={16} /> This is the stand-in GPU for testing. It makes placeholder clips,
          not real video.
        </p>
      ) : null}
    </section>
  );
}

function Appearance() {
  const { mode } = useTheme();
  return (
    <div className="st-tile hg-hfway">
      <b id="ap-h">Appearance</b>
      <span className="body-sm muted">
        Hildegard opens dark, which is kindest to your films. Choose light, or follow this device’s own
        setting. The choice is kept in this browser.
      </span>
      <Segmented<ThemeMode>
        label="Appearance"
        value={mode}
        onChange={setThemeMode}
        options={[
          { value: 'dark', label: 'Dark' },
          { value: 'light', label: 'Light' },
          { value: 'system', label: 'Match this device' },
        ]}
      />
    </div>
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
      <Updates />
    </section>
  );
}

function Updates() {
  const u = useStore((s) => s.update);
  const owner = isOwner(useStore((s) => s.auth));
  const [busy, setBusy] = useState<string | null>(null);
  if (!u) return null;
  const run = async (name: string, fn: () => Promise<UpdateState>) => {
    setBusy(name);
    try {
      upsert({ type: 'update', update: await fn() });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { tone: 'error' });
    } finally {
      setBusy(null);
    }
  };
  const said = u.applying
    ? `Updating to ${u.available}. Hildegard starts again as the new version, and this page reconnects by itself.`
    : u.available
      ? `Hildegard ${u.available} is out. This is ${u.current}.`
      : u.error
        ? `Couldn’t check for updates: ${u.error}`
        : u.checkedAt
          ? `Hildegard ${u.current} is up to date.`
          : `This is Hildegard ${u.current}. It looks for a new release every six hours.`;
  return (
    <div className="st-tile hg-hfway">
      <b id="up-h">Updates</b>
      <span className="body-sm muted" aria-live="polite">
        {said}
      </span>
      {!u.updatable ? (
        <span className="body-sm muted">
          This Hildegard runs from its source code, so it updates with git.
        </span>
      ) : owner ? (
        <>
          {u.available && !u.applying ? (
            <Button kind="primary" busy={busy === 'now'} onClick={() => run('now', api.updateNow)}>
              Update to {u.available}
            </Button>
          ) : null}
          {!u.available ? (
            <Button kind="ghost" busy={busy === 'check'} onClick={() => run('check', api.updateCheck)}>
              Check now
            </Button>
          ) : null}
          <Segmented<'on' | 'off'>
            label="When a release is out"
            value={u.auto ? 'on' : 'off'}
            onChange={(v) => run('auto', () => api.updateAuto(v === 'on'))}
            options={[
              { value: 'on', label: 'Update by itself' },
              { value: 'off', label: 'Ask me first' },
            ]}
          />
          <span className="body-sm muted">
            Updates are signed, and Hildegard refuses any that aren’t. Updating by itself waits until nothing
            is rendering or downloading.
          </span>
        </>
      ) : null}
    </div>
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
          Everything you make stays on your devices. Prompts, frames and finished takes go only to the devices
          you pair in Settings › Devices, over your own tailnet.
        </p>
        <p>
          Hildegard answers only on this computer until you put it at a link in Settings › Sharing. Then
          everyone else signs in, and each person you invite sees only their own films.
        </p>
        <p>
          The only connections it makes are to Hugging Face, to download the models you choose, and only with
          the account you link.
        </p>
      </div>
    </section>
  );
}

/** "RTX 4080 Laptop, 12 GB · Wan 2.2 5B", or why it isn’t answering. */
function deviceDetail(d: ChoirDevice, catalog: Catalog): string {
  if (!d.online) return d.problem ?? 'Not answering yet.';
  const models = d.models.map((id) => catalog.models.find((m) => m.id === id)?.name ?? id);
  const u = d.update;
  const version = u?.applying
    ? `Updating to ${u.available}`
    : u?.waiting
      ? `Updates to ${u.available} after its render`
      : d.version
        ? `Hildegard ${d.version}`
        : null;
  return [d.gpu ?? 'GPU unknown', models.length ? models.join(', ') : 'No models yet', version]
    .filter(Boolean)
    .join(' · ');
}

function Devices({ catalog }: { catalog: Catalog }) {
  const choir = useStore((s) => s.choir);
  const engine = useStore((s) => s.engine);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [invite, setInvite] = useState<{ code: string; url: string } | null>(null);
  const [url, setUrl] = useState('');
  // Undefined until known: null means Tailscale isn’t up here, so the owner gives the address.
  const [tailnet, setTailnet] = useState<string | null | undefined>(undefined);

  // Ask every device how it is when the page opens; the one in use is watched all the time anyway.
  useEffect(() => {
    void api.choir().catch(() => {});
    api
      .choirTailnet()
      .then((t) => setTailnet(t.url))
      .catch(() => setTailnet(null));
  }, []);
  const askUrl = tailnet === null && !choir?.sharing.on;
  // While a device updates it restarts, so ask again until it's back as the new version.
  const updating = (choir?.devices ?? []).some((d) => d.update?.applying || d.update?.waiting || !d.online);
  useEffect(() => {
    if (!updating) return;
    const t = setInterval(() => void api.choir().catch(() => {}), 10_000);
    return () => clearInterval(t);
  }, [updating]);

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
  const share = () =>
    run('share', async () => {
      setInvite(await api.choirInvite(askUrl ? url.trim() : undefined));
    });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(invite?.code ?? '');
      toast('Copied');
    } catch {
      toast('Couldn’t copy. Select the code and copy it yourself.', { tone: 'error' });
    }
  };
  const use = choir?.use ?? 'local';
  const here = use === 'local';
  const sharing = choir?.sharing;

  return (
    <section className="hg-section" aria-labelledby="dv-h">
      <h2 id="dv-h" className="st-h2">
        Devices
      </h2>
      <p className="body-sm sec-text">
        Render on another computer you own, such as a desktop with a big GPU. Devices pair over Tailscale, and
        prompts and takes travel only between them.
      </p>
      {error ? (
        <p className="hg-err body-sm" role="alert">
          <Icon name="alert" size={16} /> {error}
        </p>
      ) : null}

      <RadioGroup label="Use for renders" className="st-tile hg-devices">
        <div className="hg-devices__row">
          <span className="st-dev__g">
            <Icon name="desktop" size={22} />
          </span>
          <span className="hg-devices__name">
            <b>This computer</b>
            <small className="body-sm muted">
              {here ? (engine?.online ? 'Renders here' : comfyDown(engine).short) : 'Standing by'}
              {sharing?.on ? ' · Shares its GPU' : ''}
            </small>
          </span>
          <span className="hg-devices__act">
            <button
              type="button"
              role="radio"
              className="hg-use"
              aria-checked={here}
              tabIndex={here ? 0 : -1}
              aria-label="Use this computer for renders"
              onClick={() => !here && void run('use', () => api.choirUse('local'))}
            >
              <Icon name="check" size={16} /> Use for renders
            </button>
          </span>
        </div>
        {(choir?.devices ?? []).map((d) => {
          const on = use === d.name;
          return (
            <div className="hg-devices__row" key={d.name}>
              <span className="st-dev__g">
                <Icon name="server" size={22} />
              </span>
              <span className="hg-devices__name">
                <b>
                  {d.name}{' '}
                  <Status kind={d.online ? 'done' : 'error'}>{d.online ? 'Online' : 'Not answering'}</Status>
                </b>
                <small className="body-sm muted">{deviceDetail(d, catalog)}</small>
              </span>
              <span className="hg-devices__act">
                <button
                  type="button"
                  role="radio"
                  className="hg-use"
                  aria-checked={on}
                  tabIndex={on ? 0 : -1}
                  aria-label={`Use ${d.name} for renders`}
                  onClick={() => !on && void run('use', () => api.choirUse(d.name))}
                >
                  <Icon name="check" size={16} /> Use for renders
                </button>
                {d.online &&
                d.update?.updatable &&
                d.update.available &&
                !d.update.applying &&
                !d.update.waiting ? (
                  <Button
                    kind="primary"
                    size="sm"
                    busy={busy === `update-${d.name}`}
                    onClick={() =>
                      run(`update-${d.name}`, async () => {
                        const r = await api.choirUpdate(d.name);
                        toast(
                          r.device.update?.waiting
                            ? `${d.name} updates once its render finishes`
                            : `${d.name} is updating to ${r.device.update?.available ?? 'the newest release'}`,
                        );
                      })
                    }
                  >
                    Update to {d.update.available}
                  </Button>
                ) : null}
                <Button
                  kind="ghost"
                  size="sm"
                  icon="trash"
                  aria-label={`Remove ${d.name}`}
                  busy={busy === `leave-${d.name}`}
                  onClick={() =>
                    run(`leave-${d.name}`, async () => {
                      await api.choirLeave(d.name);
                      toast(`Removed ${d.name}`);
                    })
                  }
                />
              </span>
            </div>
          );
        })}
      </RadioGroup>

      <form
        className="st-tile hg-hfway"
        onSubmit={(e) => {
          e.preventDefault();
          void run('join', async () => {
            const r = await api.choirJoin(code);
            setCode('');
            toast(
              r.choir.use === r.device.name
                ? `Takes now render on ${r.device.name}`
                : `Added ${r.device.name}`,
            );
          });
        }}
      >
        <b>Add a device</b>
        <span className="body-sm muted">
          On the device with the GPU, open Settings › Devices and choose Share this GPU, or run{' '}
          <code>hildegard choir invite</code>. Then paste its code here.
        </span>
        <label className="hg-field hg-field--block">
          <span className="sr">Join code</span>
          <input
            type="password"
            value={code}
            placeholder="hgc1_…"
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
        <Button type="submit" busy={busy === 'join'} disabled={!code.trim()}>
          Add device
        </Button>
      </form>

      <div className="st-tile hg-hfway">
        <b>{sharing?.on ? 'Sharing this GPU' : 'Share this GPU'}</b>
        {invite ? (
          <>
            <span className="body-sm sec-text">
              Paste this code on your other device. It pairs one device; keep it private.
            </span>
            <div className="hg-code hg-joincode">
              {/* biome-ignore lint/a11y/noNoninteractiveTabindex: it scrolls sideways, so keyboards must be able to reach it. */}
              <pre role="region" tabIndex={0} aria-label="Join code">
                {invite.code}
              </pre>
              <Button kind="ghost" size="sm" icon="copy" onClick={copy}>
                Copy
              </Button>
            </div>
          </>
        ) : (
          <span className="body-sm muted">
            {sharing?.on
              ? `Paired devices reach this computer at ${sharing.url}.`
              : 'Let your other devices render on this computer’s GPU. They reach it over Tailscale, with a code only they have.'}
          </span>
        )}
        {sharing?.problem ? (
          <p className="hg-err body-sm" role="note">
            <Icon name="alert" size={16} /> {sharing.problem}
          </p>
        ) : null}
        {sharing?.on ? (
          <div className="hg-devices__opp">
            <span className="body-sm">
              <b>Only when it’s free</b>
              <br />
              <span className="muted">
                {sharing.opportunistic
                  ? 'Your other devices’ renders wait behind this computer’s own work, stop when its own work arrives, and start only while nothing else is using it.'
                  : 'Your other devices’ renders run here when their turn comes, alongside this computer’s own in one line.'}
                {sharing.opportunistic && sharing.busyCheck === 'load'
                  ? ' This computer can’t see its GPU’s use, so it goes by how busy the processor is.'
                  : ''}
                {sharing.opportunistic && sharing.busyCheck === 'gpu-unknown'
                  ? ' The NVIDIA driver isn’t answering (restart this computer after a driver update), so they wait until it does.'
                  : ''}
                {sharing.opportunistic && sharing.busyCheck === 'none'
                  ? ' This computer can’t tell when it’s busy, so they wait only for Hildegard’s own work here.'
                  : ''}
              </span>
            </span>
            <Switch
              checked={sharing.opportunistic}
              label="Only render for other devices when this computer is free"
              onChange={(on) => void run('opportunistic', () => api.choirOpportunistic(on))}
            />
          </div>
        ) : null}
        {askUrl && !invite ? (
          <label className="hg-field hg-field--block">
            Tailscale isn’t running here. Start it, or give the address your other devices reach this computer
            at
            <input
              type="url"
              value={url}
              placeholder="http://100.101.102.103:7341"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
        ) : null}
        <div className="hg-devices__btns">
          <Button
            kind={sharing?.on ? undefined : 'primary'}
            icon="link"
            onClick={share}
            busy={busy === 'share'}
            disabled={tailnet === undefined || (askUrl && !url.trim())}
          >
            {sharing?.on ? 'New code' : 'Share this GPU'}
          </Button>
          {sharing?.on ? (
            <Button
              kind="ghost"
              onClick={() =>
                run('revoke', async () => {
                  await api.choirRevoke();
                  setInvite(null);
                  toast('This computer no longer shares its GPU');
                })
              }
              busy={busy === 'revoke'}
            >
              Stop sharing
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
