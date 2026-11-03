// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The Talk demo script: staged, invented lines to read aloud, with what to show between them. Nothing here is about
 * a real person, place or account, so a recording of the demo shows nothing private. The first line is the one the
 * staged test recording says (apps/server/test/fixtures/talk/lighthouse.wav.txt).
 */
export interface ScriptBeat {
  /** What to show or do before the line, for the person running the demo. */
  cue: string;
  /** What to say into the microphone; null for a beat with nothing to say. */
  line: string | null;
}

export const DEMO_SCRIPT: ScriptBeat[] = [
  {
    cue: 'Open Settings › Devices. This computer is primary; the server beside it hears and answers.',
    line: null,
  },
  {
    cue: 'Open Talk and choose the server under Hear and answer on.',
    line: 'Plan a short film about a lighthouse keeper.',
  },
  {
    cue: 'Let the answer play, then point at the timing under it.',
    line: 'She keeps the light alone on a rock in the sea. Give me three shots for the opening.',
  },
  { cue: 'Ask for a change.', line: 'Make the storm arrive in the second shot.' },
  {
    cue: 'In Settings › Devices, make the server primary, come back, and talk again.',
    line: 'What does she say when the supply boat finally comes?',
  },
  { cue: 'Make this computer primary again.', line: 'Thank you. That’s the opening.' },
  { cue: 'Close on the Devices page: every machine you own, one studio.', line: null },
];
