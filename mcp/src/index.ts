// SPDX-License-Identifier: AGPL-3.0-only
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { HildegardClient } from './client.ts';
import { registerLoopTools } from './loop-tools.ts';
import { findSkills, registerSkillTools } from './skill-tools.ts';
import { registerTools } from './tools.ts';

export { HildegardClient, HildegardError, type VoiceJobDetail } from './client.ts';
export { findSkills, readSkills, type SkillInfo } from './skill-tools.ts';
export { registerTools, toRequest } from './tools.ts';

export const INSTRUCTIONS = `Hildegard is the user's own studio: it renders film shots, stills and voices on their own GPUs, checks 3D models and media, and carries the craft skills for making work that isn't slop. Nothing leaves their computers and nothing costs money.
Craft first: for any creative request (art, film, music, 3D, writing), call list_skills and read_skill "hildegard" (then the skills it names) before you make anything, and follow them.
Start with hildegard_status. If no video model is installed, offer install_model, and show the user the license terms it returns before accepting.
Use list_presets for the ids of camera bodies, lenses, moves and looks. Write prompts as literal, chronological action; the camera and look come from the fields.
To put shots in a film, pass its id or its title as film to direct_shot. To stop a take, cancel_take with its id; hildegard_status lists recent takes.
Draft first, then re-render the take you like with quality "final" and the same seed.
Voice: list_voices, then speak a script in any voice there; design_voice makes a new one from words. You can't clone a voice: clone_voice says how the person does it themselves, with their consent.
Loops: to make a 3D model, or to iterate on any image, video or sound until it is right, loop_start, then loop_submit each version, look at what comes back, and loop_critique it honestly before the next round; loop_finish delivers the best round.
Quality gate: review_prompt before you render, and review_take on every finished take before you choose or show it. Look at the contact sheet and answer its questions honestly; fix and re-render (at most three rounds) rather than deliver work that fails.`;

export interface McpOptions {
  /**
   * The name takes are labelled with. By default the name the AI app reports for itself; over the network, the name
   * of the key or chatbot it signed in with, which the app can't change.
   */
  agentName?: string;
  /**
   * The AI app is on another device: Hildegard's files are not on its disk. Videos and stills come back as links
   * (signed, so they open without signing in, and expiring), and start frames come as image data, never as paths.
   */
  remote?: { link: (path: string) => string };
  /** Where the skills are; found beside Hildegard by default. */
  skillsDir?: string | null;
}

export function createMcpServer(client = new HildegardClient(), opts: McpOptions = {}) {
  const server = new McpServer(
    { name: 'hildegard', title: 'Hildegard', version: '0.1.6' },
    { instructions: INSTRUCTIONS },
  );
  // Takes are labelled with the agent that asked for them, as its client reports its own name.
  registerTools(
    server,
    client,
    () => opts.agentName ?? (server.server.getClientVersion()?.name?.slice(0, 60) || 'agent'),
    opts.remote,
  );
  registerLoopTools(
    server,
    client,
    () => opts.agentName ?? (server.server.getClientVersion()?.name?.slice(0, 60) || 'agent'),
    opts.remote,
  );
  registerSkillTools(server, opts.skillsDir === undefined ? findSkills() : opts.skillsDir);
  return server;
}
