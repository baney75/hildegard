// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The page a real person opens to let someone make a character of them, on their own phone or computer: no account,
 * nothing else of Hildegard. They read what they agree to, take three photos with the camera there (never a file),
 * type their name and agree. They get a link that takes it all back.
 */
import type { CharacterView } from '@hildegard/presets';
import { useEffect, useRef, useState } from 'react';
import markGreen from '../assets/mark-green.svg';
import markVellum from '../assets/mark-vellum.svg';
import { Button, Icon } from '../components/ui.tsx';
import { api, type LikenessAsk } from '../lib/api.ts';
import { useTheme } from '../lib/theme.ts';
import { Secret } from './Sharing.tsx';

const HOW: Record<CharacterView, { name: string; ask: string }> = {
  portrait: { name: 'Facing', ask: 'Look straight into the camera.' },
  'three-quarter': { name: 'Turned', ask: 'Turn your head a little to one side.' },
  profile: { name: 'Profile', ask: 'Turn to show the side of your face.' },
  'full-body': { name: 'Full length', ask: 'Step back so all of you is in the frame.' },
};

function Shell({ children }: { children: React.ReactNode }) {
  const mark = useTheme().theme === 'light' ? markGreen : markVellum;
  return (
    <div className="hg-root">
      <main className="cs-likeness" id="main">
        <div className="cs-likeness__brand">
          <img src={mark} alt="" height={22} />
          <span className="body-sm muted">Hildegard · consent</span>
        </div>
        {children}
      </main>
    </div>
  );
}

export function Likeness({ token }: { token: string }) {
  const [ask, setAsk] = useState<LikenessAsk | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const [person, setPerson] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ revokeUrl: string } | 'declined' | null>(null);

  useEffect(() => {
    api
      .likeness(token)
      .then(setAsk)
      .catch((e) => setGone((e as Error).message));
  }, [token]);

  if (gone)
    return (
      <Shell>
        <h1 className="cs-likeness__h">This link doesn’t work anymore</h1>
        <p className="st-lead">{gone} Ask whoever sent it for a new one if you still want to.</p>
      </Shell>
    );
  if (!ask)
    return (
      <Shell>
        <p className="body-sm muted" role="status">
          Opening…
        </p>
      </Shell>
    );
  if (done === 'declined')
    return (
      <Shell>
        <h1 className="cs-likeness__h">You said no</h1>
        <p className="st-lead">
          {ask.maker} can’t make “{ask.character}” from your likeness, and this link no longer works. Nothing
          of you was kept.
        </p>
      </Shell>
    );
  if (done)
    return (
      <Shell>
        <h1 className="cs-likeness__h">Thank you, {person.trim()}</h1>
        <p className="st-lead">
          {ask.maker} can now make pictures and videos of “{ask.character}” from your photos.
        </p>
        <div className="ph-card">
          <b>Keep this link</b>
          <span className="body-sm sec-text">
            Opening it takes your consent back at once: Hildegard stops drawing you and deletes your photos.
            It’s shown only now, so save it somewhere safe.
          </span>
          <Secret label="Your link to take it back" value={done.revokeUrl} />
        </div>
      </Shell>
    );

  const views = ask.photos;
  const name = person.trim();
  const words = ask.statement.replace('…', name || '(your name)');
  const ready = !!name && photos.length === views.length;
  const give = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.giveLikeness(token, name, photos);
      setDone({ revokeUrl: r.revokeUrl });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const decline = async () => {
    setBusy(true);
    try {
      await api.declineLikeness(token);
      setDone('declined');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell>
      <h1 className="cs-likeness__h">{ask.maker} would like to make a character from your likeness.</h1>
      <div className="ph-card">
        <div className="st-kv2">
          <span>Character</span>
          <b>“{ask.character}”</b>
        </div>
        <div className="st-kv2">
          <span>Makes</span>
          <b>Pictures and videos, in Hildegard</b>
        </div>
        <div className="st-kv2">
          <span>From</span>
          <b>Only the photos you take here</b>
        </div>
        <div className="st-kv2">
          <span>You can stop it</span>
          <b>Any time, with the link you get</b>
        </div>
      </div>
      <p className="body-sm sec-text" style={{ margin: 0 }}>
        Hildegard never draws anyone nude or sexually, whoever asks. If you don’t know {ask.maker}, or don’t
        want this, say no.
      </p>
      <Camera views={views} photos={photos} onPhotos={setPhotos} />
      <label className="hg-field hg-field--block">
        <span>Your name</span>
        <input
          value={person}
          maxLength={80}
          autoComplete="name"
          onChange={(e) => setPerson(e.target.value)}
          placeholder="As you use it"
        />
      </label>
      <blockquote className="cs-likeness__words">{words}</blockquote>
      {error ? (
        <p className="hg-err body-sm" role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      ) : null}
      <div className="cs-likeness__acts">
        <Button kind="ghost" onClick={() => void decline()} disabled={busy}>
          No, thank you
        </Button>
        <Button kind="primary" size="lg" busy={busy} disabled={!ready} onClick={() => void give()}>
          I agree
        </Button>
      </div>
      {ready ? null : (
        <span className="body-sm muted" style={{ textAlign: 'right' }}>
          {photos.length < views.length
            ? `Take ${views.length - photos.length} more ${views.length - photos.length === 1 ? 'photo' : 'photos'}, then type your name.`
            : 'Type your name to agree.'}
        </span>
      )}
    </Shell>
  );
}

/** The camera, live: one photo for each view, retaken as often as they like. Files can't stand in for it. */
function Camera({
  views,
  photos,
  onPhotos,
}: {
  views: CharacterView[];
  photos: string[];
  onPhotos: (p: string[]) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [on, setOn] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const at = Math.min(photos.length, views.length - 1);
  const view = views[at]!;
  const full = photos.length >= views.length;

  useEffect(
    () => () => {
      for (const t of stream.current?.getTracks() ?? []) t.stop();
    },
    [],
  );
  useEffect(() => {
    if (full) {
      for (const t of stream.current?.getTracks() ?? []) t.stop();
      stream.current = null;
      setOn(false);
    }
  }, [full]);

  const start = async () => {
    setProblem(null);
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setProblem(
        'Your browser lets a page use the camera only over a secure (https) link. Ask for a link that starts with https.',
      );
      return;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 1280 } },
        audio: false,
      });
      stream.current = s;
      setOn(true);
      requestAnimationFrame(() => {
        if (video.current) {
          video.current.srcObject = s;
          void video.current.play();
        }
      });
    } catch {
      setProblem('The camera didn’t open. Allow this page to use it, then try again.');
    }
  };
  const snap = () => {
    const v = video.current;
    if (!v?.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    onPhotos([...photos, c.toDataURL('image/jpeg', 0.92)]);
  };

  return (
    <section className="cs-cam" aria-labelledby="cam-h">
      <div className="hg-between">
        <span className="ovl" id="cam-h">
          Your photos · {Math.min(photos.length, views.length)} of {views.length}
        </span>
        {photos.length ? (
          <button type="button" className="hg-linkbtn body-sm" onClick={() => onPhotos([])}>
            Start over
          </button>
        ) : null}
      </div>
      <div className="cs-cam__shots">
        {views.map((v, i) => (
          <figure key={v} className={i === photos.length ? 'on' : undefined}>
            {photos[i] ? (
              <img src={photos[i]} alt={`Your photo: ${HOW[v].name.toLowerCase()}`} />
            ) : (
              <span aria-hidden="true">
                <Icon name="person" size={22} />
              </span>
            )}
            <figcaption>{HOW[v].name}</figcaption>
          </figure>
        ))}
      </div>
      {full ? null : on ? (
        <div className="cs-cam__live">
          <video ref={video} muted playsInline aria-label="Your camera" />
          <p className="body-strong" role="status">
            {HOW[view].ask}
          </p>
          <Button kind="primary" icon="camera" onClick={snap}>
            Take photo {at + 1} of {views.length}
          </Button>
        </div>
      ) : (
        <div className="cs-cam__start">
          <Button kind="primary" icon="camera" onClick={() => void start()}>
            Open the camera
          </Button>
          <span className="body-sm muted">
            Nothing is taken until you tap. Your photos go only to the Hildegard that asked.
          </span>
          {problem ? (
            <p className="hg-err body-sm" role="alert" style={{ margin: 0 }}>
              {problem}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

/** The page the person's own take-it-back link opens. */
export function LikenessRevoke({ token }: { token: string }) {
  const [state, setState] = useState<'ask' | 'busy' | { character: string | null } | { error: string }>(
    'ask',
  );
  if (typeof state === 'object' && 'error' in state)
    return (
      <Shell>
        <h1 className="cs-likeness__h">That didn’t work</h1>
        <p className="st-lead">{state.error}</p>
      </Shell>
    );
  if (typeof state === 'object')
    return (
      <Shell>
        <h1 className="cs-likeness__h">Your consent is taken back</h1>
        <p className="st-lead">
          Hildegard won’t draw {state.character ? `“${state.character}”` : 'you'} anymore, and your photos are
          deleted. Pictures and videos already made are theirs to delete; ask them to.
        </p>
      </Shell>
    );
  return (
    <Shell>
      <h1 className="cs-likeness__h">Take back your consent?</h1>
      <p className="st-lead">
        Hildegard stops drawing you at once and deletes the photos you took. You can’t undo this, but they can
        ask you again.
      </p>
      <div className="cs-likeness__acts">
        <Button
          kind="danger"
          size="lg"
          busy={state === 'busy'}
          onClick={async () => {
            setState('busy');
            try {
              const r = await api.revokeLikeness(token);
              setState({ character: r.character });
            } catch (e) {
              setState({ error: (e as Error).message });
            }
          }}
        >
          Take it back
        </Button>
      </div>
    </Shell>
  );
}
