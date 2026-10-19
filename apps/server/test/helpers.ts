import type { SecretStore } from '../src/hf.ts';

export const memoryStore = (initial: string | null = null): SecretStore & { value: string | null } => {
  const s = {
    kind: 'keychain' as const,
    value: initial,
    get: () => s.value,
    set: (v: string) => {
      s.value = v;
    },
    delete: () => {
      s.value = null;
    },
  };
  return s;
};

/** A tiny scripted fetch: route by method and URL substring. */
export function fakeFetch(
  routes: Array<[string, (url: string, init: RequestInit) => Response | Promise<Response>]>,
) {
  const calls: Array<{ method: string; url: string; init: RequestInit }> = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ method, url, init });
    for (const [key, handler] of routes) {
      const [m, frag] = key.split(' ') as [string, string];
      if (m === method && url.includes(frag)) return handler(url, init);
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return Object.assign(fn, { calls });
}
