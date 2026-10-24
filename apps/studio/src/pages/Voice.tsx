// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Voice: speak a script in any voice, design voices from words, clone a voice with its owner's living consent,
 * and transcribe, revoice or dub recordings. Everything runs on the owner's own GPUs.
 */
import { useEffect, useState } from 'react';
import { Button, Icon, Segmented, WithCode } from '../components/ui.tsx';
import { VoiceModelsSheet } from '../components/voice.tsx';
import { api } from '../lib/api.ts';
import type { WindowClass } from '../lib/hooks.ts';
import { setVoice, useStore } from '../lib/store.ts';
import { Clone, Steps, stepOf } from './voice/Clone.tsx';
import { Design } from './voice/Design.tsx';
import { Library } from './voice/Library.tsx';
import { Recordings } from './voice/Recordings.tsx';
import { Rights } from './voice/Rights.tsx';
import { Speak } from './voice/Speak.tsx';

type Tab = 'speak' | 'voices' | 'recordings';

export function Voice({ parts, wc, go }: { parts: string[]; wc: WindowClass; go: (to: string) => void }) {
  const state = useStore((s) => s.voice);
  const consents = useStore((s) => s.consents);
  const [error, setError] = useState<string | null>(null);
  const [showModels, setShowModels] = useState(false);
  const [redo, setRedo] = useState<'consent' | 'record' | null>(null);

  useEffect(() => {
    if (state) return;
    let live = true;
    const load = () =>
      api
        .voice()
        .then((v) => live && setVoice(v))
        .catch((e) => {
          if (!live) return;
          setError((e as Error).message);
          setTimeout(load, 3000);
        });
    load();
    return () => {
      live = false;
    };
  }, [state]);

  const sub = parts[1] ?? 'speak';
  const tab: Tab =
    sub === 'voices' || sub === 'design' || sub === 'clone'
      ? 'voices'
      : sub === 'recordings'
        ? 'recordings'
        : 'speak';
  const sessionId = sub === 'clone' ? (parts[2] ?? null) : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: another clone starts at its own step.
  useEffect(() => setRedo(null), [sessionId]);

  const tabs = (
    <Segmented
      className="hg-seg"
      label="Voice"
      value={tab}
      onChange={(t) => go(t === 'speak' ? '/voice' : `/voice/${t}`)}
      options={[
        { value: 'speak', label: 'Speak' },
        { value: 'voices', label: 'Voices' },
        { value: 'recordings', label: 'Recordings' },
      ]}
    />
  );
  const back = (to: string, label: string) => (
    <Button kind="ghost" icon="chevronl" aria-label={label} onClick={() => go(to)} />
  );

  let top: React.ReactNode;
  let body: React.ReactNode = null;
  if (!state) {
    top = (
      <div className="cs-crumb">
        <span className="t">Voice</span>
      </div>
    );
    body = (
      <div className="hg-empty" role="status">
        <span className="hg-spin" />
        <span className="body-sm muted">{error ? `${error} Trying again…` : 'Opening Voice…'}</span>
      </div>
    );
  } else if (sub === 'clone') {
    const s = sessionId ? (consents.get(sessionId) ?? null) : null;
    top = (
      <>
        {back('/voice/voices', 'Back to voices')}
        <div className="cs-crumb">
          <span className="t">Clone a voice</span>
        </div>
        {wc === 'compact' ? null : (
          <div className="hg-app__topactions">
            <Steps at={stepOf(s, redo)} />
          </div>
        )}
      </>
    );
    body = <Clone state={state} sessionId={sessionId} go={go} redo={redo} setRedo={setRedo} />;
  } else if (sub === 'design') {
    top = (
      <>
        {back('/voice/voices', 'Back to voices')}
        <div className="cs-crumb">
          <span className="t">Design a voice</span>
        </div>
        {wc === 'compact' ? null : <div className="hg-app__topactions">{tabs}</div>}
      </>
    );
    body = <Design state={state} go={go} />;
  } else if (sub === 'voices' && parts[2]) {
    const v = state.voices.find((x) => x.id === parts[2]);
    top = (
      <>
        {back('/voice/voices', 'Back to voices')}
        <div className="cs-crumb">
          <span className="t">Voices</span>
          {v ? <span className="s">{v.name}</span> : null}
        </div>
        {wc === 'compact' ? null : <div className="hg-app__topactions">{tabs}</div>}
      </>
    );
    body = <Rights state={state} voiceId={parts[2]} go={go} />;
  } else {
    top = (
      <>
        <div className="cs-crumb">
          <span className="t">
            {tab === 'speak' ? 'Text to speech' : tab === 'voices' ? 'Voices' : 'Recordings'}
          </span>
          {tab === 'voices' ? <span className="s">{state.voices.length} in your library</span> : null}
        </div>
        <div className="hg-app__topactions">
          {tabs}
          {tab === 'voices' && wc !== 'compact' ? (
            <>
              <Button icon="sparkle" onClick={() => go('/voice/design')}>
                Design a voice
              </Button>
              <Button kind="primary" icon="mic" onClick={() => go('/voice/clone')}>
                Clone a voice
              </Button>
            </>
          ) : null}
          <Button kind="ghost" icon="models" aria-label="Voice models" onClick={() => setShowModels(true)} />
        </div>
      </>
    );
    body =
      tab === 'voices' ? (
        <Library state={state} go={go} />
      ) : tab === 'recordings' ? (
        <Recordings state={state} />
      ) : (
        <Speak state={state} wc={wc} go={go} initialVoice={sub === 'speak' ? (parts[2] ?? null) : null} />
      );
  }

  return (
    <>
      <header className="hg-app__top">{top}</header>
      <main
        className={`cs-stage${tab === 'speak' && sub !== 'clone' && sub !== 'design' && !(sub === 'voices' && parts[2]) ? '' : ' hg-scroll'}`}
        id="main"
      >
        {state && !state.engine.ready ? (
          <div className="st-tile hg-banner hg-voice__banner" role="status">
            <Icon name="alert" size={18} />
            <span>
              <WithCode text={state.engine.problem ?? 'The voice engine isn’t ready.'} />
            </span>
          </div>
        ) : null}
        {body}
      </main>
      {state ? (
        <VoiceModelsSheet
          open={showModels}
          onClose={() => setShowModels(false)}
          models={state.catalog.models}
          states={state.models}
        />
      ) : null}
    </>
  );
}
