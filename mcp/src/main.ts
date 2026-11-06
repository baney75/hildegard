#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './index.ts';

// stdout carries the protocol; anything for people goes to stderr.
// The person started this for their own AI app, on their own computer: it may read files they name by path.
const server = createMcpServer(undefined, { files: true });
await server.connect(new StdioServerTransport());
console.error('Hildegard MCP server ready on stdio.');
