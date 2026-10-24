// SPDX-License-Identifier: AGPL-3.0-only

import { describeRubric, type Lint, lintPrompt } from '@hildegard/craft';
import type {
  Catalog,
  Character,
  CharacterView,
  ShotRequestInput,
  Snapshot,
  Still,
  Take,
} from '@hildegard/presets';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { type HildegardClient, HildegardError, type ShotDetail } from './client.ts';
import { registerVoiceTools } from './voice-tools.ts';

const DONE: Take['status'][] = ['done', 'failed', 'canceled'];

/** Everything an agent can set on a shot. Every field but the prompt has a sensible default. */
const shotShape = {
  prompt: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      'What happens in the shot, literally and in order: who, what they do, where. The camera, lens and look are added for you from the other fields, so leave them out of the prompt.',
    ),
  camera_body: z
    .string()
    .optional()
    .describe('Camera body id from list_presets, e.g. vintage-16mm. Sets grain and colour.'),
  lens: z.string().optional().describe('Lens id from list_presets, e.g. anamorphic.'),
  focal_mm: z
    .number()
    .int()
    .optional()
    .describe('Focal length in mm, one of those in list_presets. Default 35.'),
  aperture: z
    .number()
    .min(1)
    .max(22)
    .optional()
    .describe('f-number. Low (1.4) blurs the background; high (16) keeps everything sharp. Default 2.8.'),
  motion: z
    .array(z.string())
    .max(2)
    .optional()
    .describe(
      'Up to two camera move ids from list_presets, e.g. ["dolly-in"]. Leave empty for a locked-off camera.',
    ),
  motion_strength: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('How strong the camera moves are, 0 to 1. Default 0.8.'),
  lighting: z.string().optional().describe('Lighting id from list_presets.'),
  palette: z.string().optional().describe('Colour palette id from list_presets.'),
  genre: z.string().optional().describe('Genre id from list_presets.'),
  era: z.string().optional().describe('Era id from list_presets.'),
  aspect: z.string().optional().describe('Frame aspect ratio, e.g. 16:9, 2.39:1, 9:16. Default 16:9.'),
  seconds: z
    .number()
    .positive()
    .max(20)
    .optional()
    .describe('Length in seconds; capped at the model maximum. Default 5.'),
  quality: z
    .enum(['draft', 'final'])
    .optional()
    .describe(
      'draft renders fast at a lower size so you can choose; final renders at full quality. Default draft.',
    ),
  model: z
    .string()
    .optional()
    .describe('Video model id from list_presets. Default: the first installed one.'),
  seed: z
    .number()
    .int()
    .min(0)
    .max(4294967295)
    .optional()
    .describe('Fix the seed to re-render the same take with other settings.'),
  takes: z
    .number()
    .int()
    .min(1)
    .max(4)
    .optional()
    .describe('How many takes to render, each with its own seed. Default 1.'),
  start_frame_path: z
    .string()
    .optional()
    .describe(
      'Absolute path to a PNG, JPEG or WebP on the computer Hildegard runs on. The video starts from this image.',
    ),
  start_frame_data: z
    .string()
    .max(28_000_000)
    .optional()
    .describe(
      'The start frame itself, as base64 PNG, JPEG or WebP data (up to 20 MB), when the image isn’t on the computer Hildegard runs on. Use this or start_frame_path, not both.',
    ),
  title: z
    .string()
    .max(120)
    .optional()
    .describe('A short title for the shot. Default: the first words of the prompt.'),
  characters: z
    .array(z.string())
    .max(3)
    .optional()
    .describe(
      'Up to 3 characters in the shot, by id or name from list_characters. Hildegard draws the first frame from their reference images, so faces and clothes stay the same from shot to shot. Name them in the prompt too. Not with a start frame.',
    ),
};
const ShotArgs = z.object(shotShape);
type ShotArgs = z.infer<typeof ShotArgs>;

/** Lint findings to append to a result, as advice for the next shot; empty when there are none. */
const lintNote = (r: Lint): string =>
  r.findings.length
    ? `\n\nAbout the prompt (review_prompt explains): ${r.findings.map((f) => `${f.id}${f.match ? ` (${f.match.slice(0, 4).join(', ')})` : ''}`).join('; ')}. ${r.ok ? '' : 'These usually make a take look generated; fix them before the final render.'}`.trimEnd()
    : '';

const text = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }] });
const fail = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }], isError: true });

/** Explain a bad id with the ids that would work, so a small model can correct itself in one step. */
function pick<T extends { id: string }>(list: T[], id: string | undefined, what: string, fallback?: T): T {
  if (id === undefined) return fallback ?? list[0]!;
  const found = list.find((x) => x.id === id);
  if (!found)
    throw new HildegardError(
      422,
      `Unknown ${what} "${id}". Use one of: ${list.map((x) => x.id).join(', ')}.`,
    );
  return found;
}

export function toRequest(a: ShotArgs, catalog: Catalog, installed: Set<string>): ShotRequestInput {
  const body = pick(catalog.bodies, a.camera_body, 'camera_body');
  const lens = pick(catalog.lenses, a.lens, 'lens');
  const focal = a.focal_mm ?? 35;
  if (!catalog.focals.some((f) => f.mm === focal))
    throw new HildegardError(
      422,
      `Unknown focal_mm ${focal}. Use one of: ${catalog.focals.map((f) => f.mm).join(', ')}.`,
    );
  for (const m of a.motion ?? []) pick(catalog.motions, m, 'motion');
  if (a.lighting) pick(catalog.lightings, a.lighting, 'lighting');
  if (a.palette) pick(catalog.palettes, a.palette, 'palette');
  if (a.genre) pick(catalog.genres, a.genre, 'genre');
  if (a.era) pick(catalog.eras, a.era, 'era');
  if (a.aspect) pick(catalog.aspects, a.aspect, 'aspect');
  const videos = videoModels(catalog);
  const model = a.model
    ? pick(videos, a.model, 'model')
    : (videos.find((m) => installed.has(m.id)) ?? videos[0]!);
  return {
    prompt: a.prompt,
    rig: { body: body.id, lens: lens.id, focal, aperture: a.aperture ?? 2.8 },
    motion: (a.motion ?? []).map((id) => ({ id, strength: a.motion_strength ?? 0.8 })),
    look: { lighting: a.lighting, palette: a.palette, genre: a.genre, era: a.era },
    format: { aspect: a.aspect ?? '16:9', seconds: a.seconds ?? 5, quality: a.quality ?? 'draft' },
    model: model.id,
    seed: a.seed,
    takes: a.takes ?? 1,
  };
}

function describeTake(t: Take, video: string | undefined): string {
  const head = `- ${t.id} take ${t.number} (${t.quality}, ${t.width}×${t.height}, ${t.seconds}s, seed ${t.seed}): `;
  switch (t.status) {
    case 'queued':
      return `${head}waiting, ${t.queuePosition ? `number ${t.queuePosition} in line` : 'up next'}`;
    case 'running':
      return `${head}rendering, ${Math.round((t.progress?.value ?? 0) * 100)}%`;
    case 'done':
      return `${head}done. Video: ${video ?? t.video}`;
    case 'failed':
      return `${head}failed: ${t.error?.message ?? 'unknown error'}${t.error?.hint ? ` ${t.error.hint}` : ''}`;
    default:
      return `${head}canceled`;
  }
}

const filmOf = (f: { id: string; title: string }) => `film ${f.id} "${f.title}"`;

/** Models that make shots; the stills model draws characters. */
const videoModels = (c: Catalog) => c.models.filter((m) => m.kind !== 'image');

/** Whether a character can be drawn now, and why not. */
function drawable(c: Character): string | null {
  if (c.likeness === 'real' && c.consent?.status !== 'active')
    return c.consent?.status === 'revoked'
      ? 'their consent was taken back'
      : 'they are a real person who hasn’t consented yet; only they can, on the link their maker sends them';
  if (!c.references.length) return 'no reference images yet; make_character_stills, then keep_still';
  return null;
}

function describeCharacter(c: Character): string {
  const why = drawable(c);
  const views = [...new Set(c.references.map((r) => r.view ?? 'other'))].join(', ');
  return `- ${c.id} "${c.name}"${c.likeness === 'real' ? ' (real person)' : ''}: ${c.description || 'no description'}${c.wardrobe ? `; wears ${c.wardrobe}` : ''}. ${c.references.length} reference${c.references.length === 1 ? '' : 's'}${views ? ` (${views})` : ''}${c.voice ? `, voice ${c.voice}` : ''}. ${why ? `Can’t be cast: ${why}.` : 'Ready to cast.'}`;
}

function describeStill(s: Still): string {
  const head = `- ${s.id} ${s.view} (seed ${s.seed}): `;
  if (s.status === 'done') return `${head}done${s.kept ? ', kept as a reference' : ''}`;
  if (s.status === 'failed') return `${head}failed: ${s.error?.message ?? 'unknown error'}`;
  if (s.status === 'running') return `${head}drawing, ${Math.round((s.progress?.value ?? 0) * 100)}%`;
  return `${head}${s.status === 'queued' ? 'waiting' : s.status}`;
}

/** Where a finished take's video is: its path on this computer, or a link for an app on another device. */
type VideoOf = (d: ShotDetail, t: Take) => string | undefined;

function describeShot(d: ShotDetail, videoOf: VideoOf): string {
  return [
    `Shot ${d.shot.id} "${d.shot.title}" in ${filmOf(d.project)}`,
    ...d.takes.map((t) => describeTake(t, videoOf(d, t))),
  ].join('\n');
}

/** One line per take, the ones still going first, so an agent can find what to follow or cancel. */
function recentTakes(s: Snapshot, limit: number): string[] {
  if (limit === 0) return [];
  const active = (t: Take) => (t.status === 'queued' || t.status === 'running' ? 0 : 1);
  const takes = [...s.takes]
    .sort((a, b) => active(a) - active(b) || b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
  if (!takes.length) return ['No takes yet.'];
  return [
    'Recent takes (waiting and rendering first, then newest):',
    ...takes.map((t) => {
      const shot = s.shots.find((x) => x.id === t.shotId);
      const film = s.projects.find((x) => x.id === t.projectId);
      const state =
        t.status === 'queued'
          ? `waiting${t.queuePosition ? `, number ${t.queuePosition} in line` : ''}`
          : t.status === 'running'
            ? `rendering, ${Math.round((t.progress?.value ?? 0) * 100)}%`
            : t.status;
      return `- ${t.id}: ${state}. Take ${t.number} of shot ${t.shotId} "${shot?.title ?? '?'}" in ${filmOf({ id: t.projectId, title: film?.title ?? '?' })}`;
    }),
  ];
}

export function registerTools(
  server: McpServer,
  client: HildegardClient,
  agentName: () => string,
  remote?: { link: (path: string) => string },
) {
  const videoOf: VideoOf = (d, t) =>
    remote ? (t.video ? remote.link(t.video) : undefined) : (d.files[t.id] ?? t.video ?? undefined);
  const describe = (d: ShotDetail) => describeShot(d, videoOf);
  const guard =
    <A>(fn: (a: A, extra: Extra) => Promise<CallToolResult>) =>
    async (a: A, extra: Extra): Promise<CallToolResult> => {
      try {
        return await fn(a, extra);
      } catch (e) {
        return fail((e as Error).message);
      }
    };

  /** Poll until every take is finished or time runs out, reporting progress to clients that ask for it. */
  const waitFor = async (shotIds: string[], seconds: number, extra: Extra): Promise<ShotDetail[]> => {
    const until = Date.now() + seconds * 1000;
    for (;;) {
      const details = await Promise.all(shotIds.map((id) => client.shot(id)));
      const takes = details.flatMap((d) => d.takes);
      const done = takes.filter((t) => DONE.includes(t.status)).length;
      const token = extra._meta?.progressToken;
      if (token !== undefined) {
        const partial = takes.reduce(
          (n, t) => n + (DONE.includes(t.status) ? 1 : (t.progress?.value ?? 0)),
          0,
        );
        await extra
          .sendNotification({
            method: 'notifications/progress',
            params: {
              progressToken: token,
              progress: partial,
              total: takes.length,
              message: `${done} of ${takes.length} takes finished`,
            },
          })
          .catch(() => {});
      }
      if (done === takes.length || Date.now() >= until || extra.signal.aborted) return details;
      await new Promise((r) => setTimeout(r, 1000));
    }
  };

  /** A film by id; else the newest film with exactly this title; else a new film with this title. */
  const filmFor = async (film: string | undefined): Promise<string | undefined> => {
    const name = film?.trim();
    if (!name) return undefined;
    const { projects } = await client.snapshot();
    const found =
      projects.find((p) => p.id === name) ??
      projects.filter((p) => p.title === name).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    return (found ?? (await client.createProject(name))).id;
  };

  const createShot = async (a: ShotArgs, projectId?: string) => {
    const [catalog, snap] = await Promise.all([client.catalog(), client.snapshot()]);
    const videos = new Set(videoModels(catalog).map((m) => m.id));
    const installed = new Set(
      snap.models.filter((m) => m.installed && m.fitWhy !== 'apple-gpu' && videos.has(m.id)).map((m) => m.id),
    );
    const characters = snap.characters ?? [];
    if (!a.model && !installed.size && snap.models.some((m) => m.fitWhy === 'apple-gpu'))
      throw new Error(
        'No video model renders on this Mac yet. Pair a device with an NVIDIA or AMD GPU (`hildegard choir join`) and render there.',
      );
    const request = toRequest(a, catalog, installed);
    if (a.start_frame_path && a.start_frame_data)
      throw new HildegardError(422, 'Give start_frame_path or start_frame_data, not both.');
    if (a.start_frame_path && remote)
      throw new HildegardError(
        422,
        'Hildegard runs on another computer, so it can’t read a path on yours. Send the image itself as start_frame_data (base64).',
      );
    if (a.characters?.length) {
      if (a.start_frame_path || a.start_frame_data)
        throw new HildegardError(
          422,
          'Give characters or a start frame, not both: the characters draw the start frame.',
        );
      request.characters = a.characters.map((who) => {
        const c =
          characters.find((x) => x.id === who) ??
          characters.find((x) => x.name.toLowerCase() === who.trim().toLowerCase());
        if (!c)
          throw new HildegardError(
            422,
            `No character "${who}". ${characters.length ? `Use one of: ${characters.map((x) => `${x.id} (${x.name})`).join(', ')}.` : 'Make one with create_character.'}`,
          );
        const why = drawable(c);
        if (why) throw new HildegardError(422, `${c.name} can’t be cast: ${why}.`);
        return c.id;
      });
    }
    if (a.start_frame_path) request.startFrame = await client.upload(a.start_frame_path);
    if (a.start_frame_data) {
      const bytes = Buffer.from(a.start_frame_data.replace(/^data:image\/[a-z]+;base64,/, ''), 'base64');
      if (!bytes.length) throw new HildegardError(422, 'start_frame_data isn’t base64 image data.');
      request.startFrame = await client.uploadBytes(bytes);
    }
    return client.createShot({ request, projectId, title: a.title, agent: agentName() });
  };

  server.registerTool(
    'hildegard_status',
    {
      title: 'Hildegard status',
      description:
        'Check that Hildegard is running, which video models are installed, whether a Hugging Face account is linked, and what is in the render queue. Lists recent takes with their ids, status, shot and film, so you can follow one or cancel it with cancel_take. Call this first.',
      inputSchema: {
        recent_takes: z
          .number()
          .int()
          .min(0)
          .max(50)
          .optional()
          .describe('How many recent takes to list. Default 10; 0 for none.'),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async (a) => {
      const s = await client.snapshot();
      const catalog = await client.catalog();
      const queued = s.takes.filter((t) => t.status === 'queued').length;
      const running = s.takes.find((t) => t.status === 'running');
      const lines = [
        `Hildegard ${s.version} at ${client.url}. Renders on ${s.engine.comfy === 'remote' ? `${s.engine.device}, another of the owner’s devices${s.engine.fake ? ' (stand-in GPU, test mode)' : ''}` : s.engine.fake ? 'a stand-in GPU (test mode)' : s.engine.device}; ComfyUI ${s.engine.online ? 'is online' : 'is not answering'}${s.engine.paused ? ', rendering is paused' : ''}.`,
        `Queue: ${running ? `rendering ${running.id}, ` : ''}${queued} waiting.`,
        `Hugging Face: ${s.hf.linked ? `linked${s.hf.user ? ` as ${s.hf.user}` : ''}` : 'not linked (needed only for gated models)'}.`,
        'Models:',
        ...catalog.models.map((m) => {
          const st = s.models.find((x) => x.id === m.id);
          const state = st?.installed
            ? 'installed'
            : st?.downloading
              ? `downloading ${Math.round((st.downloading.done / Math.max(1, st.downloading.total)) * 100)}%`
              : `not installed (${(m.files.reduce((n, f) => n + f.size, 0) / 1e9).toFixed(0)} GB${m.gated ? ', needs a linked Hugging Face account' : ''})`;
          return `- ${m.id}: ${m.name}${m.kind === 'image' ? ' (stills, for characters)' : ''}, ${m.license}, ${m.minVramGb} GB GPU, ${state}${st?.error ? `. Last error: ${st.error}` : ''}`;
        }),
        ...recentTakes(s, a.recent_takes ?? 10),
      ];
      return text(lines.join('\n'));
    }),
  );

  server.registerTool(
    'list_presets',
    {
      title: 'List presets',
      description:
        'The camera bodies, lenses, focal lengths, camera moves, lighting, palettes, genres, eras, aspect ratios and models you can use in direct_shot, with their ids.',
      annotations: { readOnlyHint: true },
    },
    (extra) =>
      guard(async () => {
        const c = await client.catalog();
        const list = (name: string, xs: Array<{ id: string; name: string; blurb?: string }>) =>
          `${name}:\n${xs.map((x) => `- ${x.id}: ${x.name}${x.blurb ? `, ${x.blurb}` : ''}`).join('\n')}`;
        return text(
          [
            list('camera_body', c.bodies),
            list('lens', c.lenses),
            `focal_mm: ${c.focals.map((f) => `${f.mm} (${f.label})`).join(', ')}`,
            list('motion', c.motions),
            list('lighting', c.lightings),
            list('palette', c.palettes),
            list('genre', c.genres),
            list('era', c.eras),
            `aspect: ${c.aspects.map((a) => a.id).join(', ')}`,
            list(
              'model',
              videoModels(c).map((m) => ({
                ...m,
                blurb: `${m.blurb} Up to ${m.maxSeconds}s${m.audio ? ', with sound' : ''}.`,
              })),
            ),
            list(
              'stills model (draws characters; install it with install_model to use characters)',
              c.models.filter((m) => m.kind === 'image'),
            ),
          ].join('\n\n'),
        );
      })(undefined, extra),
  );

  server.registerTool(
    'direct_shot',
    {
      title: 'Direct a shot',
      description:
        'Render a video shot on the GPU of the computer Hildegard runs on. Describe the action; choose the camera, lens, move and look by id (see list_presets). Returns the shot id at once; set wait to get the finished videos in the same call. Rendering costs nothing and nothing leaves the computer.',
      inputSchema: {
        ...shotShape,
        film: z
          .string()
          .max(120)
          .optional()
          .describe(
            'The film to put the shot in: a film id from an earlier result, or a film title such as "Agent Cut". A title reuses the film with exactly that title, or makes a new film with that title if there is none. Leave it out for a new untitled film.',
          ),
        wait: z
          .boolean()
          .optional()
          .describe('Wait for the takes to finish (up to 10 minutes) and return the videos. Default false.'),
      },
    },
    guard(async (a, extra) => {
      const { project, shot, takes } = await createShot(a, await filmFor(a.film));
      const advice = lintNote(lintPrompt(a.prompt, 'video'));
      if (!a.wait)
        return text(
          `Directed shot ${shot.id} "${shot.title}" in ${filmOf(project)}: ${takes.length} take${takes.length > 1 ? 's' : ''} queued (${takes.map((t) => t.id).join(', ')}). Check it with shot_status or get_shot; stop a take with cancel_take.${advice}`,
        );
      const [detail] = await waitFor([shot.id], 600, extra);
      const r = await withPosters(detail!);
      if (advice) r.content.push({ type: 'text', text: advice.trim() });
      return r;
    }),
  );

  server.registerTool(
    'shot_status',
    {
      title: 'Shot status',
      description:
        'Where each take of a shot is: waiting, rendering with progress, done with its video, or failed and why, with the film the shot is in.',
      inputSchema: { shot_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    guard(async (a) => text(describe(await client.shot(a.shot_id)))),
  );

  const withPosters = async (d: ShotDetail): Promise<CallToolResult> => {
    const images = await Promise.all(d.takes.filter((t) => t.status === 'done').map((t) => client.poster(t)));
    return {
      content: [
        { type: 'text', text: describe(d) },
        ...images
          .filter((i) => i !== null)
          .map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mimeType })),
      ],
    };
  };

  server.registerTool(
    'cancel_take',
    {
      title: 'Cancel a take',
      description:
        'Stop a take that is waiting or rendering, as Cancel in the Studio does: it frees the GPU and keeps the shot, so the take can be retried later. Take ids are in the results of direct_shot, shot_status and hildegard_status. A finished take cannot be canceled.',
      inputSchema: {
        take_id: z.string().describe('The take id, e.g. from hildegard_status.'),
        reason: z
          .string()
          .max(200)
          .optional()
          .describe('Why, in a few words, to repeat to your user. Not stored.'),
      },
      annotations: { destructiveHint: true },
    },
    guard(async (a) => {
      try {
        const t = await client.cancelTake(a.take_id);
        const d = await client.shot(t.shotId);
        return text(
          `Canceled take ${t.id} (take ${t.number} of shot ${d.shot.id} "${d.shot.title}" in ${filmOf(d.project)})${a.reason ? `: ${a.reason}` : ''}.`,
        );
      } catch (e) {
        if (e instanceof HildegardError && e.status === 404)
          throw new HildegardError(
            404,
            `No take ${a.take_id}. hildegard_status lists recent takes with their ids.`,
          );
        if (e instanceof HildegardError && e.status === 409) {
          const t = (await client.snapshot()).takes.find((x) => x.id === a.take_id);
          throw new HildegardError(
            409,
            `Take ${a.take_id} has already finished${t ? ` (${t.status})` : ''}, so there is nothing to cancel.`,
          );
        }
        throw e;
      }
    }),
  );

  server.registerTool(
    'get_shot',
    {
      title: 'Get a shot',
      description: remote
        ? 'The finished videos of a shot, as links that open for a day without signing in, with a still from each. Optionally waits for takes still rendering.'
        : 'The finished videos of a shot, as paths on the computer Hildegard runs on, with a still from each. Optionally waits for takes still rendering.',
      inputSchema: {
        shot_id: z.string(),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(600)
          .optional()
          .describe('Wait up to this long for unfinished takes. Default 0.'),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async (a, extra) => {
      const [d] = await waitFor([a.shot_id], a.wait_seconds ?? 0, extra);
      return withPosters(d!);
    }),
  );

  server.registerTool(
    'make_sequence',
    {
      title: 'Make a sequence',
      description:
        'Direct several shots, in order, as one film. Each shot takes the same fields as direct_shot. Returns the film and shot ids; set wait to get the finished videos.',
      inputSchema: {
        title: z.string().min(1).max(120).describe('The film title.'),
        shots: z.array(ShotArgs).min(1).max(24),
        wait: z
          .boolean()
          .optional()
          .describe('Wait for every take to finish (up to 30 minutes). Default false.'),
      },
    },
    guard(async (a, extra) => {
      const film = await client.createProject(a.title);
      const shots = [];
      for (const s of a.shots) shots.push((await createShot(s, film.id)).shot);
      if (!a.wait)
        return text(
          `Film ${film.id} "${film.title}": ${shots.length} shots queued in order (${shots.map((s) => s.id).join(', ')}).`,
        );
      const details = await waitFor(
        shots.map((s) => s.id),
        1800,
        extra,
      );
      return text([`Film ${film.id} "${film.title}"`, ...details.map(describe)].join('\n\n'));
    }),
  );

  server.registerTool(
    'export_film',
    {
      title: 'Export a film',
      description: remote
        ? "Join a film's shots, in order, into one MP4. Each shot uses its kept take, or its newest finished one. Returns a link to the file, good for a day, when it's done."
        : "Join a film's shots, in order, into one MP4 on the computer Hildegard runs on. Each shot uses its kept take, or its newest finished one. Returns the file's path when it's done.",
      inputSchema: {
        film_id: z.string().describe('The film id, from direct_shot or make_sequence.'),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(900)
          .optional()
          .describe('Wait up to this long for the file. Default 300.'),
      },
    },
    guard(async (a) => {
      // A second call while it runs follows the export already going.
      let e = await client.exportFilm(a.film_id).catch(async (err) => {
        const going = (await client.snapshot()).exports.find(
          (x) => x.projectId === a.film_id && x.status === 'running',
        );
        if (going) return going;
        throw err;
      });
      const end = Date.now() + (a.wait_seconds ?? 300) * 1000;
      let full = await client.exportState(e.id);
      while (full.status === 'running' && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 1000));
        full = await client.exportState(e.id);
      }
      e = full;
      if (full.status === 'done')
        return text(
          remote && e.url
            ? `Exported "${e.title}": ${e.total} shots, ${e.seconds ?? '?'} s. Download it (the link works for a day): ${remote.link(e.url)}`
            : `Exported "${e.title}": ${e.total} shots, ${e.seconds ?? '?'} s, at ${full.file}. In the browser: ${client.url}${e.url}`,
        );
      if (full.status === 'failed') return { ...text(`The export failed: ${e.error}`), isError: true };
      return text(
        `Still exporting (${e.done} of ${e.total} takes joined). Export ${e.id}; call export_film again later.`,
      );
    }),
  );

  server.registerTool(
    'review_prompt',
    {
      title: 'Review a prompt before rendering',
      description:
        'Check a prompt for the habits that make generated work look generated (quality words like "8k" or "masterpiece", tag lists, camera words that belong in the camera fields, negations, too many actions for one shot) before spending GPU time on it. Returns each problem with what to write instead. Costs nothing; call it before direct_shot or make_sequence.',
      inputSchema: {
        prompt: z.string().min(1).max(4000),
        medium: z
          .enum(['video', 'image', 'music', 'voice', 'words'])
          .optional()
          .describe(
            'What the prompt is for: video (default), image, music, voice, or words (titles, captions, lyrics, narration).',
          ),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async (a) => {
      const r = lintPrompt(a.prompt, a.medium ?? 'video');
      if (!r.findings.length) return text('No problems found. Render a draft, then review_take it.');
      return text(
        [
          r.ok ? 'Only judgment calls; render if each is on purpose:' : 'Fix these before rendering:',
          ...r.findings.map(
            (f) =>
              `- ${f.severity === 'fail' ? 'FIX' : 'consider'} ${f.id}${f.match ? ` (${f.match.join(', ')})` : ''}: ${f.detail} ${f.fix}`,
          ),
        ].join('\n'),
      );
    }),
  );

  server.registerTool(
    'review_take',
    {
      title: 'Review a finished take',
      description:
        "The quality gate for a finished take: technical checks (exposure, frozen or flickering frames, pushed colour, clipped or badly levelled sound, size and length against the shot) and a contact sheet of nine frames to look at, with the yes/no questions to answer about it. Use it on every take before you choose one or show it to your user; don't describe a take you haven't reviewed.",
      inputSchema: {
        take_id: z.string().describe('A finished take’s id, from direct_shot, get_shot or hildegard_status.'),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async (a) => {
      let r: Awaited<ReturnType<typeof client.review>>;
      try {
        r = await client.review(a.take_id);
      } catch (e) {
        if (e instanceof HildegardError && e.status === 409)
          throw new HildegardError(
            409,
            `Take ${a.take_id} hasn't finished yet. Wait with get_shot, then review it.`,
          );
        throw e;
      }
      const sheet = r.sheet ? await client.image(r.sheet) : null;
      return {
        content: [
          { type: 'text', text: `Take ${r.take}. ${r.summary}` },
          ...(sheet ? [{ type: 'image' as const, data: sheet.data, mimeType: sheet.mimeType }] : []),
          {
            type: 'text',
            text: `${sheet ? 'Look at the contact sheet above (nine frames, start to end), then a' : 'A'}nswer these about the take.\n${describeRubric('video')}`,
          },
        ],
      };
    }),
  );

  server.registerTool(
    'install_model',
    {
      title: 'Install a video model',
      description:
        "Download a video model from Hugging Face to the computer Hildegard runs on. The first call returns the model's license terms. Show them to your user word for word and ask whether they accept; call again with accept_license true only if they say yes. Downloads continue in the background; follow them with hildegard_status.",
      inputSchema: {
        model: z.string().describe('Model id from list_presets.'),
        accept_license: z
          .boolean()
          .optional()
          .describe(
            'True only after your user has read the license terms and said they accept them. Never decide this yourself.',
          ),
      },
      annotations: { openWorldHint: true },
    },
    guard(async (a) => {
      try {
        await client.installModel(a.model, a.accept_license === true);
        return text(`Installing ${a.model}. Follow the download with hildegard_status.`);
      } catch (e) {
        if (e instanceof HildegardError && e.body.code === 'license') {
          const terms = (e.body.terms as string[]).map((t) => `- ${t}`).join('\n');
          return text(
            `${a.model} comes under the ${String(e.body.license)} (${String(e.body.licenseUrl)}). Your user becomes its licensee. In short:\n${terms}\n\nShow this to your user and ask whether they accept. If they do, call install_model again with accept_license: true.`,
          );
        }
        if (e instanceof HildegardError && e.body.code === 'hf')
          return text(
            `${a.model} downloads from Hugging Face, which needs your user's own account; you can't link it for them. Ask them to run \`hildegard hf login\` in a terminal on the computer Hildegard runs on (or use Settings › Hugging Face in the Studio), then call install_model again.`,
          );
        throw e;
      }
    }),
  );

  registerVoiceTools(server, client, agentName, remote);

  // ── Characters ─────────────────────────────────────────────────────────────────────────────────────────────────
  /** Stills drawn, with each finished one as an image, after waiting up to `seconds` for them. */
  const stillsResult = async (ids: string[], seconds: number, extra: Extra, head: string) => {
    const until = Date.now() + seconds * 1000;
    let stills: Still[] = [];
    for (;;) {
      const snap = await client.snapshot();
      stills = ids.map((id) => snap.stills.find((s) => s.id === id)).filter((s) => s !== undefined);
      const done = stills.every((s) => DONE.includes(s.status));
      if (done || Date.now() >= until || extra.signal.aborted) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const images = await Promise.all(
      stills.map((s) => (s.status === 'done' && s.image ? client.image(s.image) : Promise.resolve(null))),
    );
    const content: CallToolResult['content'] = [
      { type: 'text', text: [head, ...stills.map(describeStill)].join('\n') },
    ];
    stills.forEach((s, i) => {
      const img = images[i];
      if (!img) return;
      content.push({ type: 'text', text: `Still ${s.id} (${s.view}):` });
      content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
    });
    const pending = stills.filter((s) => !DONE.includes(s.status)).length;
    content.push({
      type: 'text',
      text: pending
        ? `${pending} still${pending === 1 ? ' is' : 's are'} still drawing; call make_character_stills with wait_seconds and no view later, or look in the Studio.`
        : 'Look at each still. Keep the one that best matches the description with keep_still: the first portrait you keep becomes their face, and every later still and cast shot starts from it.',
    });
    return { content };
  };
  const characterFor = async (who: string) => {
    const { characters = [] } = await client.snapshot();
    const c =
      characters.find((x) => x.id === who) ??
      characters.find((x) => x.name.toLowerCase() === who.trim().toLowerCase());
    if (!c)
      throw new HildegardError(
        404,
        `No character "${who}". ${characters.length ? `Use one of: ${characters.map((x) => `${x.id} (${x.name})`).join(', ')}.` : 'Make one with create_character.'}`,
      );
    return c;
  };

  server.registerTool(
    'list_characters',
    {
      title: 'List characters',
      description:
        'The characters your user has made: reusable people with reference images, so the same face and clothes appear in every shot they are cast in (the characters field of direct_shot). Says which can be cast now and why not.',
      annotations: { readOnlyHint: true },
    },
    (extra) =>
      guard(async () => {
        const { characters = [] } = await client.snapshot();
        if (!characters.length) return text('No characters yet. Make one with create_character.');
        return text(['Characters:', ...characters.map(describeCharacter)].join('\n'));
      })(undefined, extra),
  );

  server.registerTool(
    'create_character',
    {
      title: 'Create a character',
      description:
        'Make an invented character and draw portraits of them to pick a face from, on the computer Hildegard runs on. Then keep the best portrait with keep_still, draw the other angles with make_character_stills (view "sheet"), and cast them in shots. Only invented people: a character of a real person needs that person’s own consent, which they give themselves in the Studio; you can’t give it for them. Never describe anyone sexually: Hildegard refuses it.',
      inputSchema: {
        name: z.string().min(1).max(60).describe('What to call them, e.g. Mara.'),
        description: z
          .string()
          .max(600)
          .optional()
          .describe(
            'How they look, concretely: age, build, face, hair, skin, marks. E.g. "Early thirties, auburn side braid, light freckles, gray-green eyes".',
          ),
        wardrobe: z
          .string()
          .max(300)
          .optional()
          .describe('What they wear in every shot, e.g. "an undyed linen shirt and a canvas apron".'),
        portraits: z
          .number()
          .int()
          .min(0)
          .max(4)
          .optional()
          .describe('Portraits to draw to pick a face from. Default 4; 0 for none.'),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(600)
          .optional()
          .describe('Wait up to this long for the portraits and return them. Default 0.'),
      },
    },
    guard(async (a, extra) => {
      const c = await client.createCharacter({
        name: a.name,
        description: a.description,
        wardrobe: a.wardrobe,
      });
      const n = a.portraits ?? 4;
      if (!n) return text(`Made character ${c.id} "${c.name}". Draw portraits with make_character_stills.`);
      const { stills } = await client.makeStills(c.id, { view: 'portrait', count: n, agent: agentName() });
      return stillsResult(
        stills.map((s) => s.id),
        a.wait_seconds ?? 0,
        extra,
        `Made character ${c.id} "${c.name}" and queued ${n} portrait${n === 1 ? '' : 's'}:`,
      );
    }),
  );

  const SHEET: CharacterView[] = ['three-quarter', 'profile', 'full-body'];
  server.registerTool(
    'make_character_stills',
    {
      title: 'Draw a character',
      description:
        'Draw stills of a character from their reference images: more portraits to choose from, other angles, or "sheet" for three-quarter, profile and full body at once, so later shots can read the face and outfit from every side. Keep the good ones with keep_still. With no view, reports on the stills already drawn.',
      inputSchema: {
        character: z.string().describe('Character id or name, from list_characters.'),
        view: z
          .enum(['portrait', 'three-quarter', 'profile', 'full-body', 'sheet'])
          .optional()
          .describe('What to draw. "sheet" draws the three angles a character sheet needs.'),
        count: z
          .number()
          .int()
          .min(1)
          .max(4)
          .optional()
          .describe('Stills of each view, each with its own seed. Default 1.'),
        note: z
          .string()
          .max(300)
          .optional()
          .describe('Extra words for these stills only: an expression, a mood. Not a new outfit.'),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(600)
          .optional()
          .describe('Wait up to this long and return the stills. Default 0.'),
      },
    },
    guard(async (a, extra) => {
      const c = await characterFor(a.character);
      if (!a.view) {
        const { stills = [] } = await client.snapshot();
        const ours = stills.filter((s) => s.characterId === c.id && !s.kept);
        if (!ours.length) return text(`${c.name} has no stills waiting to be kept.`);
        return stillsResult(
          ours.map((s) => s.id),
          a.wait_seconds ?? 0,
          extra,
          `Stills of ${c.name} not yet kept:`,
        );
      }
      const views = a.view === 'sheet' ? SHEET : [a.view];
      const ids: string[] = [];
      for (const view of views) {
        const { stills } = await client.makeStills(c.id, {
          view,
          count: a.count ?? 1,
          note: a.note,
          agent: agentName(),
        });
        ids.push(...stills.map((s) => s.id));
      }
      return stillsResult(
        ids,
        a.wait_seconds ?? 0,
        extra,
        `Queued ${ids.length} still${ids.length === 1 ? '' : 's'} of ${c.name}:`,
      );
    }),
  );

  server.registerTool(
    'keep_still',
    {
      title: 'Keep a still',
      description:
        'Keep a finished still as one of its character’s reference images. The first portrait kept becomes their face. Keep only stills that match the description and each other; a reference that looks like someone else makes every later shot drift.',
      inputSchema: { still_id: z.string().describe('A finished still’s id.') },
    },
    guard(async (a) => {
      const c = await client.keepStill(a.still_id);
      return text(`Kept. ${describeCharacter(c).slice(2)}`);
    }),
  );
}

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;
