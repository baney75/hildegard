#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './index.ts';

// stdout carries the protocol; anything for people goes to stderr.
const server = createMcpServer();
await server.connect(new StdioServerTransport());
console.error('Hildegard MCP server ready on stdio.');
