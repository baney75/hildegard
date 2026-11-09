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

/**
 * Around the routed pages: a page whose code can't load says so, with a Reload button, instead of blanking the Studio.
 * It never reloads by itself: a dropped connection looks the same as a page an update removed, and a reload would
 * lose whatever is open (a talk, a recording) or land on the browser's offline page.
 */
export class PageGate extends Component<{ children: ReactNode }, { error: unknown }> {
  override state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  override render() {
    if (!this.state.error) return this.props.children;
    const updated = isChunkError(this.state.error);
    return (
      <main id="main" role="alert">
        <p>
          {updated
            ? 'This page’s code didn’t load: Hildegard may have been updated while it was open, or the connection dropped. Reload when you’re ready.'
            : 'This page couldn’t load. Reload to try again.'}
        </p>
        <Button kind="primary" onClick={() => location.reload()}>
          Reload
        </Button>
      </main>
    );
  }
}
