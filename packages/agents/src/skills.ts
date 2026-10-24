// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Hildegard's skills, installed where each agent looks for them: Claude Code reads `~/.claude/skills`, Codex reads
 * `~/.agents/skills`, and OMP reads both. Only folders Hildegard put there (marked with `.hildegard`) are replaced or
 * removed; a skill of the owner's with the same name is left alone.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Skill {
  name: string;
  description: string;
  dir: string;
}

const MARK = '.hildegard';

/** Reads `name` and `description` from a SKILL.md's frontmatter. */
export function frontmatter(md: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, '');
  }
  return out;
}

export function listSkills(skillsDir: string): Skill[] {
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(skillsDir, d.name, 'SKILL.md')))
    .map((d) => {
      const fm = frontmatter(readFileSync(join(skillsDir, d.name, 'SKILL.md'), 'utf8'));
      return { name: fm.name ?? d.name, description: fm.description ?? '', dir: join(skillsDir, d.name) };
    });
}

export type SkillTarget = 'claude-code' | 'codex' | 'omp';

/** Where an agent reads user-wide skills, or a project's own when `project` is given. */
export function skillRoots(
  target: SkillTarget,
  project?: string,
  env = process.env,
  home = homedir(),
): string[] {
  if (project)
    return target === 'codex' ? [join(project, '.agents', 'skills')] : [join(project, '.claude', 'skills')];
  const claude = join(env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), 'skills');
  const agents = join(home, '.agents', 'skills');
  // OMP picks up both, so the Claude Code folder covers it without a third copy.
  return target === 'codex' ? [agents] : [claude];
}

export interface InstallOutcome {
  skill: string;
  path: string;
  status: 'installed' | 'updated' | 'kept-yours' | 'removed';
}

export function installSkills(skillsDir: string, roots: string[], version: string): InstallOutcome[] {
  const out: InstallOutcome[] = [];
  for (const root of roots) {
    mkdirSync(root, { recursive: true });
    for (const s of listSkills(skillsDir)) {
      const dest = join(root, s.name);
      const ours = existsSync(join(dest, MARK));
      if (existsSync(dest) && !ours) {
        out.push({ skill: s.name, path: dest, status: 'kept-yours' });
        continue;
      }
      if (ours) rmSync(dest, { recursive: true, force: true });
      cpSync(s.dir, dest, { recursive: true });
      writeFileSync(
        join(dest, MARK),
        `Installed by Hildegard ${version}. \`hildegard skills remove\` removes it.\n`,
      );
      out.push({ skill: s.name, path: dest, status: ours ? 'updated' : 'installed' });
    }
  }
  return out;
}

export function removeSkills(skillsDir: string, roots: string[]): InstallOutcome[] {
  const out: InstallOutcome[] = [];
  for (const root of roots)
    for (const s of listSkills(skillsDir)) {
      const dest = join(root, s.name);
      if (existsSync(join(dest, MARK))) {
        rmSync(dest, { recursive: true, force: true });
        out.push({ skill: s.name, path: dest, status: 'removed' });
      }
    }
  return out;
}
