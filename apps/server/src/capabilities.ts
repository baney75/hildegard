// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What a device says it can do (`NodeInfo.capabilities`): its microphone and speaker, the speech and language models
 * it runs, its GPU, and how it computes. Talk reads it to choose where each step of a turn runs; today every step runs
 * here. A paired device's claim is its own say-so, checked for shape and size only.
 */
import type { DeviceCapabilities, LlmState, VoiceCatalog } from '@hildegard/presets';
import { z } from 'zod';

const id = z.string().min(1).max(80);

export const Capabilities = z.object({
  mic: z.boolean(),
  speaker: z.boolean(),
  stt: z.array(id).max(32),
  tts: z.array(id).max(32),
  llm: z
    .array(
      z.object({
        runtime: id,
        model: z.string().min(1).max(200),
        vramGb: z.number().nonnegative().nullable(),
      }),
    )
    .max(64),
  gpu: z.object({ name: z.string().min(1).max(200), vramGb: z.number().nonnegative().nullable() }).nullable(),
  compute: z.enum(['interactive', 'batch']),
}) satisfies z.ZodType<DeviceCapabilities>;

/** A device's claim, or null when it made none (versions before 0.1.14) or one that isn't the right shape. */
export function readCapabilities(raw: unknown): DeviceCapabilities | null {
  const r = Capabilities.safeParse(raw);
  return r.success ? r.data : null;
}

/** The language model Talk answers with when none runs here (the stand-in GPU, or nothing started). */
export const STUB_LLM = { runtime: 'stub', model: 'hildegard-echo', vramGb: null } as const;

export interface CapabilityDeps {
  fake: boolean;
  gpu: () => { name: string; vramGb: number | null } | null;
  /** The voice catalog's models, and whether each can run here now. */
  voice?: { catalog: Pick<VoiceCatalog, 'models'>; usable: (id: string) => boolean };
  /** The language models found running here; left out where nobody looks. */
  llm?: () => Promise<LlmState>;
  /** Whether this device has a Talk surface (the Studio with the microphone page); true for the server today. */
  talk?: boolean;
}

/** This computer's capabilities, from what is installed and running here now. */
export async function localCapabilities(d: CapabilityDeps): Promise<DeviceCapabilities> {
  const can = (what: 'speak' | 'transcribe') =>
    (d.voice?.catalog.models ?? [])
      .filter((m) => m.can.includes(what) && d.voice!.usable(m.id))
      .map((m) => m.id);
  let llm: DeviceCapabilities['llm'] = [];
  if (d.fake) llm = [{ ...STUB_LLM }];
  else if (d.llm) {
    const state = await d.llm().catch(() => null);
    llm = (state?.endpoints ?? [])
      .filter((e) => e.online)
      .flatMap((e) => e.models.map((m) => ({ runtime: e.runtime, model: m.id, vramGb: null })))
      .slice(0, 64);
  }
  // The device with a Talk surface hears and plays a turn. The Studio's own microphone is the browser's, not this.
  const io = d.talk ?? true;
  return {
    mic: io,
    speaker: io,
    stt: can('transcribe'),
    tts: can('speak'),
    llm,
    gpu: d.gpu(),
    // Nothing here marks a computer as batch only yet: a rented GPU will, once Talk routes work to devices.
    compute: 'interactive',
  };
}
