// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A site's design tokens: the CSS custom properties it sets on :root, light and dark, read from its stylesheets and
 * changed in place, so the canvas can show a site's system and change a colour or a size everywhere at once without
 * touching anything else in the file.
 */

export interface Token {
  name: string;
  value: string;
  /** Set for the dark theme (inside prefers-color-scheme: dark, or a [data-theme=dark] rule). */
  dark: boolean;
  file: string;
}

interface Decl {
  name: string;
  value: string;
  dark: boolean;
  /** Where the value starts and ends in the text. */
  start: number;
  end: number;
}

const ROOT = /(^|,)\s*(:root|html)(\[[^\]]*\])?\s*($|,)/;
const DARKSEL = /\[data-(theme|mode|color-scheme)=["']?dark["']?\]|\.dark\b|\.theme-dark\b/;

/** The custom properties set on :root (or html), with where each value sits in the text. */
function scan(css: string): Decl[] {
  const out: Decl[] = [];
  const stack: string[] = [];
  let i = 0;
  let prelude = 0;
  while (i < css.length) {
    const c = css[i]!;
    if (c === '/' && css[i + 1] === '*') {
      const e = css.indexOf('*/', i + 2);
      i = e < 0 ? css.length : e + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < css.length && css[i] !== c) i += css[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (c === '{') {
      stack.push(
        css
          .slice(prelude, i)
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .trim(),
      );
      prelude = i + 1;
    } else if (c === '}') {
      stack.pop();
      prelude = i + 1;
    } else if (c === ';') {
      prelude = i + 1;
    } else if (c === '-' && css[i + 1] === '-' && stack.length && /[\s;{]/.test(css[i - 1] ?? ' ')) {
      const m = /^--([\w-]+)\s*:/.exec(css.slice(i, i + 200));
      const sel = stack.at(-1)!;
      const bare = sel.replace(DARKSEL, '').trim();
      if (m && (ROOT.test(bare) || (bare === '' && DARKSEL.test(sel)))) {
        const start = i + m[0].length;
        let end = start;
        let depth = 0;
        while (end < css.length) {
          const ch = css[end]!;
          if (ch === '(') depth++;
          else if (ch === ')') depth--;
          else if ((ch === ';' && depth <= 0) || ch === '}') break;
          end++;
        }
        const dark = stack.some((p) => /prefers-color-scheme\s*:\s*dark/.test(p)) || DARKSEL.test(sel);
        const raw = css.slice(start, end);
        const lead = raw.length - raw.trimStart().length;
        out.push({
          name: `--${m[1]}`,
          value: raw.trim(),
          dark,
          start: start + lead,
          end: start + lead + raw.trim().length,
        });
        i = end;
        prelude = end;
        continue;
      }
    }
    i++;
  }
  return out;
}

/** The tokens in one stylesheet (the last value wins, as in the cascade). */
export function readTokens(css: string, file: string): Token[] {
  const seen = new Map<string, Token>();
  for (const d of scan(css))
    seen.set(`${d.name}|${d.dark}`, { name: d.name, value: d.value, dark: d.dark, file });
  return [...seen.values()];
}

/** A value that is safe to put in a declaration: no way out of it into another rule. */
export function tokenValue(v: string): string | null {
  const s = v.trim();
  if (!s || s.length > 300 || /[;{}<>\\]|\/\*|url\s*\(|@import|expression\s*\(/i.test(s)) return null;
  let depth = 0;
  for (const ch of s) {
    depth += ch === '(' ? 1 : ch === ')' ? -1 : 0;
    if (depth < 0) return null;
  }
  return depth === 0 ? s : null;
}

/** The stylesheet with one token changed (its last setting, light or dark), or null if it isn't set there. */
export function setToken(css: string, name: string, value: string, dark = false): string | null {
  const v = tokenValue(value);
  if (!v || !/^--[\w-]{1,80}$/.test(name)) return null;
  const d = scan(css)
    .filter((x) => x.name === name && x.dark === dark)
    .at(-1);
  if (!d) return null;
  return `${css.slice(0, d.start)}${v}${css.slice(d.end)}`;
}
