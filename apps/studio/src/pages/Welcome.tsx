import type { Catalog } from '@hildegard/presets';
import { useState } from 'react';
import mark from '../assets/mark-vellum.svg';
import wordmark from '../assets/wordmark-vellum.svg';
import { ModelRow } from '../components/sheets.tsx';
import { Button } from '../components/ui.tsx';
import { useStore } from '../lib/store.ts';

/** First run: what Hildegard is, then one model to start with. */
export function Welcome({
  catalog,
  onDone,
  go,
}: {
  catalog: Catalog;
  onDone: () => void;
  go: (to: string) => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const models = useStore((s) => s.models);
  const hf = useStore((s) => s.hf);
  const started = models.some((m) => m.installed || m.downloading);
  return (
    <div className="st-ob hg-welcome">
      <div className="st-ob__side">
        <div className="hg-welcome__brand">
          <img src={mark} alt="" height={34} />
          <img src={wordmark} alt="Hildegard" height={26} />
        </div>
        <ol className="st-obsteps">
          <li className={step === 1 ? 'cur' : 'done'}>
            <i>1</i>Welcome
          </li>
          <li className={step === 2 ? 'cur' : ''}>
            <i>2</i>A model
          </li>
        </ol>
        <p className="hg-welcome__quote">
          “A feather on the breath of God.”
          <br />
          <span>Hildegard of Bingen, 1098–1179</span>
        </p>
      </div>
      <main className="st-ob__main" id="main">
        {step === 1 ? (
          <>
            <img src={mark} alt="" height={96} className="hg-welcome__mark" />
            <h1 className="st-h1">Welcome to Hildegard.</h1>
            <p className="st-lead">
              Named for a twelfth-century abbess who worked in every medium at once. Direct films on your own
              GPU: your work stays private, it costs nothing to make, and everything you make is yours.
            </p>
            <div className="hg-welcome__acts">
              <button
                type="button"
                className="cs-create hg-welcome__go"
                onClick={() => setStep(2)}
                data-autofocus=""
              >
                <span>
                  <b>Set up this computer</b>
                  <small>Choose a video model to download</small>
                </span>
              </button>
              <Button kind="ghost" size="lg" onClick={onDone}>
                Look around first
              </Button>
            </div>
            <span className="body-sm muted">You can change everything later in Settings.</span>
          </>
        ) : (
          <>
            <span className="ovl">Step 2 of 2</span>
            <h1 className="st-h1">Pick a video model.</h1>
            <p className="st-lead">
              It downloads in the background from Hugging Face. You can start directing while it does.
            </p>
            <div style={{ display: 'grid', gap: 12 }}>
              {catalog.models.map((m) => (
                <ModelRow
                  key={m.id}
                  name={m.name}
                  blurb={m.blurb}
                  detail={`${m.license} · needs a ${m.minVramGb} GB GPU or more`}
                  state={models.find((x) => x.id === m.id)}
                  needsLink={m.gated && !hf?.linked}
                  onLink={() => {
                    onDone();
                    go('/settings/huggingface');
                  }}
                />
              ))}
            </div>
            <div className="hg-welcome__foot">
              <Button kind="ghost" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button kind="primary" size="lg" onClick={onDone}>
                {started ? 'Start directing' : 'Skip for now'}
              </Button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
