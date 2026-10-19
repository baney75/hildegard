// SPDX-License-Identifier: AGPL-3.0-only
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { HildegardClient } from './client.ts';
import { registerTools } from './tools.ts';

export { HildegardClient, HildegardError } from './client.ts';
export { registerTools, toRequest } from './tools.ts';

export const INSTRUCTIONS = `Hildegard renders film shots on the user's own GPU, through ComfyUI. Nothing leaves their computers and nothing costs money.
Start with hildegard_status. If no video model is installed, offer install_model, and show the user the license terms it returns before accepting.
Use list_presets for the ids of camera bodies, lenses, moves and looks. Write prompts as literal, chronological action; the camera and look come from the fields.
Draft first, then re-render the take you like with quality "final" and the same seed.`;

export function createMcpServer(client = new HildegardClient()) {
  const server = new McpServer(
    { name: 'hildegard', title: 'Hildegard', version: '0.1.0' },
    { instructions: INSTRUCTIONS },
  );
  // Takes are labelled with the agent that asked for them, as its client reports its own name.
  registerTools(server, client, () => server.server.getClientVersion()?.name?.slice(0, 60) || 'agent');
  return server;
}
