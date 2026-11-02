// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { Button, toast } from './ui.tsx';

/** `9:42` for 582 seconds. */
export const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/**
 * A short one-time code (`HG-XXXX-XXXX`) to read out or type: large, monospace, with Copy and a countdown to when it
 * stops working. `onExpired` lets the page drop it, so an old code isn't left on the screen.
 */
export function OneTimeCode({
  code,
  expiresAt,
  label,
  onExpired,
}: {
  code: string;
  expiresAt: string;
  label: string;
  onExpired?: () => void;
}) {
  const left = () => Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000));
  const [secs, setSecs] = useState(left);
  // biome-ignore lint/correctness/useExhaustiveDependencies: restarts with each new code
  useEffect(() => {
    setSecs(left());
    const t = setInterval(() => {
      const s = left();
      setSecs(s);
      if (s === 0) {
        clearInterval(t);
        onExpired?.();
      }
    }, 1000);
    return () => clearInterval(t);
  }, [code, expiresAt]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      toast('Copied');
    } catch {
      toast('Couldn’t copy. Select the code and copy it yourself.', { tone: 'error' });
    }
  };
  return (
    <div className="hg-short">
      <div className="hg-short__row" role="group" aria-label={label}>
        <code className="hg-short__code" data-testid="one-time-code">
          {code}
        </code>
        <Button kind="ghost" size="sm" icon="copy" onClick={copy} disabled={secs === 0}>
          Copy
        </Button>
      </div>
      <span className="body-sm muted hg-short__left" role="timer" aria-live="off">
        {secs > 0 ? `Works once, for ${clock(secs)} more.` : 'Expired. Make a new one.'}
      </span>
    </div>
  );
}
