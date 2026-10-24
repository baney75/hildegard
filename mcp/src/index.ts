// SPDX-License-Identifier: AGPL-3.0-only
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { HildegardClient } from './client.ts';
import { registerTools } from './tools.ts';

export { HildegardClient, HildegardError } from './client.ts';
export { registerTools, toRequest } from './tools.ts';

export const INSTRUCTIONS = `Hildegard renders film shots on the user's own GPU, through ComfyUI. Nothing leaves their computers and nothing costs money.
Start with hildegard_status. If no video model is installed, offer install_model, and show the user the license terms it returns before accepting.
Use list_presets for the ids of camera bodies, lenses, moves and looks. Write prompts as literal, chronological action; the camera and look come from the fields.
To put shots in a film, pass its id or its title as film to direct_shot. To stop a take, cancel_take with its id; hildegard_status lists recent takes.
Draft first, then re-render the take you like with quality "final" and the same seed.
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
  return server;
}
