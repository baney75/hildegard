// SPDX-License-Identifier: AGPL-3.0-only
import { Component, type ReactNode } from 'react';
import { Button } from './ui.tsx';

/** A page's code that is gone: Hildegard was updated (or rebuilt) while this tab stayed open. */
export function isChunkError(e: unknown): boolean {
  const m = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported|ChunkLoadError|Unable to preload CSS/i.test(
    m,
  );
}

const RELOADED = 'hildegard-page-reload';

/**
 * Around the routed pages: a page whose code can't load says so instead of blanking the Studio. For a page left
 * behind by an update it reloads once, which fetches the new build; a second failure in a minute shows the message.
 */
export class PageGate extends Component<{ children: ReactNode }, { error: unknown }> {
  override state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  override componentDidCatch(error: unknown) {
    if (!isChunkError(error)) return;
    let last = 0;
    try {
      last = Number(sessionStorage.getItem(RELOADED)) || 0;
    } catch {}
    if (Date.now() - last < 60_000) return;
    try {
      sessionStorage.setItem(RELOADED, String(Date.now()));
    } catch {}
    location.reload();
  }

  override render() {
    if (!this.state.error) return this.props.children;
    const updated = isChunkError(this.state.error);
    return (
      <main id="main" role="alert">
        <p>
          {updated
            ? 'Hildegard was updated while this page was open, so this page’s code is gone. Reload to get the new version.'
            : 'This page couldn’t load. Reload to try again.'}
        </p>
        <Button kind="primary" onClick={() => location.reload()}>
          Reload
        </Button>
      </main>
    );
  }
}
