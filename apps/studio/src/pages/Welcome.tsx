// SPDX-License-Identifier: AGPL-3.0-only
import type { Catalog } from '@hildegard/presets';
import { useState } from 'react';
import markGreen from '../assets/mark-green.svg';
import markVellum from '../assets/mark-vellum.svg';
import wordmarkGreen from '../assets/wordmark-green.svg';
import wordmarkVellum from '../assets/wordmark-vellum.svg';
import caravan from '../assets/work/caravan-dune-800.webp';
import illuminator from '../assets/work/illuminator-quill-800.webp';
import illuminatorLarge from '../assets/work/illuminator-quill-1600.webp';
import headland from '../assets/work/lighthouse-headland-800.webp';
import keeper from '../assets/work/lighthouse-keeper-800.webp';
import raincoat from '../assets/work/neon-raincoat-800.webp';
import { ModelRow } from '../components/sheets.tsx';
import { Button, Icon, toast, toastError } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { firstPick } from '../lib/firstrun.ts';
import { bytes, videoModels } from '../lib/format.ts';
import { useStore } from '../lib/store.ts';
import { useTheme } from '../lib/theme.ts';

/** Frames from real takes, as the install page shows them; all six were Wan 2.2 5B on an RTX 4080 Laptop GPU. */
const FRAMES = [
  {
    src: illuminator,
    alt: 'A quill paints blue and red ink into an illuminated capital edged in gold leaf.',
  },
  { src: keeper, alt: 'An old lighthouse keeper at the balcony railing at dusk, the lamp lit beside him.' },
  { src: raincoat, alt: 'A woman in a red raincoat walks past a glowing noodle shop window in the rain.' },
  { src: caravan, alt: 'A camel crosses rippled dunes at sunset.' },
  { src: headland, alt: 'A white lighthouse alone on a rocky headland at dusk.' },
];

/**
 * First run, on one screen: a frame Hildegard made, what it is in a sentence, and the one model to start with, its
 * license shown, so accepting it is the one click between a new install and the first shot.
 */
export function Welcome({
  catalog,
  onDone,
  go,
}: {
  catalog: Catalog;
  onDone: () => void;
  go: (to: string) => void;
}) {
  const models = useStore((s) => s.models);
  const hf = useStore((s) => s.hf);
  const [busy, setBusy] = useState(false);
  const light = useTheme().theme === 'light';
  const pick = firstPick(catalog, models, hf);
  const start = async () => {
    if (!pick) return;
    setBusy(true);
    try {
      // The license is on screen beside this button: pressing it is the owner accepting it.
      await api.installModel(pick.model.id, true);
      toast(`${pick.model.name} is downloading. Write your first shot while it does.`);
      onDone();
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  };
  const size = bytes(pick?.state?.missingBytes ?? 0);
  return (
    <div className="hg-first">
      <main className="hg-first__grid" id="main">
        <div className="hg-first__brand">
          <img src={light ? markGreen : markVellum} alt="" height={28} />
          <img src={light ? wordmarkGreen : wordmarkVellum} alt="Hildegard" height={20} />
        </div>
        <div className="hg-first__intro">
          <h1 className="st-h1">Direct films on your own GPU.</h1>
          <p className="st-lead">
            Your work stays on this computer, each shot costs nothing, and everything you make is yours.
          </p>
        </div>
        <figure className="hg-first__work">
          {/* A strip to swipe on a phone, so it takes focus for the arrow keys too. */}
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region needs focus to scroll by keyboard */}
          <div className="hg-first__frames" role="region" aria-label="Frames made in Hildegard" tabIndex={0}>
            {FRAMES.map((f, i) => (
              <img
                key={f.src}
                src={f.src}
                alt={f.alt}
                width={800}
                height={452}
                {...(i === 0
                  ? {
                      fetchPriority: 'high' as const,
                      srcSet: `${illuminator} 800w, ${illuminatorLarge} 1600w`,
                      sizes: '(min-width: 840px) 50vw, 64vw',
                    }
                  : { loading: 'lazy' as const })}
              />
            ))}
          </div>
          <figcaption className="body-sm">
            Every frame here is from a take made in Hildegard: Wan 2.2 5B on a laptop’s RTX 4080.
          </figcaption>
        </figure>
        <div className="hg-first__setup">
          <section className="hg-first__pick" aria-labelledby="first-model">
            {!models.length ? (
              <>
                <span className="ovl" id="first-model">
                  Start with one model
                </span>
                <p className="body sec-text">Checking which model fits this computer…</p>
              </>
            ) : pick ? (
              <>
                <div className="hg-first__pickhead">
                  <span className="ovl" id="first-model">
                    Start with one model
                  </span>
                  <span className="cs-fit ok">{pick.why}</span>
                </div>
                <h2 className="hg-first__name">{pick.model.name}</h2>
                <p className="body sec-text">{pick.model.blurb}</p>
                <p className="body-sm muted hg-num">
                  {size} from Hugging Face · {pick.model.license}
                </p>
                {pick.needsLink ? (
                  <>
                    <p className="body-sm">
                      It’s on Hugging Face behind its license page, so it needs your Hugging Face account
                      linked first.
                    </p>
                    <a className="hg-btn hg-btn--primary hg-btn--lg" href="#/settings/huggingface">
                      <Icon name="link" size={18} />
                      Link Hugging Face
                    </a>
                  </>
                ) : (
                  <>
                    <div className="hg-first__license">
                      <p className="body-sm">
                        Downloading it makes you its licensee under the {pick.model.license}.{' '}
                        {pick.model.terms[0]}
                      </p>
                      {pick.model.terms.length > 1 ? (
                        <details>
                          <summary className="body-sm">What else the license says</summary>
                          <ul className="hg-terms">
                            {pick.model.terms.slice(1).map((t) => (
                              <li key={t}>{t}</li>
                            ))}
                          </ul>
                        </details>
                      ) : null}
                      <a
                        className="body-sm"
                        href={pick.model.licenseUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        Read the full {pick.model.license}
                      </a>
                    </div>
                    <Button
                      kind="primary"
                      size="lg"
                      icon="download"
                      className="hg-first__go"
                      onClick={start}
                      busy={busy}
                      // A license is accepted by a deliberate click, never by an Enter that lands here first.
                      {...(pick.state?.licenseAccepted ? { 'data-autofocus': '' } : {})}
                    >
                      {pick.state?.licenseAccepted ? 'Download' : 'Accept and download'} · {size}
                    </Button>
                    <p className="body-sm muted">
                      It downloads in the background. You can write your first shot meanwhile.
                    </p>
                  </>
                )}
              </>
            ) : (
              <>
                <span className="ovl" id="first-model">
                  Rendering
                </span>
                <h2 className="hg-first__name">This computer’s GPU can’t run a video model.</h2>
                <p className="body sec-text">
                  Render on another computer you own instead: pair it once, and every take you make here runs
                  there.
                </p>
                <a className="hg-btn hg-btn--primary hg-btn--lg" href="#/settings/devices">
                  <Icon name="server" size={18} />
                  Pair a device
                </a>
              </>
            )}
          </section>

          <div className="hg-first__acts">
            <Button kind="ghost" onClick={onDone}>
              Look around first
            </Button>
            <details className="hg-first__more">
              <summary>Other models</summary>
              <div className="hg-first__models">
                {videoModels(catalog)
                  .filter((m) => m.id !== pick?.model.id)
                  .map((m) => (
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
            </details>
          </div>

          <p className="hg-first__also body-sm">
            <Icon name="agent" size={18} />
            <span>
              Use Hildegard from Claude, ChatGPT or Codex too. <a href="#/agents">Link an AI app</a>
            </span>
          </p>
        </div>
      </main>
    </div>
  );
}
