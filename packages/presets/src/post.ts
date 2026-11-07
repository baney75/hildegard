// SPDX-License-Identifier: Apache-2.0
/**
 * Post: what each platform takes (size, shape, length, loudness, how much text) and how the words that go with a
 * film or an image are written from facts the person gave. Hildegard prepares; the person presses Post. Shared by the
 * server, the Studio and the MCP tools. The numbers are each platform's published limits and guidance as of
 * 2026-11; a platform that changes them is one edit here.
 */
import { z } from 'zod';

export type PostPlatformId =
  | 'youtube'
  | 'instagram'
  | 'tiktok'
  | 'x'
  | 'facebook'
  | 'threads'
  | 'reddit'
  | 'linkedin';

export const POST_PLATFORM_IDS = [
  'youtube',
  'instagram',
  'tiktok',
  'x',
  'facebook',
  'threads',
  'reddit',
  'linkedin',
] as const satisfies readonly PostPlatformId[];

export const PostPlatform = z.enum(POST_PLATFORM_IDS);

export type PostAspect = '16:9' | '9:16' | '1:1' | '4:5';

/** Pixels kept clear on each side at the target's size: where a platform's own buttons and captions sit. */
export interface SafeArea {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** One file Hildegard makes for a platform: a format of it (Shorts, Reels, the feed). */
export interface PostTarget {
  id: string;
  platform: PostPlatformId;
  label: string;
  aspect: PostAspect;
  width: number;
  height: number;
  /** The longest the platform takes; a longer film is cut to this, and the result says so. Null: none Hildegard knows. */
  maxSeconds: number | null;
  maxBytes: number;
  /** The video bit rate aimed for, in kilobits a second (lower when the file would pass maxBytes). */
  videoKbps: number;
  maxFps: number;
  media: ReadonlyArray<'video' | 'image'>;
  safeArea: SafeArea;
  text: {
    /** The platform has a separate title, this long. */
    titleMax: number | null;
    captionMax: number;
    hashtagsMax: number;
    /** Counted as X counts: links as 23, wide characters as 2. */
    weighted?: boolean;
  };
  thumbnail: { width: number; height: number; maxBytes: number };
}

/** Loudness every target is set to: what YouTube plays at, and what the short-video apps level to. */
export const POST_LUFS = -14;
export const POST_TRUE_PEAK = -1;

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** Title-safe margins for a frame with no buttons over it: 5% of each side. */
const margin = (w: number, h: number): SafeArea => ({
  top: Math.round(h * 0.05),
  bottom: Math.round(h * 0.05),
  left: Math.round(w * 0.05),
  right: Math.round(w * 0.05),
});

export const POST_TARGETS: readonly PostTarget[] = [
  {
    id: 'youtube',
    platform: 'youtube',
    label: 'YouTube',
    aspect: '16:9',
    width: 1920,
    height: 1080,
    maxSeconds: null,
    maxBytes: 100 * GiB,
    videoKbps: 8000,
    maxFps: 60,
    media: ['video'],
    safeArea: margin(1920, 1080),
    text: { titleMax: 100, captionMax: 5000, hashtagsMax: 15 },
    thumbnail: { width: 1280, height: 720, maxBytes: 2 * MiB },
  },
  {
    id: 'youtube-shorts',
    platform: 'youtube',
    label: 'YouTube Shorts',
    aspect: '9:16',
    width: 1080,
    height: 1920,
    maxSeconds: 180,
    maxBytes: 2 * GiB,
    videoKbps: 8000,
    maxFps: 60,
    media: ['video'],
    safeArea: { top: 190, bottom: 380, left: 65, right: 130 },
    text: { titleMax: 100, captionMax: 5000, hashtagsMax: 15 },
    thumbnail: { width: 1080, height: 1920, maxBytes: 2 * MiB },
  },
  {
    id: 'instagram-reels',
    platform: 'instagram',
    label: 'Instagram Reels',
    aspect: '9:16',
    width: 1080,
    height: 1920,
    maxSeconds: 180,
    maxBytes: GiB,
    videoKbps: 6000,
    maxFps: 60,
    media: ['video'],
    safeArea: { top: 250, bottom: 670, left: 65, right: 120 },
    text: { titleMax: null, captionMax: 2200, hashtagsMax: 30 },
    thumbnail: { width: 1080, height: 1920, maxBytes: 8 * MiB },
  },
  {
    id: 'instagram-feed',
    platform: 'instagram',
    label: 'Instagram feed',
    aspect: '4:5',
    width: 1080,
    height: 1350,
    maxSeconds: null,
    maxBytes: GiB,
    videoKbps: 6000,
    maxFps: 60,
    media: ['video', 'image'],
    safeArea: margin(1080, 1350),
    text: { titleMax: null, captionMax: 2200, hashtagsMax: 30 },
    thumbnail: { width: 1080, height: 1350, maxBytes: 8 * MiB },
  },
  {
    id: 'tiktok',
    platform: 'tiktok',
    label: 'TikTok',
    aspect: '9:16',
    width: 1080,
    height: 1920,
    maxSeconds: 600,
    maxBytes: 287 * MiB,
    videoKbps: 6000,
    maxFps: 60,
    media: ['video', 'image'],
    safeArea: { top: 150, bottom: 480, left: 60, right: 140 },
    text: { titleMax: null, captionMax: 2200, hashtagsMax: 30 },
    thumbnail: { width: 1080, height: 1920, maxBytes: 8 * MiB },
  },
  {
    id: 'x',
    platform: 'x',
    label: 'X',
    aspect: '16:9',
    width: 1920,
    height: 1080,
    maxSeconds: 140,
    maxBytes: 512 * MiB,
    videoKbps: 8000,
    maxFps: 60,
    media: ['video', 'image'],
    safeArea: margin(1920, 1080),
    text: { titleMax: null, captionMax: 280, hashtagsMax: 3, weighted: true },
    thumbnail: { width: 1920, height: 1080, maxBytes: 5 * MiB },
  },
  {
    id: 'x-square',
    platform: 'x',
    label: 'X (square)',
    aspect: '1:1',
    width: 1080,
    height: 1080,
    maxSeconds: 140,
    maxBytes: 512 * MiB,
    videoKbps: 6000,
    maxFps: 60,
    media: ['video', 'image'],
    safeArea: margin(1080, 1080),
    text: { titleMax: null, captionMax: 280, hashtagsMax: 3, weighted: true },
    thumbnail: { width: 1080, height: 1080, maxBytes: 5 * MiB },
  },
  {
    id: 'facebook',
    platform: 'facebook',
    label: 'Facebook',
    aspect: '4:5',
    width: 1080,
    height: 1350,
    maxSeconds: null,
    maxBytes: 4 * GiB,
    videoKbps: 6000,
    maxFps: 60,
    media: ['video', 'image'],
    safeArea: margin(1080, 1350),
    text: { titleMax: null, captionMax: 5000, hashtagsMax: 10 },
    thumbnail: { width: 1080, height: 1350, maxBytes: 8 * MiB },
  },
  {
    id: 'threads',
    platform: 'threads',
    label: 'Threads',
    aspect: '9:16',
    width: 1080,
    height: 1920,
    maxSeconds: 300,
    maxBytes: GiB,
    videoKbps: 6000,
    maxFps: 60,
    media: ['video', 'image'],
    safeArea: { top: 150, bottom: 300, left: 65, right: 100 },
    text: { titleMax: null, captionMax: 500, hashtagsMax: 1 },
    thumbnail: { width: 1080, height: 1920, maxBytes: 8 * MiB },
  },
  {
    id: 'reddit',
    platform: 'reddit',
    label: 'Reddit',
    aspect: '16:9',
    width: 1920,
    height: 1080,
    maxSeconds: 900,
    maxBytes: GiB,
    videoKbps: 8000,
    maxFps: 60,
    media: ['video', 'image'],
    safeArea: margin(1920, 1080),
    text: { titleMax: 300, captionMax: 10_000, hashtagsMax: 0 },
    thumbnail: { width: 1920, height: 1080, maxBytes: 8 * MiB },
  },
  {
    id: 'linkedin',
    platform: 'linkedin',
    label: 'LinkedIn',
    aspect: '16:9',
    width: 1920,
    height: 1080,
    maxSeconds: 600,
    maxBytes: GiB,
    videoKbps: 8000,
    maxFps: 60,
    media: ['video', 'image'],
    safeArea: margin(1920, 1080),
    text: { titleMax: null, captionMax: 3000, hashtagsMax: 5 },
    thumbnail: { width: 1920, height: 1080, maxBytes: 8 * MiB },
  },
];

export const POST_TARGET_IDS = POST_TARGETS.map((t) => t.id);

/** What `source` looks like to the picker: its shape decides X's format. */
export interface PostSourceShape {
  kind: 'video' | 'image';
  width: number;
  height: number;
}

export interface PostPlan {
  /** The targets to make, in order. */
  targets: PostTarget[];
  /** A platform that can't take this kind of file, with why. */
  skipped: Array<{ platform: PostPlatformId; why: string }>;
}

const PLATFORM_NAME: Record<PostPlatformId, string> = {
  youtube: 'YouTube',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  x: 'X',
  facebook: 'Facebook',
  threads: 'Threads',
  reddit: 'Reddit',
  linkedin: 'LinkedIn',
};
export const platformName = (p: PostPlatformId): string => PLATFORM_NAME[p];

export interface PlanOptions {
  /** YouTube at 3840×2160 instead of 1920×1080. */
  youtube4k?: boolean;
  /** Which formats of a platform: by default YouTube makes the video and Shorts, Instagram Reels and the feed. */
  formats?: string[];
}

/** Which files to make for these platforms from this source. X is 16:9 for a wide picture and 1:1 for the rest. */
export function planPost(
  platforms: readonly PostPlatformId[],
  source: PostSourceShape,
  opts: PlanOptions = {},
): PostPlan {
  const targets: PostTarget[] = [];
  const skipped: PostPlan['skipped'] = [];
  const wide = source.width / source.height >= 1.3;
  for (const p of new Set(platforms)) {
    const all = POST_TARGETS.filter((t) => t.platform === p && t.media.includes(source.kind));
    if (!all.length) {
      skipped.push({ platform: p, why: `${platformName(p)} takes video here, not pictures.` });
      continue;
    }
    // Two formats of one platform when they differ in what they're for (Shorts, Reels); X is one or the other.
    let pick = all;
    if (p === 'x') pick = all.filter((t) => (t.aspect === '16:9') === wide);
    if (opts.formats?.length) {
      const chosen = pick.filter((t) => opts.formats!.includes(t.id));
      if (chosen.length) pick = chosen;
    } else if (source.kind === 'video') {
      // A default: YouTube makes the video unless Shorts is asked for by name; Instagram makes Reels.
      if (p === 'youtube') pick = pick.filter((t) => t.id === 'youtube');
      if (p === 'instagram') pick = pick.filter((t) => t.id === 'instagram-reels');
    } else if (p === 'instagram') {
      pick = pick.filter((t) => t.id === 'instagram-feed');
    }
    for (const t of pick) targets.push(p === 'youtube' && t.id === 'youtube' && opts.youtube4k ? uhd(t) : t);
  }
  return { targets, skipped };
}

function uhd(t: PostTarget): PostTarget {
  return {
    ...t,
    width: 3840,
    height: 2160,
    videoKbps: 40_000,
    safeArea: margin(3840, 2160),
  };
}

// ── The words ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Facts the person gave. Nothing here is invented; a field they left empty stays out of every caption. */
export interface PostFacts {
  title: string;
  /** A line or two about it, in their words. */
  about?: string;
  /** Their own tags, with or without the #. */
  tags?: string[];
  /** A link they want in the caption. */
  link?: string;
  /** Say that it is AI-generated (default true: the platforms ask for it, and the file says so too). */
  disclose?: boolean;
}

export interface PostText {
  /** The platform's separate title (YouTube, Reddit), else null. */
  title: string | null;
  /** The caption, or the description where there is a title. */
  caption: string;
  hashtags: string[];
  /** The caption's length as the platform counts it, and the most it takes. */
  length: number;
  limit: number;
  /** What was left out or cut to fit. */
  notes: string[];
}

export const DISCLOSURE = 'Made with AI (Hildegard).';
export const DISCLOSURE_TAG = 'AIGenerated';

const URL_LENGTH = 23;

/** Length as X counts it: a link is 23, and wide characters (CJK, most emoji) are 2. */
export function weightedLength(text: string): number {
  let n = 0;
  const rest = text.replace(/https?:\/\/\S+/gi, () => {
    n += URL_LENGTH;
    return '';
  });
  for (const ch of rest) {
    const c = ch.codePointAt(0)!;
    const narrow =
      c <= 0x10ff ||
      (c >= 0x2000 && c <= 0x200d) ||
      (c >= 0x2010 && c <= 0x201f) ||
      (c >= 0x2032 && c <= 0x2037);
    n += narrow ? 1 : 2;
  }
  return n;
}

export const lengthOf = (text: string, weighted?: boolean): number =>
  weighted ? weightedLength(text) : [...text].length;

/** `text` cut at a word to fit `max` (as the platform counts it), ending in an ellipsis. */
export function clip(text: string, max: number, weighted?: boolean): string {
  if (lengthOf(text, weighted) <= max) return text;
  const words = text.split(/(\s+)/);
  let out = '';
  for (const w of words) {
    if (lengthOf(`${out}${w}…`, weighted) > max) break;
    out += w;
  }
  out = out.trimEnd();
  if (!out) {
    // One long word: cut by characters.
    for (const ch of text) {
      if (lengthOf(`${out}${ch}…`, weighted) > max) break;
      out += ch;
    }
  }
  return `${out.replace(/[\s,;:.-]+$/, '')}…`;
}

/** A tag as the person's word, without the #, spaces or marks a platform would cut it at. */
export function cleanTag(raw: string): string {
  return raw.replace(/^#+/, '').replace(/[^\p{L}\p{N}_]+/gu, '');
}

function tagList(facts: PostFacts): string[] {
  const own = (facts.tags ?? []).map(cleanTag).filter(Boolean);
  if (facts.disclose !== false) own.push(DISCLOSURE_TAG);
  const seen = new Set<string>();
  return own.filter((t) => {
    const k = t.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * The title and caption for one target, from the person's facts, inside the platform's limits. What goes in, most
 * important first: the title, the AI note, the link, their description, their tags. Anything that does not fit is
 * left out or cut at a word, and `notes` says so.
 */
export function composeText(facts: PostFacts, target: PostTarget): PostText {
  const { titleMax, captionMax, hashtagsMax, weighted } = target.text;
  const notes: string[] = [];
  const name = target.label;
  const title = facts.title.trim();
  const about = facts.about?.trim() ?? '';
  const link = facts.link?.trim() ?? '';
  const disclose = facts.disclose !== false;

  let titleOut: string | null = null;
  if (titleMax != null) {
    titleOut = clip(title, titleMax);
    if (titleOut !== title) notes.push(`${name}: the title was cut to ${titleMax} characters.`);
  }

  // Parts are joined by blank lines in reading order (title, description, link, AI note) but win a place by
  // importance (title, AI note, link, description), so a short limit cuts the description first.
  const sep = '\n\n';
  const order = ['title', 'about', 'link', 'ai'] as const;
  type Key = (typeof order)[number];
  const kept = new Map<Key, string>();
  const render = (also?: [Key, string]) =>
    order
      .map((k) => (also && also[0] === k ? also[1] : kept.get(k)))
      .filter(Boolean)
      .join(sep);
  const place = (key: Key, text: string, what: string, cut = false) => {
    if (!text) return;
    if (lengthOf(render([key, text]), weighted) <= captionMax) {
      kept.set(key, text);
      return;
    }
    if (cut) {
      const base = render();
      const room = captionMax - (base ? lengthOf(base + sep, weighted) : 0);
      if (room >= 20) {
        kept.set(key, clip(text, room, weighted));
        notes.push(`${name}: your ${what} was cut to fit ${captionMax} characters.`);
        return;
      }
    }
    notes.push(`${name}: left out your ${what}, which doesn’t fit in ${captionMax} characters.`);
  };
  // A title goes in the caption too where the platform has no separate title field.
  if (titleMax == null) place('title', title, 'title', true);
  if (disclose) place('ai', DISCLOSURE, 'AI note');
  if (link) place('link', link, 'link');
  if (about) place('about', about, 'description', true);
  const parts = render() ? [render()] : [];
  const fits = (extra: string) => lengthOf([...parts, extra].join(sep), weighted) <= captionMax;

  const wanted = tagList(facts);
  const tags: string[] = [];
  if (hashtagsMax === 0) {
    if (wanted.length) notes.push(`${name} doesn’t use hashtags, so yours were left out.`);
  } else {
    for (const t of wanted) {
      if (tags.length >= hashtagsMax) {
        notes.push(`${name}: kept ${hashtagsMax} of your ${wanted.length} tags.`);
        break;
      }
      const line = [...tags, t].map((x) => `#${x}`).join(' ');
      if (!fits(line)) {
        notes.push(
          `${name}: kept ${tags.length} of your ${wanted.length} tags to fit ${captionMax} characters.`,
        );
        break;
      }
      tags.push(t);
    }
    if (tags.length) parts.push(tags.map((x) => `#${x}`).join(' '));
  }

  const caption = parts.join(sep);
  return {
    title: titleOut,
    caption,
    hashtags: tags,
    length: lengthOf(caption, weighted),
    limit: captionMax,
    notes,
  };
}

/** A name for files and folders from a title: letters and digits, dashes between, never empty. */
export function slug(title: string): string {
  const s = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return s || 'post';
}

// ── What the server keeps and the Studio and MCP read ───────────────────────────────────────────────────────────

/** What is being posted: a film Hildegard exported, one take, or an image. */
export interface PostSourceRef {
  kind: 'export' | 'take' | 'still';
  id: string;
}

/** One platform's file, its thumbnail and its words, as made. */
export interface PostFile {
  target: string;
  platform: PostPlatformId;
  label: string;
  kind: 'video' | 'image';
  status: 'queued' | 'running' | 'done' | 'failed';
  /** File names in the post's folder. */
  file: string | null;
  thumbnail: string | null;
  /** The .txt holding the title and caption, for pasting from. */
  words: string | null;
  text: PostText;
  width: number | null;
  height: number | null;
  seconds: number | null;
  bytes: number | null;
  /** Measured on the file: integrated loudness (LUFS) and true peak (dBTP); null for a picture or a silent film. */
  lufs: number | null;
  truePeak: number | null;
  /** The film was longer than the platform takes and was cut to `maxSeconds`. */
  trimmed: boolean;
  /** Where the on-screen text sits, [x0, y0, x1, y1] in the file's pixels; null when there is none. */
  textBox: [number, number, number, number] | null;
  /** What the person has done: ticked off once they posted it. */
  posted: boolean;
  error: string | null;
}

export interface PostState {
  id: string;
  source: PostSourceRef;
  /** The film this belongs to, when there is one. */
  projectId: string | null;
  title: string;
  status: 'running' | 'done' | 'failed';
  files: PostFile[];
  skipped: Array<{ platform: PostPlatformId; why: string }>;
  /** What was cut or left out, for the person to read. */
  notes: string[];
  error: string | null;
  createdAt: string;
  /** The "Ready to post" folder; only given to someone at this computer. */
  folder: string | null;
}

/** POST /api/post */
export interface PostRequest {
  source: PostSourceRef;
  platforms: PostPlatformId[];
  /** Exact target ids (`youtube-shorts`, `instagram-feed`), to choose a format other than the default. */
  formats?: string[];
  facts: Partial<PostFacts>;
  youtube4k?: boolean;
  /** `blur` (default) fits the whole picture over a soft backdrop; `crop` fills the frame. */
  fit?: 'blur' | 'crop';
  /** Words to show on the picture, kept inside each platform's safe area; none by default. */
  onScreenText?: string;
}
