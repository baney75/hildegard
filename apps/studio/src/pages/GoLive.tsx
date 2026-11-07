// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Go live: stream the screen, the camera and the microphone to YouTube, X, Twitch, Kick or any RTMP server, from
 * Hildegard, or run OBS from here. Starting is for the person at this computer; the owner on another device can switch
 * scenes, mute and stop. A stream key is typed into a password box, goes to the keychain, and is never shown again.
 */
import type {
  ObsState,
  StreamDestinationId,
  StreamDestinationView,
  StreamDevices,
  StreamPreflight,
  StreamScene,
  StreamState,
} from '@hildegard/presets';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  Icon,
  Segmented,
  Status,
  type StatusKind,
  Switch,
  toast,
  toastError,
} from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import type { WindowClass } from '../lib/hooks.ts';
import { STREAM_QUALITY, STREAM_SCENES } from '../lib/stream.ts';

const clock = (s: number | null) => {
  if (s === null) return '0:00';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(s % 60).padStart(2, '0')}`;
};

const DEST_STATE: Record<StreamDestinationView['state'], [StatusKind, string]> = {
  off: ['idle', 'Ready'],
  connecting: ['running', 'Connecting'],
  live: ['done', 'Live'],
  failed: ['error', 'Not connected'],
};
const CHECK: Record<'pass' | 'warn' | 'fail', StatusKind> = { pass: 'done', warn: 'queued', fail: 'error' };

type Obs = ObsState & { passwordSaved: boolean };

function useStream() {
  const [state, setRaw] = useState<StreamState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A poll that was asked before an action finished must not overwrite what the action just returned.
  const seq = useRef(0);
  const setState = useCallback((s: StreamState) => {
    seq.current += 1;
    setRaw(s);
  }, []);
  const refresh = useCallback(async () => {
    const asked = seq.current;
    try {
      const s = await api.stream();
      if (asked === seq.current) setRaw(s);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 1000);
    return () => clearInterval(t);
  }, [refresh]);
  return { state, setState, error, refresh };
}

export function GoLive({ wc }: { wc: WindowClass }) {
  const { state, setState, error } = useStream();
  const [devices, setDevices] = useState<StreamDevices | null>(null);
  const [check, setCheck] = useState<StreamPreflight | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string[] | null>(null);
  const [obs, setObs] = useState<Obs | null>(null);
  const [previewKey, setPreviewKey] = useState(0);
  const ownPreview = useRef(false);
  const here = !!state?.canStart;

  useEffect(() => {
    document.title = 'Go live · Hildegard';
  }, []);

  // Devices and OBS live on this computer: asked for only from here.
  useEffect(() => {
    if (!here) return;
    api
      .streamDevices()
      .then(setDevices)
      .catch(() => {});
    api
      .obs()
      .then(setObs)
      .catch(() => {});
  }, [here]);

  // Leaving the page turns off a preview it started, so a camera light doesn’t stay on.
  useEffect(
    () => () => {
      if (ownPreview.current) void api.streamPreview(false).catch(() => {});
    },
    [],
  );

  const phase = state?.phase ?? 'idle';
  const on = phase === 'live' || phase === 'countdown' || phase === 'reconnecting' || phase === 'stopping';
  const s = state?.settings;

  const act = async (name: string, f: () => Promise<StreamState | undefined>) => {
    setBusy(name);
    try {
      const r = await f();
      if (r) setState(r);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };
  const patch = (p: Record<string, unknown>) => act('settings', () => api.streamSettings(p));

  const startPreview = () =>
    act('preview', async () => {
      ownPreview.current = true;
      setPreviewKey((k) => k + 1);
      return api.streamPreview(true);
    });

  const goLive = () =>
    act('golive', async () => {
      const r = await api.streamPreflight();
      setCheck(r);
      if (!r.ok) {
        toast('Fix what’s marked below, then try again.', { tone: 'error' });
        return undefined;
      }
      ownPreview.current = false;
      return api.streamGoLive();
    });

  const showLog = async () => setLog((await api.streamLog().catch(() => ({ lines: [] as string[] }))).lines);

  if (!state || !s) {
    return (
      <>
        <header className="hg-app__top">
          <div className="cs-crumb">
            <span className="t">Go live</span>
          </div>
        </header>
        <main className="cs-stage hg-scroll" id="main">
          <div className="st-page hg-narrow">
            <p className="body-sm muted">{error ?? 'Looking at the stream…'}</p>
          </div>
        </main>
      </>
    );
  }

  const scenes = STREAM_SCENES.filter(
    (sc) =>
      sc.id === 'starting' ||
      sc.id === 'brb' ||
      (sc.id === 'screen' && s.sources.screen) ||
      (sc.id === 'camera' && s.sources.camera) ||
      (sc.id === 'pip' && s.sources.screen && s.sources.camera),
  );
  const showPicture =
    here && (phase === 'preview' || phase === 'countdown' || phase === 'live' || phase === 'reconnecting');
  const sub =
    phase === 'live'
      ? `Live ${clock(state.seconds)}`
      : phase === 'countdown'
        ? `Going live in ${state.countdown}`
        : phase === 'reconnecting'
          ? 'Reconnecting'
          : phase === 'preview'
            ? 'Not live. Setting up'
            : 'Not live';

  return (
    <>
      <header className="hg-app__top">
        <div className="cs-crumb">
          <span className="t">Go live</span>
          <span className="s">{sub}</span>
        </div>
        <div className="hg-app__topactions">
          {on ? (
            <Button
              kind="danger"
              icon="stop"
              onClick={() => act('stop', api.streamStop)}
              busy={busy === 'stop'}
            >
              Stop
            </Button>
          ) : null}
        </div>
      </header>
      <main className="cs-stage hg-scroll" id="main">
        <div className="st-page hg-narrow lv">
          {!here ? (
            <p className="st-tile body-sm" role="note">
              <Icon name="desktop" size={18} /> Setting up and starting a stream happens on the computer
              Hildegard runs on, because it uses that computer’s screen and camera. From here you can switch
              scenes, mute and stop.
            </p>
          ) : null}
          {state.message ? (
            <p className="lv-msg st-tile" role="status">
              <Icon name="alert" size={18} />
              <span>{state.message}</span>
              {here ? (
                <Button kind="ghost" size="sm" onClick={showLog}>
                  Show details
                </Button>
              ) : null}
            </p>
          ) : null}
          {log ? (
            <div className="lv-log st-tile">
              <p className="body-sm muted">FFmpeg’s last lines</p>
              <pre>{log.length ? log.join('\n') : 'Nothing was written.'}</pre>
            </div>
          ) : null}

          <section className="hg-section" aria-labelledby="lv-pic">
            <h2 id="lv-pic" className="st-h2">
              Picture
            </h2>
            <div className="lv-stage st-tile">
              <div className="lv-view" data-live={phase === 'live' ? '' : undefined}>
                {showPicture ? (
                  <img
                    key={previewKey}
                    src={`/api/stream/preview.mjpg?k=${previewKey}`}
                    alt="What viewers will see"
                    className="lv-img"
                  />
                ) : (
                  <div className="lv-empty">
                    {here ? (
                      <Button icon="play" onClick={startPreview} busy={busy === 'preview'}>
                        Show a preview
                      </Button>
                    ) : (
                      <span className="body-sm muted">
                        The preview shows on the computer Hildegard runs on.
                      </span>
                    )}
                  </div>
                )}
                {phase === 'countdown' ? (
                  <div className="lv-count" role="timer" aria-live="polite">
                    <b>{state.countdown}</b>
                    <Button kind="ghost" onClick={() => act('cancel', api.streamCancel)}>
                      Cancel
                    </Button>
                  </div>
                ) : null}
                {phase === 'live' ? <span className="lv-badge">Live {clock(state.seconds)}</span> : null}
              </div>
              <div className="lv-bar">
                <Segmented<StreamScene>
                  label="Scene"
                  value={s.scene}
                  options={scenes.map((sc) => ({ value: sc.id, label: sc.name }))}
                  onChange={(v) => patch({ scene: v })}
                />
                <div className="lv-switch">
                  <Switch checked={s.mute} onChange={(v) => patch({ mute: v })} label="Mute the microphone" />
                  <span aria-hidden="true">{s.mute ? 'Muted' : 'Mic on'}</span>
                </div>
              </div>
              {phase === 'live' || phase === 'reconnecting' ? <Stats state={state} /> : null}
            </div>
          </section>

          {here ? (
            <>
              <section className="hg-section" aria-labelledby="lv-where">
                <h2 id="lv-where" className="st-h2">
                  Where to
                </h2>
                <div className="hg-stack">
                  {state.destinations.map((d) => (
                    <Destination
                      key={d.id}
                      d={d}
                      locked={on}
                      onToggle={(v) => patch({ destinations: { [d.id]: { enabled: v } } })}
                      onServer={(server) => patch({ destinations: { [d.id]: { server: server || null } } })}
                      onKey={(key) => act('key', () => api.streamKey(d.id, key))}
                      onRemove={() => act('key', () => api.streamKeyRemove(d.id))}
                    />
                  ))}
                  <div className="lv-row st-tile">
                    <span>
                      <b>Keep a copy on this computer</b>
                      <small className="body-sm muted">
                        Saved as a video file you can edit or post later.
                      </small>
                    </span>
                    <Switch
                      checked={s.record}
                      onChange={(v) => patch({ record: v })}
                      label="Keep a copy on this computer"
                    />
                  </div>
                </div>
              </section>

              <section className="hg-section" aria-labelledby="lv-src">
                <h2 id="lv-src" className="st-h2">
                  Sources and quality
                </h2>
                <div className="st-tile lv-grid">
                  {(['screen', 'camera', 'mic'] as const).map((kind) => {
                    const list =
                      devices?.[kind === 'screen' ? 'screens' : kind === 'camera' ? 'cameras' : 'mics'] ?? [];
                    const name = { screen: 'Screen', camera: 'Camera', mic: 'Microphone' }[kind];
                    return (
                      <label key={kind} className="hg-field hg-field--block">
                        <span>{name}</span>
                        <select
                          className="hg-select"
                          value={s.sources[kind] ?? ''}
                          disabled={on}
                          onChange={(e) => patch({ sources: { [kind]: e.target.value || null } })}
                        >
                          <option value="">None</option>
                          {list.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    );
                  })}
                  <div className="hg-field hg-field--block">
                    <span id="lv-q">Quality</span>
                    <Segmented
                      label="Quality"
                      value={s.quality}
                      options={(Object.keys(STREAM_QUALITY) as (keyof typeof STREAM_QUALITY)[]).map((q) => ({
                        value: q,
                        label: `${STREAM_QUALITY[q].height}p${STREAM_QUALITY[q].fps}`,
                        disabled: on,
                      }))}
                      onChange={(v) => patch({ quality: v })}
                    />
                  </div>
                  <div className="hg-field hg-field--block">
                    <span id="lv-pip">Camera over screen</span>
                    <div className="lv-pipopts">
                      <select
                        className="hg-select"
                        aria-label="Corner"
                        value={s.pip.corner}
                        disabled={on}
                        onChange={(e) => patch({ pip: { corner: e.target.value } })}
                      >
                        <option value="tl">Top left</option>
                        <option value="tr">Top right</option>
                        <option value="bl">Bottom left</option>
                        <option value="br">Bottom right</option>
                      </select>
                      <select
                        className="hg-select"
                        aria-label="Camera size"
                        value={s.pip.size}
                        disabled={on}
                        onChange={(e) => patch({ pip: { size: Number(e.target.value) } })}
                      >
                        <option value="16">Small</option>
                        <option value="24">Medium</option>
                        <option value="34">Large</option>
                      </select>
                    </div>
                  </div>
                  <div className="hg-field hg-field--block">
                    <span>Video encoder</span>
                    <Segmented
                      label="Video encoder"
                      value={s.encoder}
                      options={[
                        { value: 'auto', label: 'Video card if there is one', disabled: on },
                        { value: 'software', label: 'Processor', disabled: on },
                      ]}
                      onChange={(v) => patch({ encoder: v })}
                    />
                  </div>
                </div>
                {devices?.notes.map((n) => (
                  <p key={n} className="body-sm muted">
                    {n}
                  </p>
                ))}
              </section>

              <section className="hg-section" aria-labelledby="lv-on">
                <h2 id="lv-on" className="st-h2">
                  On screen
                </h2>
                <TextTile
                  title="Lower third"
                  hint="Your name and a line under it, over the picture."
                  on={s.lowerThird.on}
                  onToggle={(v) => patch({ lowerThird: { on: v } })}
                  fields={[
                    {
                      label: 'Name',
                      value: s.lowerThird.name,
                      save: (v) => patch({ lowerThird: { name: v } }),
                    },
                    {
                      label: 'Title',
                      value: s.lowerThird.title,
                      save: (v) => patch({ lowerThird: { title: v } }),
                    },
                  ]}
                />
                <TextTile
                  title="Caption"
                  hint="A line of text near the bottom. Change it any time, even when you’re live."
                  on={s.caption.on}
                  onToggle={(v) => patch({ caption: { on: v } })}
                  fields={[
                    { label: 'Text', value: s.caption.text, save: (v) => patch({ caption: { text: v } }) },
                  ]}
                />
                <label className="hg-field hg-field--block st-tile">
                  <span>Logo</span>
                  <input
                    defaultValue={s.logo ?? ''}
                    placeholder="/path/to/logo.png"
                    spellCheck={false}
                    disabled={on}
                    onBlur={(e) => {
                      if ((e.target.value || null) !== s.logo)
                        void patch({ logo: e.target.value.trim() || null });
                    }}
                  />
                  <small className="body-sm muted">
                    A PNG or JPEG on this computer. It sits in the top right corner.
                  </small>
                </label>
              </section>

              {obs?.found ? <ObsTile obs={obs} setObs={setObs} destinations={state.destinations} /> : null}

              {check ? (
                <section className="hg-section" aria-labelledby="lv-check">
                  <h2 id="lv-check" className="st-h2">
                    Before you go live
                  </h2>
                  <ul className="lv-checks st-tile">
                    {check.checks.map((c) => (
                      <li key={`${c.id}:${c.detail}`}>
                        <Status kind={CHECK[c.status]}>{c.label}</Status>
                        <span className="body-sm">{c.detail}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {!on ? (
                <div className="lv-go">
                  <Button
                    onClick={() =>
                      act('check', async () => {
                        setCheck(await api.streamPreflight());
                        return undefined;
                      })
                    }
                    busy={busy === 'check'}
                  >
                    Check everything
                  </Button>
                  <Button kind="primary" size="lg" icon="play" onClick={goLive} busy={busy === 'golive'}>
                    Go live
                  </Button>
                </div>
              ) : null}
            </>
          ) : null}
          {on ? (
            <div className="lv-go">
              <Button
                kind="danger"
                size="lg"
                icon="stop"
                onClick={() => act('stop', api.streamStop)}
                busy={busy === 'stop'}
              >
                Stop the stream
              </Button>
            </div>
          ) : null}
          {wc === 'compact' ? <div className="lv-pad" /> : null}
        </div>
      </main>
    </>
  );
}

function Stats({ state }: { state: StreamState }) {
  const st = state.stats;
  const slow = st.speed !== null && st.speed < 0.97;
  return (
    <dl className="lv-stats" aria-label="How the stream is going">
      <div>
        <dt>Bit rate</dt>
        <dd className="num">{st.kbps !== null ? `${st.kbps.toLocaleString()} kbps` : '…'}</dd>
      </div>
      <div>
        <dt>Frames</dt>
        <dd className="num">{st.fps !== null ? `${Math.round(st.fps)} a second` : '…'}</dd>
      </div>
      <div>
        <dt>Dropped</dt>
        <dd className="num" data-bad={st.dropped > 0 ? '' : undefined}>
          {st.dropped}
        </dd>
      </div>
      <div>
        <dt>Computer</dt>
        <dd className="num" data-bad={slow ? '' : undefined}>
          {st.cpu !== null ? `${Math.round(st.cpu)}% of a core` : '…'}
          {st.gpu !== null ? `, video card ${Math.round(st.gpu)}%` : ''}
        </dd>
      </div>
      <div>
        <dt>Encoder</dt>
        <dd>{state.encoder ?? '…'}</dd>
      </div>
      {slow ? (
        <p className="body-sm lv-warn" role="status">
          This computer can’t keep up. Lower the quality, or close other apps.
        </p>
      ) : null}
    </dl>
  );
}

function Destination({
  d,
  locked,
  onToggle,
  onServer,
  onKey,
  onRemove,
}: {
  d: StreamDestinationView;
  locked: boolean;
  onToggle: (v: boolean) => void;
  onServer: (v: string) => void;
  onKey: (key: string) => void;
  onRemove: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [key, setKey] = useState('');
  const [st, label] = DEST_STATE[d.state];
  const needKey = !d.keySet;
  return (
    <div className="st-tile lv-dest" data-on={d.enabled ? '' : undefined}>
      <div className="lv-dest__h">
        <span>
          <b>{d.name}</b>
          <small className="body-sm muted">{needKey ? 'No stream key yet' : 'Stream key saved'}</small>
        </span>
        {d.enabled ? <Status kind={st}>{label}</Status> : null}
        <Switch checked={d.enabled} onChange={onToggle} label={`Stream to ${d.name}`} />
      </div>
      {d.detail ? (
        <p className="body-sm lv-warn" role="status">
          {d.detail}
        </p>
      ) : null}
      {d.serverFromAccount ? (
        <label className="hg-field hg-field--block">
          <span>Server address</span>
          <input
            defaultValue={d.server}
            placeholder="rtmps://…/live"
            spellCheck={false}
            autoComplete="off"
            disabled={locked}
            onBlur={(e) => {
              if (e.target.value.trim() !== d.server) onServer(e.target.value.trim());
            }}
          />
        </label>
      ) : null}
      {adding || (d.enabled && needKey) ? (
        <form
          className="lv-keyform"
          onSubmit={(e) => {
            e.preventDefault();
            if (!key.trim()) return;
            onKey(key.trim());
            setKey('');
            setAdding(false);
          }}
        >
          <label className="hg-field hg-field--block">
            <span>Stream key</span>
            <input
              type="password"
              value={key}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              placeholder="Paste it here"
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          <small className="body-sm muted">
            {d.keyHelp} It goes to your keychain and is never shown again.
          </small>
          <div className="lv-keyform__acts">
            <Button type="submit" kind="primary" disabled={!key.trim()}>
              Save key
            </Button>
            {adding ? (
              <Button kind="ghost" onClick={() => setAdding(false)}>
                Not now
              </Button>
            ) : null}
          </div>
        </form>
      ) : (
        <div className="lv-dest__acts">
          <Button kind="ghost" size="sm" disabled={locked} onClick={() => setAdding(true)}>
            {needKey ? 'Add stream key' : 'Replace key'}
          </Button>
          {!needKey ? (
            <Button kind="ghost" size="sm" disabled={locked} onClick={onRemove}>
              Remove key
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

function TextTile({
  title,
  hint,
  on,
  onToggle,
  fields,
}: {
  title: string;
  hint: string;
  on: boolean;
  onToggle: (v: boolean) => void;
  fields: { label: string; value: string; save: (v: string) => void }[];
}) {
  return (
    <div className="st-tile lv-text">
      <div className="lv-dest__h">
        <span>
          <b>{title}</b>
          <small className="body-sm muted">{hint}</small>
        </span>
        <Switch checked={on} onChange={onToggle} label={title} />
      </div>
      <div className="lv-grid">
        {fields.map((f) => (
          <label key={f.label} className="hg-field hg-field--block">
            <span>{f.label}</span>
            <input
              defaultValue={f.value}
              maxLength={120}
              onBlur={(e) => {
                if (e.target.value !== f.value) f.save(e.target.value);
              }}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

function ObsTile({
  obs,
  setObs,
  destinations,
}: {
  obs: Obs;
  setObs: (o: Obs) => void;
  destinations: StreamDestinationView[];
}) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<Obs>) => {
    setBusy(true);
    try {
      setObs(await f());
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="hg-section" aria-labelledby="lv-obs">
      <h2 id="lv-obs" className="st-h2">
        OBS Studio
      </h2>
      <div className="st-tile lv-obs">
        <p className="body-sm">
          OBS is running on this computer{obs.version ? ` (version ${obs.version})` : ''}. You can stream with
          it instead, and run it from here.
        </p>
        {obs.needsPassword ? (
          <form
            className="lv-keyform"
            onSubmit={(e) => {
              e.preventDefault();
              if (!pw) return;
              const p = pw;
              setPw('');
              void run(() => api.obsPassword(p));
            }}
          >
            <label className="hg-field hg-field--block">
              <span>OBS WebSocket password</span>
              <input type="password" value={pw} autoComplete="off" onChange={(e) => setPw(e.target.value)} />
            </label>
            <small className="body-sm muted">
              {obs.detail ?? 'OBS has a password on.'} It’s in OBS under Tools, WebSocket Server Settings. It
              goes to your keychain.
            </small>
            <Button type="submit" kind="primary" disabled={!pw} busy={busy}>
              Connect
            </Button>
          </form>
        ) : obs.connected ? (
          <>
            <div className="hg-field hg-field--block">
              <span>OBS scene</span>
              <select
                className="hg-select"
                aria-label="OBS scene"
                value={obs.currentScene ?? ''}
                disabled={busy}
                onChange={(e) => void run(() => api.obsScene(e.target.value))}
              >
                {obs.scenes.map((sc) => (
                  <option key={sc}>{sc}</option>
                ))}
              </select>
            </div>
            <div className="hg-field hg-field--block">
              <span>Send OBS to</span>
              <div className="lv-dest__acts">
                {destinations
                  .filter((d) => d.keySet)
                  .map((d) => (
                    <Button
                      key={d.id}
                      size="sm"
                      disabled={busy || obs.streaming}
                      onClick={() => void run(() => api.obsService(d.id as StreamDestinationId))}
                    >
                      {d.name}
                    </Button>
                  ))}
              </div>
              <small className="body-sm muted">
                Sets OBS’s stream service to a place you’ve saved a key for.
              </small>
            </div>
            <div className="lv-dest__acts">
              {obs.streaming ? (
                <Button
                  kind="danger"
                  icon="stop"
                  onClick={() => void run(() => api.obsStream(false))}
                  busy={busy}
                >
                  Stop OBS’s stream
                </Button>
              ) : (
                <Button
                  kind="primary"
                  icon="play"
                  onClick={() => void run(() => api.obsStream(true))}
                  busy={busy}
                >
                  Start OBS’s stream
                </Button>
              )}
            </div>
          </>
        ) : (
          <p className="body-sm muted">{obs.detail}</p>
        )}
      </div>
    </section>
  );
}
