// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The Talk demo script: one beat at a time, large enough to read from across a desk, with the cue for what to show
 * above it. The lines are invented (lib/demo-script.ts).
 */
import { useEffect, useState } from 'react';
import { Button } from '../components/ui.tsx';
import { DEMO_SCRIPT } from '../lib/demo-script.ts';

export function TalkScript() {
  const [at, setAt] = useState(0);
  const last = DEMO_SCRIPT.length - 1;
  const beat = DEMO_SCRIPT[at]!;

  // Arrow keys and space step through it, so a clicker or the keyboard runs the demo.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest('input, textarea, select')) return;
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') {
        e.preventDefault();
        setAt((n) => Math.min(last, n + 1));
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        setAt((n) => Math.max(0, n - 1));
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [last]);

  return (
    <>
      <header className="hg-app__top">
        <div className="cs-crumb">
          <span className="t">Demo script</span>
        </div>
      </header>
      <main className="cs-stage hg-scroll" id="main">
        <div className="st-page hg-narrow">
          <section className="st-tile hg-stack" aria-labelledby="script-h">
            <h2 id="script-h" className="st-h2">
              Beat {at + 1} of {DEMO_SCRIPT.length}
            </h2>
            <p className="body-sm muted" data-testid="script-cue">
              {beat.cue}
            </p>
            {beat.line ? (
              <p className="st-prompter" data-testid="script-line">
                <span className="now">{beat.line}</span>
              </p>
            ) : null}
            <div className="hg-between">
              <Button kind="ghost" size="sm" disabled={at === 0} onClick={() => setAt(at - 1)}>
                Back
              </Button>
              <Button kind="primary" size="sm" disabled={at === last} onClick={() => setAt(at + 1)}>
                Next
              </Button>
            </div>
          </section>
          <section className="st-tile hg-stack" aria-labelledby="script-all">
            <h2 id="script-all" className="st-h2">
              The whole script
            </h2>
            <ol className="hg-script">
              {DEMO_SCRIPT.map((b, i) => (
                <li key={b.cue} aria-current={i === at ? 'step' : undefined}>
                  <button type="button" className="hg-script__beat" onClick={() => setAt(i)}>
                    <small className="body-sm muted">{b.cue}</small>
                    {b.line ? <span>“{b.line}”</span> : null}
                  </button>
                </li>
              ))}
            </ol>
            <p className="body-sm muted">
              Every line is invented. Talk runs only on your own devices over your tailnet; nothing here needs
              a public link. <a href="#/talk">Back to Talk</a>
            </p>
          </section>
        </div>
      </main>
    </>
  );
}
