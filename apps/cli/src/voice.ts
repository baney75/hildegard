// SPDX-License-Identifier: AGPL-3.0-only
/** `hildegard voice`: the voice engine's environments, and installing them. */
import { installVoice, readVoiceEnv, type Step, VOICE_ENVS, type VoiceEnv } from '@hildegard/runtime';
import type { Ctx } from './commands.ts';
import { printEvent, printStep, type Result, result } from './output.ts';

const NAMES: Record<VoiceEnv, string> = {
  speech: 'Speech and transcription',
  chatterbox: 'Cloning (Chatterbox)',
  qwen: 'Voice design (Qwen3-TTS)',
};

export async function voice(ctx: Ctx, args: string[]): Promise<Result> {
  if (args[0] === 'install') return install(ctx);
  if (args[0] && args[0] !== 'status')
    return result([], `Unknown voice command “${args[0]}”. Try \`hildegard voice install\`.`, { ok: false });
  const steps: Step[] = VOICE_ENVS.map((env) => {
    const info = readVoiceEnv(ctx.config.dataDir, env);
    return info
      ? {
          id: env,
          title: NAMES[env],
          status: 'done',
          detail: `PyTorch ${info.torch} ${info.usesGpu ? `on the ${info.gpu}` : 'on the CPU'}.`,
        }
      : {
          id: env,
          title: NAMES[env],
          status: 'skipped',
          detail: 'Not installed here.',
          command: `hildegard voice install --env ${env} --json`,
        };
  });
  const ready = steps.filter((s) => s.status === 'done').length;
  return result(
    steps,
    ready
      ? 'Voice models download from the Studio’s Voice page, or with the voice_models MCP tool.'
      : 'Voice isn’t installed here yet. Run `hildegard voice install`.',
  );
}

async function install(ctx: Ctx): Promise<Result> {
  const asked = ctx.opts.get('env');
  const envs = asked ? asked.split(',').map((e) => e.trim()) : undefined;
  const bad = envs?.filter((e) => !VOICE_ENVS.includes(e as VoiceEnv)) ?? [];
  if (bad.length)
    return result(
      [],
      `There’s no voice environment called “${bad[0]}”. Pick from ${VOICE_ENVS.join(', ')}.`,
      {
        ok: false,
      },
    );
  const events = ctx.flags.has('events');
  const steps = await installVoice({
    dataDir: ctx.config.dataDir,
    envs: envs as VoiceEnv[] | undefined,
    cpu: ctx.flags.has('cpu'),
    onStep: events ? (step) => printEvent({ step }) : ctx.json ? undefined : printStep,
    onLog: events
      ? (log) => printEvent({ log })
      : ctx.json || !ctx.flags.has('verbose')
        ? undefined
        : (l) => console.log(`    ${l}`),
  });
  const printed = ctx.json ? 0 : steps.length;
  const stuck = steps.find((s) => s.status === 'failed' || s.status === 'needs-owner');
  return {
    ...result(
      steps,
      stuck
        ? stuck.status === 'failed'
          ? 'The voice install stopped.'
          : stuck.detail
        : 'Voice is ready. Open Voice in the Studio to download a model; Hildegard picks the new engine up by itself.',
    ),
    printed,
  };
}
