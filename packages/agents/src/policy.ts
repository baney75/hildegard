// SPDX-License-Identifier: AGPL-3.0-only
/**
 * When Hildegard may run a coding agent for someone, decided before anything starts. The rules follow each provider's
 * own published terms (docs/agent-terms.md quotes them); where a provider is silent, the answer is no.
 *
 * In short:
 * - The owner's own API key or cloud account (Anthropic, OpenAI, OpenRouter, Bedrock, Vertex, Foundry) may run any
 *   agent for the owner, also on a schedule. People they invited may use a non-Anthropic key only if the owner turns
 *   that on, never resold; Claude never runs for anyone but the owner, as Anthropic requires.
 * - A subscription (Claude Pro/Max, ChatGPT Plus/Pro) runs only in that vendor's own unmodified app (Claude Code,
 *   Codex), only for the owner themselves, only when they asked for it just now, paced like a person working.
 * - A subscription's sign-in is never taken into another tool (OMP's Anthropic or ChatGPT login, say), never read
 *   by Hildegard, and never shared with other people or devices.
 * - Models on the owner's own computers have no such limits.
 */

export type AgentId = 'claude-code' | 'codex' | 'omp';

export type Auth =
  /** The owner's own API key with the provider, billed to them. */
  | { kind: 'api-key'; provider: string }
  /** The owner's own cloud account that resells the provider's models under its terms (Bedrock, Vertex, Foundry). */
  | { kind: 'cloud'; provider: 'bedrock' | 'vertex' | 'foundry' }
  /** Signed in to the vendor's own app with a consumer plan, through the vendor's own sign-in. */
  | { kind: 'subscription'; plan: 'claude' | 'chatgpt' }
  /** A model served on the owner's own computers (Ollama, llama.cpp, LM Studio, vLLM, Hildegard). */
  | { kind: 'local'; provider: string }
  /** A consumer plan's sign-in used inside some other tool, such as OMP logged in to Claude or ChatGPT. */
  | { kind: 'borrowed-login'; provider: string }
  | { kind: 'none' };

/** Who started this run. */
export type Trigger =
  /** The owner, at this computer, just now (the CLI, the Studio here, the Omarchy panel). */
  | 'owner-here'
  /** The owner, signed in as owner from another of their devices. */
  | 'owner-remote'
  /** Someone the owner invited (host mode), not the owner. */
  | 'director'
  /** Another device of the fleet, or anything arriving over the network that isn't a signed-in person. */
  | 'peer'
  /** Nobody right now: a schedule, a queue, a loop, a webhook. */
  | 'schedule';

export interface Verdict {
  allowed: boolean;
  /** One plain sentence: why, in the provider's terms. */
  reason: string;
  /** The provider's own page that says so. */
  source?: string;
  /** What the owner can do to make it allowed, when there is a way. */
  fix?: string;
}

export interface PolicyOptions {
  /** The owner chose to let invited people use the owner's own API keys (never a subscription). Default false. */
  shareKeysWithDirectors?: boolean;
}

export const SOURCES = {
  anthropic: 'https://code.claude.com/docs/en/legal-and-compliance',
  anthropicConsumer: 'https://www.anthropic.com/legal/consumer-terms',
  openaiAuth: 'https://learn.chatgpt.com/codex/auth',
  openaiExec: 'https://learn.chatgpt.com/codex/non-interactive-mode',
  openaiPartners: 'https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt',
  openaiTerms: 'https://openai.com/policies/terms-of-use',
} as const;

/** The vendor app a consumer plan belongs to: the only place its sign-in may be used. */
const HOME_APP: Record<'claude' | 'chatgpt', AgentId> = { claude: 'claude-code', chatgpt: 'codex' };

export function decide(agent: AgentId, auth: Auth, trigger: Trigger, opts: PolicyOptions = {}): Verdict {
  if (trigger === 'peer')
    return {
      allowed: false,
      reason:
        'Other devices in the fleet can send renders, not agent runs: an agent acts with its owner’s accounts, so only a person may start one.',
    };

  switch (auth.kind) {
    case 'none':
      return {
        allowed: false,
        reason: 'This agent isn’t signed in to anything Hildegard can use.',
        fix: 'Add your own API key (`hildegard agents key <provider> --key-stdin`), or point it at a local model.',
      };

    case 'borrowed-login':
      return {
        allowed: false,
        reason: `A ${auth.provider} subscription sign-in may only be used in ${auth.provider === 'anthropic' ? 'Claude Code and Claude’s own apps' : 'Codex, ChatGPT and the tools OpenAI lists as partners'}; using it in another tool can get the account banned.`,
        source: auth.provider === 'anthropic' ? SOURCES.anthropic : SOURCES.openaiPartners,
        fix: 'Give this tool an API key instead, or use the vendor’s own app (Claude Code or Codex) with your subscription.',
      };

    case 'subscription': {
      const source = auth.plan === 'claude' ? SOURCES.anthropic : SOURCES.openaiAuth;
      if (HOME_APP[auth.plan] !== agent)
        return {
          allowed: false,
          reason: `A ${auth.plan === 'claude' ? 'Claude' : 'ChatGPT'} plan works only in its own app (${HOME_APP[auth.plan] === 'claude-code' ? 'Claude Code' : 'Codex'}), never inside another tool.`,
          source,
          fix: 'Use an API key with this agent instead.',
        };
      if (trigger === 'director')
        return {
          allowed: false,
          reason:
            'A subscription is for its owner alone. Running it for someone else is sharing the account, which both Anthropic and OpenAI forbid.',
          source: auth.plan === 'claude' ? SOURCES.anthropicConsumer : SOURCES.openaiTerms,
          fix: 'People you invite can use an agent only with your API key, and only if you turn that on.',
        };
      if (trigger === 'schedule')
        return {
          allowed: false,
          reason:
            'Plans are priced for ordinary, individual use: a person at the keyboard. Runs nobody started just now need an API key, which is what the providers say automation should use.',
          source: auth.plan === 'claude' ? SOURCES.anthropic : SOURCES.openaiExec,
          fix: 'Add your own API key for this provider and choose it for scheduled runs.',
        };
      return {
        allowed: true,
        reason: `You asked for this run yourself, so it runs in the unmodified ${agent === 'claude-code' ? 'Claude Code' : 'Codex'} you signed in to, with its own sign-in, which Hildegard never sees. Runs are paced like a person working.`,
        source,
      };
    }

    case 'api-key':
    case 'cloud':
      // Anthropic: "Each end user must authenticate with their own Anthropic API key, Claude subscription plan
      // credentials, or 3P inference provider credential", and nobody may "pay for ... Claude usage on their end
      // users' behalf". So nobody else ever runs Claude on the owner's key or cloud account, whatever the setting.
      if (
        trigger === 'director' &&
        (agent === 'claude-code' || auth.kind === 'cloud' || auth.provider === 'anthropic')
      )
        return {
          allowed: false,
          reason:
            'Anthropic requires everyone who uses Claude to sign in with their own key or plan, so people you invite can’t run Claude on yours.',
          source: SOURCES.anthropic,
          fix: 'They can use Claude Code on their own computer with their own account, or a local model here.',
        };
      if (trigger === 'director' && !opts.shareKeysWithDirectors)
        return {
          allowed: false,
          reason:
            'People you invite can’t use your API keys unless you turn that on; their runs would be billed to you.',
          fix: '`hildegard agents share-keys on` lets them use your non-Anthropic keys, billed to you. Never charge them for it: reselling usage needs your own agreement with the provider.',
        };
      return {
        allowed: true,
        reason:
          auth.kind === 'cloud'
            ? `Billed to your own ${auth.provider} account under its terms.`
            : `Billed to your own ${auth.provider} API key, the way the providers ask tools and automation to work.`,
        source:
          auth.provider === 'anthropic' || auth.kind === 'cloud' ? SOURCES.anthropic : SOURCES.openaiAuth,
      };

    case 'local':
      return {
        allowed: true,
        reason: `A model on your own computers (${auth.provider}): no account, no terms to break.`,
      };
  }
}

/**
 * Paces subscription runs like a person working: one at a time, a short breath between them, and a daily ceiling.
 * API keys and local models aren't paced here; their own limits and budgets apply.
 */
export interface PaceState {
  /** ISO times runs started in the last day. */
  starts: string[];
  running: boolean;
}

export const PACE = { gapMs: 30_000, perDay: 40 };

export function pace(
  state: PaceState,
  now = Date.now(),
): { ok: true } | { ok: false; reason: string; retryAt?: number } {
  if (state.running)
    return { ok: false, reason: 'Another subscription run is going. One at a time, as a person would.' };
  const day = state.starts.map((s) => Date.parse(s)).filter((t) => now - t < 86_400_000);
  const last = Math.max(0, ...day);
  if (now - last < PACE.gapMs)
    return { ok: false, reason: 'Wait a moment between runs.', retryAt: last + PACE.gapMs };
  if (day.length >= PACE.perDay)
    return {
      ok: false,
      reason: `That’s ${PACE.perDay} subscription runs today, more than a person working would start. Use an API key for more.`,
      retryAt: Math.min(...day) + 86_400_000,
    };
  return { ok: true };
}
