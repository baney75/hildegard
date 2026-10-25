// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Hildegard's skills over MCP, so every app that links Hildegard gets its craft with its compute: ChatGPT, Grok and
 * claude.ai, which can't install a skill folder from a computer, read them here. Each skill is a tool to read
 * (`read_skill`, which works in every app) and a prompt (for apps that list prompts as commands).
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const text = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }] });
const fail = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }], isError: true });
/** What a skill holds that an app may read: words, and scripts to run itself. */
const READABLE = /\.(md|txt|py|json|toml|ya?ml|css)$/;
const MAX_READ = 400 * 1024;

export interface SkillInfo {
  name: string;
  description: string;
  dir: string;
}

/** The skills folder: shipped beside Hildegard, or the repository's. Null if there isn't one. */
export function findSkills(): string | null {
  const shipped = process.env.HILDEGARD_RESOURCES;
  if (shipped && existsSync(join(shipped, 'skills'))) return join(shipped, 'skills');
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, 'skills', 'hildegard-craft', 'SKILL.md'))) return join(dir, 'skills');
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function frontmatter(md: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  const out: Record<string, string> = {};
  for (const line of m?.[1]?.split(/\r?\n/) ?? []) {
    const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, '');
  }
  return out;
}

export function readSkills(root: string | null): SkillInfo[] {
  if (!root || !existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, 'SKILL.md')))
    .map((d) => {
      const fm = frontmatter(readFileSync(join(root, d.name, 'SKILL.md'), 'utf8'));
      return { name: fm.name ?? d.name, description: fm.description ?? '', dir: join(root, d.name) };
    })
    .sort((a, b) =>
      a.name === 'hildegard' ? -1 : b.name === 'hildegard' ? 1 : a.name.localeCompare(b.name),
    );
}

/** Every file in a skill an app may read, relative to the skill's folder. */
function files(dir: string, at = dir): string[] {
  return readdirSync(at, { withFileTypes: true }).flatMap((d) => {
    const p = join(at, d.name);
    if (d.isDirectory()) return d.name.startsWith('.') || d.name === '__pycache__' ? [] : files(dir, p);
    return READABLE.test(d.name) ? [relative(dir, p).split(sep).join('/')] : [];
  });
}

/** A file inside a skill, or null: never a path that leaves the skill's folder, by `..` or by a link. */
export function skillFile(skill: SkillInfo, file: string): string | null {
  if (!READABLE.test(file) || file.includes('\0')) return null;
  const path = join(skill.dir, file);
  if (!existsSync(path)) return null;
  const real = realpathSync(path);
  const base = realpathSync(skill.dir);
  if (!real.startsWith(base + sep) || !statSync(real).isFile()) return null;
  return real;
}

export function registerSkillTools(server: McpServer, root: string | null = findSkills()) {
  const skills = readSkills(root);
  if (!skills.length) return;
  const named = (name: string) => skills.find((s) => s.name === name || s.name === `hildegard-${name}`);

  server.registerTool(
    'list_skills',
    {
      title: 'Hildegard’s skills',
      description:
        'The craft skills that come with Hildegard: how to make art, film, sound, 3D models and writing that isn’t slop, and how to run Hildegard itself. Read the one that fits before you make anything, with read_skill.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      text(
        [
          'Read the one that fits with read_skill (name). Start with hildegard for any creative work; it says which others to read.',
          ...skills.map((s) => `- ${s.name}: ${s.description}`),
        ].join('\n'),
      ),
  );

  server.registerTool(
    'read_skill',
    {
      title: 'Read a skill',
      description:
        'Read one of Hildegard’s skills (its SKILL.md), or a file it names, such as references/sculpture-3d.md or scripts/contact_sheet.py. Follow it as instructions for the work your user asked for.',
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(80)
          .describe('The skill, from list_skills, such as hildegard or hildegard-3d.'),
        file: z
          .string()
          .max(200)
          .optional()
          .describe('A file inside the skill, as the skill names it. Default SKILL.md.'),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      const s = named(a.name);
      if (!s) return fail(`No skill "${a.name}". Use one of: ${skills.map((x) => x.name).join(', ')}.`);
      const want = a.file?.replace(/^\.?\//, '') || 'SKILL.md';
      const path = skillFile(s, want);
      if (!path) return fail(`${s.name} has no file "${want}". It has: ${files(s.dir).join(', ')}.`);
      const body = readFileSync(path, 'utf8');
      const more = want === 'SKILL.md' ? files(s.dir).filter((f) => f !== 'SKILL.md') : [];
      return text(
        `${body.length > MAX_READ ? `${body.slice(0, MAX_READ)}\n\n[cut at ${MAX_READ / 1024} KB]` : body}${more.length ? `\n\n---\nFiles in this skill (read_skill with file): ${more.join(', ')}` : ''}`,
      );
    },
  );

  // Apps that show prompts as commands (/hildegard, /hildegard-3d) start the work with the skill loaded.
  for (const s of skills)
    server.registerPrompt(
      s.name,
      {
        title: s.name,
        description: s.description.slice(0, 1000),
        argsSchema: { request: z.string().optional().describe('What to make.') },
      },
      (args) => ({
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `${readFileSync(join(s.dir, 'SKILL.md'), 'utf8')}\n\n---\nFollow the skill above. Its other files are in read_skill (name "${s.name}").${args.request ? `\n\nMy request: ${args.request}` : ''}`,
            },
          },
        ],
      }),
    );
}
