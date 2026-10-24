// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Rented GPUs on Runpod, through its REST API (https://rest.runpod.io/v1) with the owner's own API key. A pod is a
 * plain Ubuntu image that runs deploy/runpod/boot.sh: it installs Hildegard's signed release on the pod's volume,
 * shares its GPU with a key this computer made, and stops itself when idle. This computer then joins it like any
 * other device in the fleet.
 */

/** Runpod's REST API. HILDEGARD_RUNPOD_API points it elsewhere, for tests. */
export const RUNPOD_API = process.env.HILDEGARD_RUNPOD_API ?? 'https://rest.runpod.io/v1';

/** Ubuntu 24.04, pinned by digest so the pod starts from exactly the image this was tested on. */
export const BASE_IMAGE =
  'ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac';

/** 24 GB or more, cheapest first among those that render LTX and Wan comfortably; Runpod rents the first it has. */
export const DEFAULT_GPUS = [
  'NVIDIA GeForce RTX 4090',
  'NVIDIA GeForce RTX 5090',
  'NVIDIA RTX A6000',
  'NVIDIA A40',
  'NVIDIA L40S',
  'NVIDIA RTX 6000 Ada Generation',
];

export const PORT = 7341;
export const proxyHost = (podId: string) => `${podId}-${PORT}.proxy.runpod.net`;
/** Where the pod answers, through Runpod's HTTPS proxy. HILDEGARD_RUNPOD_PROXY (with `{pod}`) overrides it, for tests. */
export const proxyUrl = (podId: string) =>
  process.env.HILDEGARD_RUNPOD_PROXY?.replace('{pod}', podId) ?? `https://${proxyHost(podId)}`;
/** The device name the owner's computer gives the pod: short, lower-case, from its id. */
export const deviceName = (podId: string) =>
  `runpod-${podId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 10)}`;

export interface Pod {
  id: string;
  name: string;
  desiredStatus: 'RUNNING' | 'EXITED' | 'TERMINATED';
  costPerHr?: number;
  adjustedCostPerHr?: number;
  gpu?: { displayName?: string; id?: string } | null;
  machine?: { gpuDisplayName?: string } | null;
  lastStatusChange?: string;
  env?: Record<string, string>;
}

export interface PodOptions {
  /** Hildegard's version: the pod installs exactly this release. */
  version: string;
  /** The key this computer made for pairing; it reaches only the pod's environment, in the owner's account. */
  joinKey: string;
  /** deploy/runpod/boot.sh, as text. */
  boot: string;
  gpus?: string[];
  /** Install this model at start, accepting its license only if `acceptLicense` names it. */
  model?: string;
  acceptLicense?: string;
  /** The owner's Hugging Face token, only when they chose to send it (gated models such as LTX). */
  hfToken?: string;
  /** Minutes without a render before the pod stops itself; 0 never. */
  idleMinutes?: number;
  /** Spot pricing: cheaper, and Runpod may take the GPU back at any time. */
  spot?: boolean;
  /** Community cloud: other people's machines. Cheaper and less private; secure cloud is the default. */
  community?: boolean;
  /** GB for models and Hildegard, kept while the pod is stopped. */
  volumeGb?: number;
  /** A network volume (same data centre) to keep models across pods. */
  networkVolumeId?: string;
}

/** The body for POST /pods. */
export function podSpec(o: PodOptions) {
  return {
    name: 'hildegard',
    imageName: BASE_IMAGE,
    gpuTypeIds: o.gpus?.length ? o.gpus : DEFAULT_GPUS,
    gpuCount: 1,
    cloudType: o.community ? 'COMMUNITY' : 'SECURE',
    interruptible: !!o.spot,
    containerDiskInGb: 30,
    ...(o.networkVolumeId ? { networkVolumeId: o.networkVolumeId } : { volumeInGb: o.volumeGb ?? 100 }),
    volumeMountPath: '/workspace',
    ports: [`${PORT}/http`],
    dockerStartCmd: [
      'bash',
      '-c',
      'echo "$HILDEGARD_BOOT" | base64 -d > /hildegard-boot.sh && exec bash /hildegard-boot.sh',
    ],
    env: {
      HILDEGARD_BOOT: Buffer.from(o.boot, 'utf8').toString('base64'),
      HILDEGARD_VERSION: o.version,
      HILDEGARD_JOIN_KEY: o.joinKey,
      HILDEGARD_IDLE_MINUTES: String(o.idleMinutes ?? 30),
      ...(o.model ? { HILDEGARD_MODEL: o.model } : {}),
      ...(o.model && o.acceptLicense === o.model ? { HILDEGARD_ACCEPT_LICENSE: o.model } : {}),
      ...(o.hfToken ? { HF_TOKEN: o.hfToken } : {}),
    },
  };
}

export class RunpodError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class Runpod {
  private readonly key: string;
  private readonly fetchFn: typeof fetch;
  constructor(key: string, fetchFn: typeof fetch = fetch) {
    this.key = key;
    this.fetchFn = fetchFn;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`${RUNPOD_API}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.key}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new RunpodError(0, 'Couldn’t reach Runpod. Check the internet connection and try again.');
    }
    const text = await res.text();
    if (!res.ok) {
      const why =
        res.status === 401 || res.status === 403
          ? 'Runpod refused the API key. Make a new one at https://console.runpod.io/user/settings and add it again.'
          : `Runpod answered ${res.status}: ${text.slice(0, 300)}`;
      throw new RunpodError(res.status, why);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  createPod = (body: ReturnType<typeof podSpec>) => this.call<Pod>('POST', '/pods', body);
  getPod = (id: string) => this.call<Pod>('GET', `/pods/${encodeURIComponent(id)}`);
  startPod = (id: string) => this.call<Pod>('POST', `/pods/${encodeURIComponent(id)}/start`);
  stopPod = (id: string) => this.call<Pod>('POST', `/pods/${encodeURIComponent(id)}/stop`);
  deletePod = (id: string) => this.call<unknown>('DELETE', `/pods/${encodeURIComponent(id)}`);
}
