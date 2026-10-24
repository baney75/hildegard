// SPDX-License-Identifier: AGPL-3.0-only
import type { Take } from '@hildegard/presets';
import { useState } from 'react';
import { api } from '../lib/api.ts';
import { deviceLabel } from '../lib/format.ts';
import { upsert, useStore } from '../lib/store.ts';
import { takeLabel } from './TakeCard.tsx';
import { Button, Icon, Modal, toastError } from './ui.tsx';

/** Force now confirms first and says exactly what it will interrupt. */
export function ForceDialog({
  take,
  title,
  onClose,
  compact,
}: {
  take: Take;
  title: string;
  onClose: () => void;
  compact: boolean;
}) {
  const takes = useStore((s) => s.takes);
  const shots = useStore((s) => s.shots);
  const engine = useStore((s) => s.engine);
  const guest = useStore((s) => s.guests.find((g) => g.status === 'running') ?? null);
  const [busy, setBusy] = useState(false);
  const running = [...takes.values()].find((t) => t.status === 'running');
  const stops = running && running.priority !== 'forced' ? running : null;
  // Another device's render stops the same way, and goes back in line there.
  const stopsGuest = !running && guest ? guest : null;
  // A device's name reads as a name; "This computer" mid-sentence reads as "this computer".
  const here = deviceLabel(engine).replace(/^(This|Stand-in)\b/, (m) => m.toLowerCase());
  const go = async (interrupt: boolean) => {
    setBusy(true);
    try {
      if (engine?.paused) await api.resume();
      upsert({ type: 'take', take: await api.force(take.id, interrupt) });
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      labelledBy="fn-t"
      variant={compact ? 'bottom' : 'dialog'}
      className="st-dialog"
    >
      <div className="st-dialog__h">
        <div style={{ flex: 1 }}>
          <h2 id="fn-t">Force {takeLabel(take)} now?</h2>
          <p>
            <span className="hg-dlg__ctx">{title}</span>
            {stops || stopsGuest
              ? `It will run on ${here} right away.`
              : 'It will run next, ahead of everything waiting.'}
          </p>
        </div>
      </div>
      <div className="st-dialog__b">
        {stops ? (
          <div className="st-agent" style={{ gridTemplateColumns: '44px minmax(0, 1fr)' }}>
            <span className="av">
              <Icon name="pause" />
            </span>
            <span>
              <b>
                Stops: {shots.get(stops.shotId)?.title ?? 'a shot'} · {takeLabel(stops)}
              </b>
              <small>
                {Math.round((stops.progress?.value ?? 0) * 100)}% done. It goes back in line and starts again
                from the beginning.
              </small>
            </span>
          </div>
        ) : null}
        {stopsGuest ? (
          <div className="st-agent" style={{ gridTemplateColumns: '44px minmax(0, 1fr)' }}>
            <span className="av">
              <Icon name="pause" />
            </span>
            <span>
              <b>Stops: the take from {stopsGuest.from ?? 'another device'}</b>
              <small>
                {Math.round((stopsGuest.progress ?? 0) * 100)}% done. It goes back in line here and starts
                again from the beginning, and that device shows it waiting.
              </small>
            </span>
          </div>
        ) : null}
        {engine?.paused ? (
          <div className="st-agent" style={{ gridTemplateColumns: '44px minmax(0, 1fr)' }}>
            <span className="av">
              <Icon name="play" />
            </span>
            <span>
              <b>Resumes rendering</b>
              <small>Rendering is paused. Forcing a take turns it back on.</small>
            </span>
          </div>
        ) : null}
        <div className="st-agent" style={{ gridTemplateColumns: '44px minmax(0, 1fr)' }}>
          <span className="av">
            <Icon name="shield" />
          </span>
          <span>
            <b>Costs nothing</b>
            <small>This GPU is yours. Nothing leaves your devices.</small>
          </span>
        </div>
      </div>
      <div className="st-dialog__f">
        <Button kind="ghost" onClick={onClose} style={{ marginRight: 'auto' }} data-autofocus="">
          Keep waiting
        </Button>
        {stops || stopsGuest ? (
          <Button onClick={() => go(false)} disabled={busy}>
            Run next
          </Button>
        ) : null}
        <Button kind="force" size="lg" icon="force" onClick={() => go(true)} busy={busy}>
          Force now
        </Button>
      </div>
    </Modal>
  );
}
