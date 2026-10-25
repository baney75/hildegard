// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Loop tools: generate → render → critique → refine. The agent makes the thing (a 3D model from Blender, OpenSCAD or
 * code; an image, a video or a sound, rendered by Hildegard or anywhere), Hildegard checks it and draws what it looks
 * like, and the agent answers the rubric about what it sees before it may send the next round. Any MCP app can run
 * the loop: a coding agent with files, or a chatbot that sends the model itself as text or base64.
 */
import { readFile, stat } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { type HildegardClient, HildegardError, type LoopDetail, type LoopRound } from './client.ts';
import { PackError, zipFolder } from './zip.ts';

const text = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }] });
const fail = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }], isError: true });
const MAX_FILE = 512 * 1024 * 1024;

const mm = z.array(z.number().positive().max(10_000)).length(3);
const axis = z.enum(['+x', '-x', '+y', '-y', '+z', '-z']);
const fitKind = z.enum(['press', 'snug', 'slide', 'free']);

/** One round, as an agent should read it: what was measured, then what is left. */
function describeRound(l: Pick<LoopDetail, 'id' | 'maxRounds'>, r: LoopRound, link?: (p: string) => string) {
  const info = r.review.info;
  const facts = Object.entries(info)
    .filter(([k, v]) => k !== 'sheet' && k !== 'print_files' && v !== null)
    // Fits and likeness are lists of measurements; the checks' lines say what they found.
    .filter(([, v]) => typeof v !== 'object' || (Array.isArray(v) && v.every((x) => typeof x !== 'object')))
    .map(
      ([k, v]) =>
        `${k} ${Array.isArray(v) ? v.join(v.every((x) => typeof x === 'number') ? ' × ' : ', ') : String(v)}`,
    )
    .join(', ');
  return [
    `Loop ${l.id}, round ${r.n} of at most ${l.maxRounds} (${r.format}). ${facts}.`,
    r.review.summary,
    ...(link ? [`The file: ${link(r.file)}`] : []),
  ].join('\n');
}

export function registerLoopTools(
  server: McpServer,
  client: HildegardClient,
  agentName: () => string,
  remote?: { link: (path: string) => string },
) {
  const guard =
    <A>(fn: (a: A) => Promise<CallToolResult>) =>
    async (a: A): Promise<CallToolResult> => {
      try {
        return await fn(a);
      } catch (e) {
        return fail((e as Error).message);
      }
    };

  server.registerTool(
    'loop_start',
    {
      title: 'Start a loop',
      description:
        'Start a generate → render → critique → refine loop for a 3D model or printable part (kind "model"), a web page or site (kind "web"), an image, a video or a sound. Write the brief first: who it is for, what it is, and the specifics that make it this piece rather than the average one. Then make the first version (a model in Blender, OpenSCAD, build123d, trimesh or signed-distance code, exported as GLB, STL, OBJ or PLY; a page as HTML and CSS, or a folder or ZIP of the site) and send it with loop_submit. Each round comes back measured and drawn (eight views and silhouettes for a model; every page at phone, tablet and desktop width, light and dark, with problems outlined, for the web; a contact sheet for media); answer its questions with loop_critique, change one thing, and send the next round. Read the skill first (read_skill): hildegard-3d for a model, hildegard-print for a part to print, hildegard-web for a page.',
      inputSchema: {
        kind: z.enum(['model', 'web', 'image', 'video', 'audio']).describe('What the loop makes.'),
        title: z.string().min(1).max(120).describe('A short name, such as "Heron finial".'),
        for: z
          .string()
          .min(3)
          .max(400)
          .describe('Who it is for and where it goes: "a 3D print for my desk, 120 mm tall".'),
        what: z.string().min(3).max(1000).describe('What it is, in a sentence or two.'),
        specifics: z
          .array(z.string().min(2).max(300))
          .min(1)
          .max(8)
          .describe('Three or so specifics that make it this piece and not the generic one.'),
        constraints: z
          .string()
          .max(1000)
          .optional()
          .describe('Materials, printer, polygon budget, style rules.'),
        references: z.string().max(1000).optional().describe('Qualities to learn from (not names to copy).'),
        print: z
          .boolean()
          .optional()
          .describe(
            'Model: for a 3D printer, held to the print checks (millimetres, watertight, base, bed).',
          ),
        size_mm: mm.optional().describe('Model: the size asked for, in millimetres, [x, y, z] in any order.'),
        bed_mm: mm
          .optional()
          .describe('Model: the printer’s build volume in millimetres. Default 256 × 256 × 256.'),
        max_triangles: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Model: a triangle budget (a game asset, the web).'),
        up: z
          .enum(['y', 'z'])
          .optional()
          .describe(
            'Model: the up axis, if not the format’s usual one (y for GLB and glTF, z for STL and PLY; OBJ z when printing).',
          ),
        final: z.boolean().optional().describe('Image, video, sound: hold it to the final bar.'),
        seconds: z.number().positive().max(3600).optional().describe('Video, sound: the length asked for.'),
        audio: z.boolean().optional().describe('Video: whether it should have sound.'),
        pages: z
          .array(z.string().max(200))
          .min(1)
          .max(5)
          .optional()
          .describe(
            'Web: the pages to check, as paths inside the site, such as ["index.html", "pricing.html"]. Default index.html.',
          ),
        dark: z
          .boolean()
          .optional()
          .describe('Web: the brief asks for a dark theme that follows the visitor’s setting.'),
        fits: z
          .array(z.object({ a: z.string(), b: z.string(), kind: fitKind }))
          .max(40)
          .optional()
          .describe(
            'Print with parts: how named parts mate, such as [{"a": "lid", "b": "box", "kind": "slide"}]. Model the parts assembled, each named (a GLB node, or `o name` in OBJ); Hildegard measures the gap per side against this printer’s clearance for that fit, and fails parts that overlap.',
          ),
        views: z
          .array(
            z.object({
              name: z.string().describe('front, side, top…'),
              look: axis.describe(
                'The direction the camera looks, in the printed part’s frame (z up off the bed).',
              ),
              up: axis.describe('Up in the photo.'),
              outline: z
                .array(z.array(z.number()).length(2))
                .min(3)
                .describe('The object’s outline traced on the photo, in millimetres (u right, v up).'),
              tolerance_mm: z.number().positive().optional(),
            }),
          )
          .max(6)
          .optional()
          .describe(
            'Print from a photo: the object’s outline in each photographed view, scaled to millimetres (the hildegard-print skill’s print_kit.py measures them). Each round is held to it: shape, size and pose.',
          ),
        print_pose: z
          .record(z.string(), z.array(z.number()).length(3))
          .optional()
          .describe(
            'Print with parts: degrees about x, y and z from the assembled pose to the pose each part prints in, such as {"lid": [180, 0, 0]}.',
          ),
        evidence: z
          .object({
            dims: z
              .array(
                z.object({
                  name: z.string(),
                  mm: z.number().positive(),
                  source: z.enum(['measured', 'user', 'listing', 'assumed']),
                  tolerance_mm: z.number().min(0).optional(),
                  how: z.string().max(300).optional(),
                }),
              )
              .optional(),
            unknowns: z.array(z.string()).optional(),
            listing: z
              .object({
                title: z.string().optional(),
                url: z.string().optional(),
                price: z.number().min(0),
                currency: z.string().describe('USD, EUR…'),
              })
              .optional(),
          })
          .optional()
          .describe(
            'Print: where every dimension came from (measured off a photo, given by your user, quoted from a listing, or assumed and why), what no photo shows, and the listing of what it replaces. It goes on the print sheet, and the price is weighed against the print’s.',
          ),
        max_rounds: z
          .number()
          .int()
          .min(1)
          .max(12)
          .optional()
          .describe('Rounds at most. Default 6 for a model, 5 for a web page, 3 otherwise.'),
      },
    },
    guard(async (a) => {
      const l = await client.startLoop({
        kind: a.kind,
        title: a.title,
        agent: agentName(),
        maxRounds: a.max_rounds,
        brief: {
          for: a.for,
          what: a.what,
          specifics: a.specifics,
          constraints: a.constraints,
          references: a.references,
        },
        target: {
          print: a.print,
          sizeMm: a.size_mm,
          bedMm: a.bed_mm,
          maxTriangles: a.max_triangles,
          up: a.up,
          final: a.final,
          seconds: a.seconds,
          audio: a.audio,
          pages: a.pages,
          dark: a.dark,
          fits: a.fits,
          views: a.views?.map((v) => ({
            name: v.name,
            look: v.look,
            up: v.up,
            outline: v.outline,
            toleranceMm: v.tolerance_mm,
          })),
          printPose: a.print_pose,
          evidence: a.evidence && {
            ...a.evidence,
            dims: a.evidence.dims?.map(({ tolerance_mm, ...d }) => ({ ...d, toleranceMm: tolerance_mm })),
          },
        },
      });
      const how =
        a.kind === 'model'
          ? remote
            ? 'Send each round with loop_submit as text (OBJ, ASCII STL or glTF JSON) or data (base64 GLB, STL or PLY).'
            : 'Send each round with loop_submit: file_path to the GLB, STL, OBJ or PLY you exported, or text or data.'
          : a.kind === 'web'
            ? remote
              ? 'Send each round with loop_submit: text (one HTML page with its CSS inline) or data (base64 ZIP of the site, with its images and fonts).'
              : 'Send each round with loop_submit: file_path to the HTML page or to the site’s folder (or a ZIP of it), or text for one page.'
            : a.kind === 'video'
              ? 'Send each round with loop_submit: take_id for a take Hildegard rendered, or the file.'
              : a.kind === 'image'
                ? 'Send each round with loop_submit: still_id for a still Hildegard drew, or the file.'
                : 'Send each round with loop_submit: the file.';
      return text(
        `Loop ${l.id} started: “${l.title}”, ${l.kind}, at most ${l.maxRounds} rounds. ${how}\nAfter each round, look at what comes back and answer these with loop_critique:\n${l.questions}`,
      );
    }),
  );

  server.registerTool(
    'loop_submit',
    {
      title: 'Send a round',
      description: `Send the next version to a loop. Hildegard reads a model or media as data only (never runs it), measures it and draws it: for a model, eight views around it and one above (or below, for a print), with holes and flipped faces in magenta, and black silhouettes; for a web page, every page at phone, tablet and desktop width, light and dark, opened in a browser cut off from the network, with problems outlined in magenta; for media, a contact sheet. Look at the image that comes back before you critique it. Give exactly one of ${remote ? 'text, data, take_id or still_id' : 'file_path, text, data, take_id or still_id'}. The previous round must be critiqued first.`,
      inputSchema: {
        loop_id: z.string().describe('The loop, from loop_start or loop_status.'),
        note: z
          .string()
          .min(3)
          .max(1000)
          .describe('What you changed in this round, and why. For round 1, how you built it.'),
        ...(remote
          ? {}
          : {
              file_path: z
                .string()
                .optional()
                .describe(
                  'Absolute path to the file on this computer: GLB, glTF, STL, OBJ, PLY, HTML, ZIP, PNG, JPEG, WebP, MP4, WAV, FLAC, MP3 or OGG; or, for a web loop, the site’s folder.',
                ),
            }),
        text: z
          .string()
          .max(60_000_000)
          .optional()
          .describe(
            'The round as text: a model as OBJ, ASCII STL or glTF JSON with embedded buffers; a web page as one HTML document.',
          ),
        data: z
          .string()
          .max(140_000_000)
          .optional()
          .describe('The file itself, as base64 (up to 100 MB this way).'),
        take_id: z.string().optional().describe('Video loop: a finished take Hildegard rendered.'),
        still_id: z.string().optional().describe('Image loop: a still Hildegard drew.'),
      },
    },
    guard(
      async (a: {
        loop_id: string;
        note: string;
        file_path?: string;
        text?: string;
        data?: string;
        take_id?: string;
        still_id?: string;
      }) => {
        const given = [a.file_path, a.text, a.data, a.take_id, a.still_id].filter((x) => x !== undefined);
        if (given.length !== 1)
          throw new HildegardError(422, 'Give exactly one of file_path, text, data, take_id or still_id.');
        let bytes: Uint8Array | null = null;
        if (a.file_path) {
          if (remote)
            throw new HildegardError(
              422,
              'Hildegard runs on another computer, so it can’t read a path on yours. Send the file as text or data.',
            );
          const s = await stat(a.file_path).catch(() => null);
          if (s?.isDirectory()) {
            try {
              bytes = zipFolder(a.file_path);
            } catch (e) {
              throw new HildegardError(422, e instanceof PackError ? e.message : (e as Error).message);
            }
          } else {
            if (!s?.isFile()) throw new HildegardError(422, `There’s no file at ${a.file_path}.`);
            if (s.size > MAX_FILE) throw new HildegardError(413, 'Files up to 512 MB.');
            bytes = await readFile(a.file_path);
          }
        } else if (a.text !== undefined) bytes = new TextEncoder().encode(a.text);
        else if (a.data !== undefined) {
          bytes = Buffer.from(a.data.replace(/^data:[\w/+.-]+;base64,/, ''), 'base64');
          if (!bytes.length) throw new HildegardError(422, 'data isn’t base64.');
        } else if (a.take_id) {
          if (!/^\w+$/.test(a.take_id)) throw new HildegardError(422, 'That isn’t a take id.');
          bytes = await client.bytes(`/media/${a.take_id}.mp4`);
          if (!bytes) throw new HildegardError(404, `Take ${a.take_id} has no finished video.`);
        } else if (a.still_id) {
          if (!/^\w+$/.test(a.still_id)) throw new HildegardError(422, 'That isn’t a still id.');
          bytes = await client.bytes(`/media/stills/${a.still_id}.png`);
          if (!bytes) throw new HildegardError(404, `Still ${a.still_id} isn’t there.`);
        }
        const r = await client.submitRound(a.loop_id, bytes!, a.note);
        const l = await client.loop(a.loop_id);
        const sheet = r.round.sheet ? await client.image(r.round.sheet) : null;
        return {
          content: [
            { type: 'text', text: describeRound(l, r.round, remote?.link) },
            ...(sheet ? [{ type: 'image' as const, data: sheet.data, mimeType: sheet.mimeType }] : []),
            {
              type: 'text',
              text: `${sheet ? 'Look at the sheet above, view by view. Then a' : 'A'}nswer every question with loop_critique (round ${r.round.n}), each pointing at the view or check that shows it. Be the harshest honest critic of it you can: a yes you can't point at is a no.\n${r.questions}`,
            },
          ],
        };
      },
    ),
  );

  server.registerTool(
    'loop_critique',
    {
      title: 'Critique a round',
      description:
        'Answer the rubric about the latest round, one answer per question, each with the view, frame or check that shows it, and name the one thing the next round changes. The answer says what to do next: finish (every check and question passes), revise (with what to fix), or stop (no rounds left). Never answer yes to something you didn’t look at.',
      inputSchema: {
        loop_id: z.string(),
        round: z.number().int().positive(),
        answers: z
          .array(
            z.object({
              id: z.string().describe('The question’s id, such as silhouette.'),
              answer: z.enum(['yes', 'no']),
              evidence: z.string().min(3).max(600).describe('The view, frame, time or check that shows it.'),
            }),
          )
          .min(1),
        change: z
          .string()
          .min(3)
          .max(1000)
          .optional()
          .describe('The one thing the next round changes. Needed unless every answer is yes.'),
      },
    },
    guard(async (a) => {
      const r = await client.critique(a.loop_id, a.round, { answers: a.answers, change: a.change });
      return text(r.next);
    }),
  );

  server.registerTool(
    'loop_finish',
    {
      title: 'Finish a loop',
      description:
        'Deliver a round: the loop closes with that round chosen, and your note, which tells your user plainly what it is and what still fails. Only a critiqued round can be delivered.',
      inputSchema: {
        loop_id: z.string(),
        round: z
          .number()
          .int()
          .positive()
          .describe('The round to deliver: usually the best, not always the last.'),
        note: z
          .string()
          .min(3)
          .max(2000)
          .describe('What it is, how it got there, and what still fails, honestly.'),
      },
    },
    guard(async (a) => {
      const l = await client.finishLoop(a.loop_id, a.round, a.note);
      const r = l.rounds.find((x) => x.n === a.round)!;
      const link = (p: string) => (remote ? remote.link(p) : `${client.url}${p}`);
      const extra = [
        r.handoff
          ? `The print sheet to hand on (time, filament, cost, fits, every dimension and its source): ${link(r.handoff)}`
          : null,
        r.slice?.gcode
          ? `The sliced G-code (${r.slice.slicer}): ${link(r.slice.gcode)}. Check it in the slicer’s preview before printing.`
          : null,
      ].filter(Boolean);
      return text(
        [
          `Loop ${l.id} finished with round ${r.n} (${r.format}): ${link(r.file)}`,
          ...extra,
          'Tell your user what you made and what still fails, as your note says.',
        ].join('\n'),
      );
    }),
  );

  server.registerTool(
    'loop_status',
    {
      title: 'Loops',
      description:
        'With loop_id: that loop’s brief, every round with its checks and critique, and its questions. Without: the recent loops.',
      inputSchema: { loop_id: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    guard(async (a) => {
      if (!a.loop_id) {
        const { loops } = await client.loops();
        if (!loops.length) return text('No loops yet. Start one with loop_start.');
        return text(
          loops
            .slice(0, 20)
            .map(
              (l) =>
                `${l.id} “${l.title}” ${l.kind}, ${l.status}, ${l.rounds} of ${l.maxRounds} rounds${l.chosen ? `, delivered round ${l.chosen}` : ''}`,
            )
            .join('\n'),
        );
      }
      const l = await client.loop(a.loop_id);
      return text(
        [
          `Loop ${l.id} “${l.title}”, ${l.kind}, ${l.status}${l.chosen ? `, delivered round ${l.chosen}` : ''}.`,
          `Brief: ${JSON.stringify(l.brief)}`,
          ...l.rounds.map(
            (r) =>
              `Round ${r.n}: ${r.review.passed ? 'checks pass' : 'checks fail'}; ${r.critique ? `critiqued, ${r.critique.verdict}${r.critique.change ? `: next change “${r.critique.change}”` : ''}` : 'not critiqued yet'}. Note: ${r.note}`,
          ),
          ...(l.note ? [`Closing note: ${l.note}`] : []),
          `Questions:\n${l.questions}`,
        ].join('\n'),
      );
    }),
  );

  server.registerTool(
    'printer_profile',
    {
      title: 'Your 3D printer',
      description:
        'Read or change the owner’s 3D printer as Hildegard knows it: build volume, nozzle, layer height, filament and its price, and the clearance per side each fit needs (press, snug, slide, free; the defaults until it’s calibrated with the fit coupon). Print loops check against it and slice with the slicer on this computer. Read it before modeling anything that fits together, and size every mating feature from its clearances. Change it only with what your user tells you or measured.',
      inputSchema: {
        name: z.string().max(80).optional().describe('Such as "Prusa MK4" or "Bambu X1C".'),
        bed_mm: mm.optional().describe('Build volume, x y z in millimetres.'),
        nozzle_mm: z.number().min(0.1).max(2).optional(),
        layer_mm: z.number().min(0.04).max(1).optional(),
        material: z.string().max(20).optional().describe('PLA, PETG, ABS, ASA, TPU…'),
        price_per_kg: z.number().min(0).optional().describe('What a kilogram of filament costs.'),
        currency: z.string().optional().describe('USD, EUR, GBP…'),
        clearance_mm: z
          .object({
            press: z.number().min(0).max(1).optional(),
            snug: z.number().min(0).max(1).optional(),
            slide: z.number().min(0).max(1).optional(),
            free: z.number().min(0).max(1).optional(),
          })
          .optional()
          .describe('Measured clearances per side, from the fit coupon your user printed and tried.'),
      },
    },
    guard(async (a) => {
      const change = {
        name: a.name,
        bedMm: a.bed_mm,
        nozzleMm: a.nozzle_mm,
        layerMm: a.layer_mm,
        material: a.material,
        pricePerKg: a.price_per_kg,
        currency: a.currency?.toUpperCase(),
        clearanceMm: a.clearance_mm,
      };
      const any = Object.values(change).some((v) => v !== undefined);
      const p = any
        ? await client.setPrinter(
            Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined)),
          )
        : await client.printer();
      const c = p.clearanceMm;
      return text(
        [
          `${p.name}: ${p.bedMm.join(' × ')} mm bed, ${p.nozzleMm} mm nozzle, ${p.layerMm} mm layers, ${p.material} at ${p.pricePerKg} ${p.currency} a kilogram.`,
          `Clearance per side: press ${c.press}, snug ${c.snug}, slide ${c.slide}, free ${c.free} mm (${p.calibrated.length ? `${p.calibrated.join(', ')} calibrated ${p.calibratedAt}` : 'the usual starting points; print the fit coupon to calibrate (hildegard-print skill)'}).`,
          p.slicerFound
            ? p.slicerFound.ready
              ? `Slices with ${p.slicerFound.name} on this computer.`
              : `${p.slicerFound.name} is here but needs this printer’s profiles; your user sets them in Hildegard on that computer.`
            : 'No slicer on this computer: install PrusaSlicer (free) for print time, grams and cost on every round.',
        ].join('\n'),
      );
    }),
  );
}
