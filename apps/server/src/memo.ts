// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Share one async answer between everyone who asks while it is being worked out, and keep it for `ttlMs` after (0:
 * not at all, so what comes back is always as fresh as the question). `bust()` forgets it, for after something
 * changed it. A failure is never remembered.
 */
export function ttlMemo<T>(ttlMs: number, fn: () => Promise<T>) {
  let at = 0;
  let held: Promise<T> | null = null;
  let pending = false;
  const get = (): Promise<T> => {
    const now = Date.now();
    if (held && (pending || now - at < ttlMs)) return held;
    const p = fn();
    held = p;
    pending = true;
    p.then(
      () => {
        if (held === p) {
          pending = false;
          at = Date.now();
        }
      },
      () => {
        if (held === p) held = null;
        pending = false;
      },
    );
    return p;
  };
  get.bust = () => {
    held = null;
    pending = false;
  };
  return get;
}
