// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_GPUS, deviceName, PROVIDERS, podSpec, Runpod, RunpodError } from '../src/index.ts';

const boot = readFileSync(fileURLToPath(new URL('../../../deploy/runpod/boot.sh', import.meta.url)), 'utf8');
const base = { version: '0.1.0', joinKey: 'k'.repeat(43), boot };

describe('podSpec', () => {
  it('rents a secure, on-demand GPU from a pinned image, reachable only on Hildegard’s port', () => {
    const s = podSpec(base);
    expect(s).toMatchObject({
      cloudType: 'SECURE',
      interruptible: false,
      gpuTypeIds: DEFAULT_GPUS,
      gpuCount: 1,
      volumeInGb: 100,
      volumeMountPath: '/workspace',
      ports: ['7341/http'],
    });
    expect(s.imageName).toMatch(/^ubuntu:24\.04@sha256:[0-9a-f]{64}$/);
    expect(s.env).not.toHaveProperty('HF_TOKEN');
    expect(s.env).not.toHaveProperty('HILDEGARD_MODEL');
  });

  it('hands the pod boot.sh exactly, through its environment', () => {
    const s = podSpec(base);
    expect(Buffer.from(s.env.HILDEGARD_BOOT, 'base64').toString('utf8')).toBe(boot);
    expect(s.dockerStartCmd.slice(0, 2)).toEqual(['bash', '-c']);
    // The start command itself decodes it as the pod would.
    const out = execFileSync(
      'bash',
      [
        '-c',
        s.dockerStartCmd[2]!.replace('exec bash /hildegard-boot.sh', 'cat /hildegard-boot.sh').replaceAll(
          '/hildegard-boot.sh',
          '"$T"',
        ),
      ],
      {
        env: {
          ...process.env,
          HILDEGARD_BOOT: s.env.HILDEGARD_BOOT,
          T: `${process.env.TMPDIR ?? '/tmp'}/hg-boot-${process.pid}.sh`,
        },
      },
    ).toString();
    expect(out).toBe(boot);
  });

  it('accepts a license only when the owner named that very model', () => {
    expect(podSpec({ ...base, model: 'wan-2-2-ti2v-5b' }).env).not.toHaveProperty('HILDEGARD_ACCEPT_LICENSE');
    expect(podSpec({ ...base, model: 'wan-2-2-ti2v-5b', acceptLicense: 'ltx-2-5' }).env).not.toHaveProperty(
      'HILDEGARD_ACCEPT_LICENSE',
    );
    expect(
      podSpec({ ...base, model: 'wan-2-2-ti2v-5b', acceptLicense: 'wan-2-2-ti2v-5b' }).env,
    ).toMatchObject({
      HILDEGARD_MODEL: 'wan-2-2-ti2v-5b',
      HILDEGARD_ACCEPT_LICENSE: 'wan-2-2-ti2v-5b',
    });
  });

  it('keeps choices the owner made: spot, community, a network volume, idle minutes', () => {
    const s = podSpec({ ...base, spot: true, community: true, networkVolumeId: 'vol1', idleMinutes: 0 });
    expect(s).toMatchObject({ cloudType: 'COMMUNITY', interruptible: true, networkVolumeId: 'vol1' });
    expect(s).not.toHaveProperty('volumeInGb');
    expect(s.env.HILDEGARD_IDLE_MINUTES).toBe('0');
  });

  it('names the device from the pod id', () => {
    expect(deviceName('AbC-123xyzQWERTY')).toBe('runpod-abc123xyzq');
  });
});

describe('Runpod', () => {
  it('sends the key as a bearer header, never in the URL, and explains a refused key', async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get('authorization') });
      return new Response('nope', { status: 401 });
    }) as unknown as typeof fetch;
    const err = await new Runpod('secret-key', fake).getPod('p1').catch((e) => e);
    expect(err).toBeInstanceOf(RunpodError);
    expect((err as RunpodError).message).toContain('refused the API key');
    expect(seen[0]!.url).not.toContain('secret-key');
    expect(seen[0]!.auth).toBe('Bearer secret-key');
  });
});

describe('providers', () => {
  it('never joins Colab to the fleet', () => {
    expect(PROVIDERS.find((p) => p.id === 'colab')!.terms).toContain('never joins Colab to your fleet');
  });
});

describe('boot.sh', () => {
  it('is valid bash and never logs the join key', () => {
    execFileSync('bash', ['-n', fileURLToPath(new URL('../../../deploy/runpod/boot.sh', import.meta.url))]);
    for (const line of boot
      .split('\n')
      .filter((l) => l.includes('HILDEGARD_JOIN_KEY') && !l.trim().startsWith('#')))
      expect(line).not.toMatch(/log |echo /);
  });
});
