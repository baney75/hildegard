// SPDX-License-Identifier: AGPL-3.0-only
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { HildegardClient } from './client.ts';
import { registerLoopTools } from './loop-tools.ts';
import { registerReportTools } from './report-tools.ts';
import { registerSiteTools } from './site-tools.ts';
import { findSkills, registerSkillTools } from './skill-tools.ts';
import { registerTools } from './tools.ts';

export { HildegardClient, HildegardError, type VoiceJobDetail } from './client.ts';
export * from './report.ts';
export * from './skill-scan.ts';
export { findSkills, modelNotes, readSkills, type SkillInfo } from './skill-tools.ts';
export { registerTools, toRequest } from './tools.ts';
export { zip, zipFolder } from './zip.ts';

export const INSTRUCTIONS = `Hildegard is the user's own studio: it renders film shots, stills and voices on their own GPUs, checks 3D models and media, and carries the craft skills for making work that isn't slop. Nothing leaves their computers and nothing costs money.
Craft first: for any creative request (art, film, music, 3D, writing), call list_skills and read_skill "hildegard" (then the skills it names) before you make anything, and follow them.
Start with hildegard_status. If no video model is installed, offer install_model, and show the user the license terms it returns before accepting.
Use list_presets for the ids of camera bodies, lenses, moves and looks. Write prompts as literal, chronological action; the camera and look come from the fields.
To put shots in a film, pass its id or its title as film to direct_shot. To stop a take, cancel_take with its id; hildegard_status lists recent takes.
Draft first, then re-render the take you like with quality "final" and the same seed.
Voice: list_voices, then speak a script in any voice there; design_voice makes a new one from words. You can't clone a voice: clone_voice says how the person does it themselves, with their consent.
Sites: for a website, start from site_templates, a Figma link, a pen.dev file or the live site (site_new), edit it with site_read and site_write, and run it through the web loop with site_id.
Loops: to make a 3D model or a part to print, to design a web page or site, or to iterate on any image, video or sound until it is right, loop_start, then loop_submit each version, look at what comes back, and loop_critique it honestly before the next round; loop_finish delivers the best round.
Reports: when Hildegard itself fails (a tool errors, or a take fails, in a way no change to the request fixes), or your user wants something it can't do yet, offer to tell its makers. report_draft writes it with the computer's details, private things taken out; show your user the exact text and any matching issues, and call report_file only after they say yes. Never file without asking, and add to a matching issue rather than open a new one.
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

/** The version this MCP server reports, as the release sets it. */
export const MCP_VERSION = '0.1.12';

export function createMcpServer(client = new HildegardClient(), opts: McpOptions = {}) {
  const server = new McpServer(
    { name: 'hildegard', title: 'Hildegard', version: MCP_VERSION },
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
  registerReportTools(
    server,
    client,
    () => opts.agentName ?? (server.server.getClientVersion()?.name?.slice(0, 60) || 'agent'),
    MCP_VERSION,
    !!opts.remote,
  );
  registerSiteTools(server, client, opts.remote);
  registerSkillTools(server, opts.skillsDir === undefined ? findSkills() : opts.skillsDir);
  return server;
}
