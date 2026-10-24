// SPDX-License-Identifier: AGPL-3.0-only
// A small reader for the Studio's own stylesheets: enough to list each style rule's selectors, inside @media and
// @supports blocks too. It understands comments and quoted strings (the icons are data URLs), nothing more.

export interface StyleRule {
  /** The selector list as written, split on its top-level commas. */
  selectors: string[];
  /** Where the selector list starts and the rule's closing brace ends, in the file. */
  start: number;
  end: number;
  /** Where the selector list ends (the opening brace). */
  open: number;
}

/** Find where the block that opens at `i` (a `{`) closes, skipping strings and comments. */
function closing(css: string, i: number): number {
  let depth = 0;
  for (; i < css.length; i++) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') i = css.indexOf('*/', i + 2) + 1;
    else if (c === '"' || c === "'") i = skipString(css, i);
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  throw new Error('Unbalanced braces');
}

function skipString(css: string, i: number): number {
  const q = css[i];
  for (i++; i < css.length && css[i] !== q; i++) if (css[i] === '\\') i++;
  return i;
}

export function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === '"' || c === "'") i = skipString(list, i);
    else if (c === ',' && depth === 0) {
      out.push(list.slice(from, i).trim());
      from = i + 1;
    }
  }
  out.push(list.slice(from).trim());
  return out.filter(Boolean);
}

/** Every style rule in the sheet, in order. At-rules other than @media and @supports are passed over. */
export function styleRules(css: string, from = 0, to = css.length): StyleRule[] {
  const rules: StyleRule[] = [];
  let i = from;
  while (i < to) {
    // Skip whitespace and comments.
    while (i < to && /\s/.test(css[i]!)) i++;
    if (css.startsWith('/*', i)) {
      i = css.indexOf('*/', i + 2) + 2;
      continue;
    }
    if (i >= to || css[i] === '}') break;
    const start = i;
    // The prelude runs to the next `{` or `;` at the top level.
    while (i < to && css[i] !== '{' && css[i] !== ';') {
      if (css[i] === '"' || css[i] === "'") i = skipString(css, i);
      i++;
    }
    if (css[i] === ';') {
      i++;
      continue;
    }
    const prelude = css.slice(start, i).trim();
    const end = closing(css, i);
    if (prelude.startsWith('@media') || prelude.startsWith('@supports'))
      rules.push(...styleRules(css, i + 1, end));
    else if (!prelude.startsWith('@'))
      rules.push({ selectors: splitSelectors(prelude), start, open: i, end });
    i = end + 1;
  }
  return rules;
}

/** The class names a selector needs, so a selector with any class nothing renders can never match. */
export function classesIn(selector: string): string[] {
  // Leave out what sits inside :not(…): a missing class there never stops the selector matching.
  const plain = selector.replace(/:not\((?:[^()]|\([^()]*\))*\)/g, '').replace(/\[[^\]]*\]/g, '');
  return [...plain.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]!);
}

/**
 * Whether the Studio's source can ever put this class on an element: it appears as a word in the source, or it is
 * a known prefix written as a template (`hg-btn--${kind}`, `i-${name}`) followed by a word that does.
 */
export function classKnown(sources: string): (cls: string) => boolean {
  const words = new Set(sources.match(/[\w-]+/g));
  const prefixes = new Set(
    [...sources.matchAll(/([\w-]*[\w-])\$\{/g)].map((m) => m[1]!.split(/[\s'"`]/).pop()!),
  );
  return (cls) =>
    words.has(cls) || [...prefixes].some((p) => cls.startsWith(p) && words.has(cls.slice(p.length)));
}
