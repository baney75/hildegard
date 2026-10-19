// SPDX-License-Identifier: AGPL-3.0-only
import { createMcpServer, HildegardClient } from '@hildegard/mcp';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

/** Hildegard's MCP server on stdio. stdout carries the protocol; anything for people goes to stderr. */
export async function runStdio(defaultUrl: string) {
  const server = createMcpServer(new HildegardClient(process.env.HILDEGARD_URL ?? defaultUrl));
  await server.connect(new StdioServerTransport());
  console.error('Hildegard MCP server ready on stdio.');
}
