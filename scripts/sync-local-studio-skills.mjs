// SPDX-License-Identifier: AGPL-3.0-only
// Builds the craft skills in Hildegard's Local Studio plugin (local-studio/hildegard/skills/) from skills/, so the
// plugin's copy is never edited by hand:
//
//   node scripts/sync-local-studio-skills.mjs           write the plugin's copy of every skill in CRAFT, and its icon
//   node scripts/sync-local-studio-skills.mjs --check   change nothing; exit 1 when the plugin's copy differs from what
//                                                       the sync would write, or holds a file or skill it wouldn't
//
// Each skill in CRAFT is copied whole, then changed only by the EDITS and FIRST below, the plugin's only differences
// from skills/. Every edit must match its source exactly once: when skills/ changes under one, the sync and the check
// both stop and name it, so a Local Studio change can never silently fall away. apps/cli/test/local-studio-skills.test.ts
// holds all of this in place.
//
// The six media skills in OWN (/image, /video, /speak, /design-voice, /clean-audio, /hildegard) are written for the
// plugin itself and stay by hand. Any other folder in the plugin's skills/ is a problem for the check.
//
// No link is followed or written through, and Python caches and .DS_Store files are never copied. Text is compared and
// written with LF line endings, so a Windows checkout that changed them is not drift.
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** The plugin's folder, from the repository root. */
export const PLUGIN = 'local-studio/hildegard';

/** The craft skills the plugin ships, copied from skills/. */
export const CRAFT = [
  'hildegard',
  'hildegard-3d',
  'hildegard-art',
  'hildegard-blog',
  'hildegard-craft',
  'hildegard-design',
  'hildegard-film',
  'hildegard-game',
  'hildegard-loop',
  'hildegard-motion',
  'hildegard-music',
  'hildegard-photo-edit',
  'hildegard-setup',
  'hildegard-sound',
  'hildegard-video-edit',
  'hildegard-web',
];

/** The media skills written for the plugin by hand. The sync never touches them. */
export const OWN = [
  'hildegard-clean',
  'hildegard-image',
  'hildegard-media',
  'hildegard-speech',
  'hildegard-video',
  'hildegard-voice',
];

/** Skills in skills/ the plugin leaves out, and why. */
export const LEFT_OUT = {
  'hildegard-cloud':
    'it rents Runpod GPUs, which cost money, and its text asks the person’s yes for the model license, never for the spend',
  'hildegard-print': 'printing belongs to the Gantrel plugin in Local Studio',
  'hildegard-openscad': 'printable parts belong to the Gantrel plugin in Local Studio',
};

/** Files the plugin carries from elsewhere in the repository, byte for byte. */
export const FILES = [
  // The 256 px render of the design system's flat disc (node scripts/app-icons.mjs), for Local Studio's consent sheet.
  { from: 'apps/desktop/src-tauri/icons/128x128@2x.png', to: 'icon.png' },
];

// ---------------------------------------------------------------------------------------------------------------------
// The Local Studio changes. Everything the plugin's copy says that skills/ doesn't is here.
// ---------------------------------------------------------------------------------------------------------------------

/** Gantrel's commands for printing. Gantrel owns slicing, printer checks and printing in Local Studio. */
export const GANTREL_COMMANDS = ['/plan', '/print'];

const gantrel = `${GANTREL_COMMANDS.join(' and ')}`;

/** What every printing handoff says in Local Studio. */
export const GANTREL = `In Local Studio, printing belongs to the Gantrel plugin: when it is installed, use its ${gantrel} commands (Gantrel owns slicing, printer checks and printing). Without Gantrel, hand the person the mesh file (STL or 3MF) and stop there.`;

/**
 * What a skill without an In Local Studio block says about `<folder>`. A Local Studio plugin folder is never written
 * to: Local Studio binds the person's consent to the folder's hash and turns a changed plugin's tools off.
 */
const WHERE_INLINE =
  '`<folder>` is the folder on the "References are relative to" line above: run its scripts as `python3 -B <folder>/scripts/<name>.py` and never write into it, since a changed plugin has its tools turned off.';

/** A script run relative to the skill folder, made a run from the working folder that writes nothing into the plugin. */
const fromWorkingFolder = (text) =>
  text
    .replaceAll('python3 scripts/', 'python3 -B <folder>/scripts/')
    .replaceAll('python3 <skill>/', 'python3 -B <skill>/');

/** Edits to the copied text: each `find` must occur exactly once in `file` (from skills/). */
export const EDITS = [
  {
    file: 'hildegard/SKILL.md',
    why: 'printing goes to Gantrel; hildegard-print is not in the plugin',
    find: '| A 3D model, or a part to print | **hildegard-3d**, **hildegard-print** |',
    replace: `| A 3D model, or a part to print | **hildegard-3d**; to print it, Gantrel's ${gantrel} when the Gantrel plugin is installed, else hand over the mesh |`,
  },
  {
    file: 'hildegard-3d/SKILL.md',
    why: 'hildegard-openscad is not in the plugin; OpenSCAD itself still is a route',
    find: 'OpenSCAD (the **hildegard-openscad** skill; with Hildegard linked, send the `.scad` itself and it renders it)',
    replace: 'OpenSCAD (with Hildegard linked, send the `.scad` itself and it renders it)',
  },
  {
    file: 'hildegard-3d/SKILL.md',
    why: 'printing goes to Gantrel; hildegard-print is not in the plugin',
    find: '  A part that has to work (a replacement, a bracket, a clip, anything measured off a photo or a listing) follows\n  **hildegard-print**: evidence for every dimension, fits measured, every round sliced, a print sheet at the end.\n',
    replace: `  A part that has to work (a replacement, a bracket, a clip, anything measured off a photo or a listing) needs\n  evidence for every dimension and its fits measured.\n- **Slicing and printing:** ${GANTREL}\n`,
  },
  {
    file: 'hildegard-loop/SKILL.md',
    why: 'printing goes to Gantrel; hildegard-print is not in the plugin',
    find: '**hildegard-3d**; for a part to\nprint, **hildegard-print**; for a website',
    replace: `**hildegard-3d**; for a part to\nprint, **hildegard-3d**, then Gantrel's ${gantrel} when the Gantrel plugin is installed; for a website`,
  },
  {
    file: 'hildegard-blog/SKILL.md',
    why: 'a draft saved in the skill folder would change the plugin and turn its tools off',
    find: "run `python3 scripts/prose_lint.py draft.md` from this\n   skill's folder",
    replace:
      'run `python3 -B <folder>/scripts/prose_lint.py draft.md`\n   from your working folder (`<folder>` is the folder on the "References are relative to" line above; never write\n   into it)',
  },
  {
    file: 'hildegard-film/SKILL.md',
    why: 'spec.json and the sheet written in the skill folder would change the plugin and turn its tools off',
    find: "Without Hildegard, from this skill's folder\n   (install",
    replace:
      'Without Hildegard, from your working folder,\n   where spec.json and the sheet go, never `<folder>` (install',
  },
  {
    file: 'hildegard-art/SKILL.md',
    why: 'spec.json and the sheet written in the skill folder would change the plugin and turn its tools off',
    find: 'Without Hildegard, run `echo',
    replace: 'Without Hildegard, from your working folder (never `<folder>`), run `echo',
  },
  {
    file: 'hildegard-craft/SKILL.md',
    why: 'spec.json and the sheet written in the skill folder would change the plugin and turn its tools off',
    find: 'Without Hildegard, write a spec and run the bundled checker.',
    replace: `Without Hildegard, write the spec in your working folder and run the bundled checker from there. ${WHERE_INLINE}`,
  },
  {
    file: 'hildegard-loop/SKILL.md',
    why: 'spec.json and the sheet written in the skill folder would change the plugin and turn its tools off',
    find: 'Write `spec.json` and run the checker for the kind.',
    replace:
      'Write `spec.json` in your working folder and run the checker for the kind from there, never in `<folder>`.',
  },
  {
    file: 'hildegard-3d/SKILL.md',
    why: 'spec.json and the sheet written in the skill folder would change the plugin and turn its tools off',
    find: 'Without Hildegard, write a spec and run the checker:',
    replace: 'Without Hildegard, write a spec in your working folder and run the checker from there:',
  },
  {
    file: 'hildegard-3d/SKILL.md',
    why: 'a model reading "from this skill\'s folder" works inside the plugin',
    find: "`scripts/mesh_kit.py` (read it from this skill's folder; with",
    replace: '`<folder>/scripts/mesh_kit.py` (read it there; with',
  },
  {
    file: 'hildegard-3d/SKILL.md',
    why: 'a model reading the kit by a path relative to the skill folder finds nothing outside the plugin',
    find: '`scripts/blender_kit.py` (with Hildegard linked and no files, `read_skill hildegard-3d scripts/blender_kit.py`) is a\nbpy kit:',
    replace:
      '`<folder>/scripts/blender_kit.py` (copy it from there; with Hildegard linked and no files, `read_skill hildegard-3d\nscripts/blender_kit.py`) is a\nbpy kit:',
  },
  {
    file: 'hildegard-music/SKILL.md',
    why: 'scripts run from the skill folder write their output into the plugin',
    find: "Run the scripts from this skill's `scripts/` folder, or with their full path.",
    replace:
      'Run the scripts from your working folder with their full path, `python3 -B <folder>/scripts/<name>.py`.',
  },
  {
    file: 'hildegard-music/SKILL.md',
    why: 'run from the working folder, a relative copy finds nothing; from the skill folder it writes into the plugin',
    find: '(`cp presets/coin.json mycoin.json`)',
    replace: '(`cp <folder>/presets/coin.json mycoin.json`)',
  },
  {
    file: 'hildegard-motion/templates/README.md',
    why: 'a render run from the skill folder writes its video into the plugin',
    find: "(`python3 scripts/motion.py templates/title-card.json out.mp4` from the skill's folder)",
    replace:
      '(`python3 -B <folder>/scripts/motion.py <folder>/templates/title-card.json out.mp4` from your working folder)',
  },
  {
    file: 'hildegard-photo-edit/SKILL.md',
    why: 'spec.json and the sheet written in the skill folder would change the plugin and turn its tools off',
    find: "without it, from this skill's\nfolder (install",
    replace:
      'without it, from your working folder,\nwhere spec.json and the sheet go, never `<folder>` (install',
  },
  {
    file: 'hildegard/SKILL.md',
    why: 'the router has no In Local Studio block to say what `<folder>` is',
    find: 'otherwise `python3 scripts/prose_lint.py draft.md`.',
    replace: `otherwise \`python3 -B <folder>/scripts/prose_lint.py draft.md\` from your working folder. ${WHERE_INLINE}`,
  },
  {
    file: 'hildegard/references/blog.md',
    why: 'the router has no In Local Studio block to say what `<folder>` is',
    find: 'With Hildegard connected, call `lint_writing`. Without it:',
    replace:
      'With Hildegard connected, call `lint_writing`. Without it, from your working folder (`<folder>` is the hildegard\nskill\'s folder, on its "References are relative to" line; never write into it):',
  },
  {
    file: 'hildegard-3d/SKILL.md',
    why: 'importing mesh_kit without -B writes __pycache__ into the plugin and turns its tools off',
    find: "model can be made and sent from any Python, including a chatbot's.\n",
    replace:
      'model can be made and sent from any Python, including a chatbot\'s. To use it here, write your build script in your\nworking folder, put `import sys; sys.path.insert(0, "<folder>/scripts")` before `from mesh_kit import *`, and run\nit as `python3 -B build.py`: without `-B`, Python writes `__pycache__` into the plugin, and Local Studio turns\nHildegard\'s tools off.\n',
  },
  {
    file: 'hildegard-3d/scripts/mesh_kit.py',
    why: 'importing mesh_kit without -B writes __pycache__ into the plugin and turns its tools off',
    find: '\n    from mesh_kit import *\n',
    replace:
      "\n    # In your working folder, with this file's folder on sys.path. Run it with `python3 -B`, which writes no\n    # __pycache__ here: a changed Local Studio plugin has its tools turned off.\n    from mesh_kit import *\n",
  },
  {
    file: 'hildegard-motion/references/going-further.md',
    why: 'importing motion without -B writes __pycache__ into the plugin and turns its tools off',
    find: 'import sys; sys.path.insert(0, "path/to/hildegard-motion/scripts")  # this skill\'s scripts folder\nimport motion\n',
    replace:
      '# Save this in your working folder and run it with `python3 -B yours.py`: without -B, Python writes\n# __pycache__ into <folder>, the plugin, and Local Studio turns Hildegard\'s tools off.\nimport sys; sys.path.insert(0, "<folder>/scripts")  # this skill\'s scripts folder\nimport motion\n',
  },
  // Every other run of a script by a path relative to the skill folder, which only works from inside the plugin: each
  // `find` is the exact source text, and every `python3 scripts/` in it becomes `python3 -B <folder>/scripts/`.
  ...Object.entries({
    'hildegard/references/blog.md': ['python3 scripts/prose_lint.py'],
    'hildegard-3d/SKILL.md': [
      'python3 scripts/review_mesh.py',
      '`python3 scripts/check_game_asset.py model.glb`',
      'python3 scripts/check_game_asset.py model.glb --max-triangles',
    ],
    'hildegard-art/SKILL.md': [
      'python3 scripts/review_media.py',
      'python3 scripts/contact_sheet.py',
      '`python3 scripts/check_design.py --iso iso.json --pre-render`',
      '`python3 scripts/check_design.py --iso iso.json`',
      '`python3 scripts/check_design.py --ink-anim ink.json --pre-render`',
      '`python3 scripts/check_design.py --ink-anim ink.json`',
    ],
    'hildegard-craft/SKILL.md': ['python3 scripts/review_media.py', 'python3 scripts/contact_sheet.py'],
    'hildegard-design/SKILL.md': [
      'python3 scripts/check_design.py --html design.html',
      'python3 scripts/check_design.py --design-md design.md',
      'python3 scripts/check_design.py --logo logo.svg',
    ],
    'hildegard-film/SKILL.md': [
      'python3 scripts/review_media.py',
      'python3 scripts/contact_sheet.py',
      'python3 scripts/check_sync.py --camera spec.json',
      'python3 scripts/check_sync.py --video film.mp4',
    ],
    'hildegard-game/SKILL.md': [
      '`python3 scripts/check_game.py spec.json`',
      '   python3 scripts/check_game.py spec.json',
    ],
    'hildegard-loop/SKILL.md': [
      'python3 scripts/review_mesh.py',
      'python3 scripts/review_media.py',
      'python3 scripts/contact_sheet.py',
    ],
    'hildegard-motion/SKILL.md': [
      'python3 scripts/motion.py --fonts',
      'python3 scripts/check_sync.py --camera camera.json',
      'python3 scripts/check_sync.py --video out.mp4',
      'verify the JSON contract with `python3 scripts/check_sync.py --camera spec.json`',
      'verify the brief with `python3 scripts/check_sync.py --camera spec.json`',
      'python3 <skill>/scripts/motion.py work/promo.json --check',
      'python3 <skill>/scripts/motion.py work/promo.json work/promo.mp4',
    ],
    'hildegard-motion/references/going-further.md': ['python3 scripts/check_sync.py --video out.mp4'],
    'hildegard-motion/references/spec.md': [
      'python3 scripts/motion.py spec.json --check  ',
      'python3 scripts/motion.py spec.json out.mp4  ',
      'python3 scripts/motion.py spec.json out.mp4 --preview',
      'python3 scripts/motion.py spec.json --preview',
      'python3 scripts/motion.py spec.json out.mp4 --scale',
      'python3 scripts/motion.py spec.json out.mp4 --hashes',
      'python3 scripts/motion.py spec.json --check --json',
      'python3 scripts/motion.py --fonts',
    ],
    'hildegard-music/SKILL.md': [
      'python3 scripts/sheet.py',
      'python3 scripts/sfx.py --list',
      'python3 scripts/music.py --list',
      'python3 scripts/music.py mine.json --check',
      'python3 scripts/music.py mine.json out.wav',
      'python3 scripts/sfx.py --preset',
      'python3 scripts/music.py --template',
      'python3 scripts/soundscape.py --list',
      'python3 scripts/soundscape.py ocean_beach',
    ],
    'hildegard-music/references/recipes.md': ['python3 scripts/sfx.py'],
    'hildegard-music/references/scores.md': ['python3 scripts/music.py'],
    'hildegard-music/references/soundscapes.md': [
      'Run `python3 scripts/soundscape.py recipe.json --check',
      'python3 scripts/soundscape.py recipe.json out.wav',
      'python3 scripts/soundscape.py recipe.json --check ',
      'python3 scripts/soundscape.py --preset',
    ],
    'hildegard-photo-edit/SKILL.md': [
      'python3 scripts/fix.py',
      'python3 scripts/measure.py out.jpg',
      'python3 scripts/contact_sheet.py compare.png photo.jpg',
      'python3 scripts/straighten.py',
      'python3 scripts/color.py',
      'python3 scripts/denoise_sharpen.py',
      'python3 scripts/crop.py',
      'python3 scripts/measure.py final.jpg',
      'python3 scripts/measure.py in.jpg',
      'python3 scripts/review_media.py',
      'python3 scripts/contact_sheet.py compare.png in.jpg',
    ],
    'hildegard-sound/SKILL.md': [
      'python3 scripts/clean_voice.py',
      'python3 scripts/duck_mix.py',
      'python3 scripts/spot.py',
      '`python3 scripts/spatial_mix.py spec.json out.wav`',
      'python3 scripts/spatial_mix.py spec.json out.wav --json',
      'python3 scripts/spatial_mix.py --check out.wav --spec spec.json',
      'python3 scripts/measure.py out.wav',
      'python3 scripts/measure.py final.wav',
    ],
    'hildegard-video-edit/SKILL.md': [
      'python3 scripts/clean_voice.py',
      'python3 scripts/duck_mix.py',
      'python3 scripts/spot.py',
      'python3 scripts/cut_reel.py',
      'python3 scripts/check_video.py out.mp4',
      'python3 scripts/contact_sheet.py sheet.png --video out.mp4',
      'python3 scripts/contact_sheet.py sheet.png --video <file>',
      'python3 scripts/review_media.py',
      'python3 scripts/contact_sheet.py input-sheet.png',
      'python3 scripts/check_video.py final.mp4',
      'python3 scripts/check_sync.py --video final.mp4',
    ],
    'hildegard-web/SKILL.md': [
      'python3 scripts/check_design.py --html site/',
      'python3 scripts/check_design.py --web-lint site/ --fidelity',
      '`python3 scripts/check_design.py --sakuga control.json --pre-render`',
      '`python3 scripts/check_design.py --sakuga control.json`',
    ],
  }).flatMap(([file, finds]) =>
    finds.map((find) => ({
      file,
      why: 'a script run by a path relative to the skill folder only works from inside the plugin',
      find,
      replace: fromWorkingFolder(find),
    })),
  ),
  {
    file: 'hildegard-setup/SKILL.md',
    why: 'hildegard-cloud is not in the plugin: rented GPUs cost money',
    find: '- **Rented GPUs** (Runpod, Hugging Face, Colab): the **hildegard-cloud** skill.',
    replace:
      '- **Rented GPUs** (Runpod, Hugging Face, Colab): not part of the Local Studio plugin, since a rented GPU costs\n  money. Your user sets one up themselves, in a terminal outside Local Studio. You never run `hildegard cloud`.',
  },
];

const tools =
  "Hildegard's tools (`hildegard_status`, `loop_start` and the rest) are here once the person allows the Hildegard plugin in Local Studio's Settings, Plugins. If you don't have them, use this skill's way without Hildegard.";
const folder =
  '`<folder>` is the folder on the "References are relative to" line above. Run its scripts as `python3 -B <folder>/scripts/<name>.py`, and a script of yours that imports from `<folder>/scripts` as `python3 -B yours.py`: `-B` keeps Python from writing into the plugin, which would turn Hildegard\'s tools off until the person allows them again.';

/**
 * The "In Local Studio" block each commanded skill opens with, right under its title: what a small model runs first.
 * Keys are skill folders; the plugin's command for each is in plugin.toml.
 */
export const FIRST = {
  'hildegard-film': [
    'First call the `hildegard_status` tool to see which video models are installed. If you have no Hildegard tools, render each shot with bash, one at a time: `hildegard make video "<the shot\'s prompt>" --move <camera move> --quality draft` (moves such as `dolly-in`, `pull-back-reveal`, `follow`). It waits, saves the clip and reviews it. If the person asked only for a plan, do the Fast path below and render nothing.',
    folder,
    tools,
  ],
  'hildegard-art': [
    'First call the `hildegard_status` tool, then `list_presets` (section 1). If you have no Hildegard tools, write the art direction (section 2), then draw each prompt with bash the way the /image command does: `hildegard make image "<prompt>"`. It waits, saves the file and reviews it.',
    folder,
    tools,
  ],
  'hildegard-sound': [
    'First pick the Fast path item that fits and run its script. For a voice recording: `python3 -B <folder>/scripts/clean_voice.py <recording> out.wav --lufs -16 --peak -1.5`. Then run `python3 -B <folder>/scripts/measure.py out.wav --lufs -16 --peak -1` and read every line before you hand it over.',
    folder,
  ],
  'hildegard-photo-edit': [
    'First run `python3 -B <folder>/scripts/fix.py <photo> out.jpg` with the flags the Fast path picks from the brief, then `python3 -B <folder>/scripts/measure.py out.jpg <photo>` and read each line. Never overwrite the original.',
    folder,
  ],
  'hildegard-video-edit': [
    "First pick the path. A short film from long recordings (a screen, several cameras, an interview) is section 8: save its programs in your working folder, never `<folder>`. Anything else: run `python3 -B <folder>/scripts/cut_reel.py` as in the Fast path's step 4, with the person's clips, then `python3 -B <folder>/scripts/check_video.py out.mp4` with the brief's numbers. Every line must say OK.",
    folder,
  ],
  'hildegard-3d': [
    'First write the brief (section 1), then call the `loop_start` tool with `kind` model (and `print` and `size_mm` for a print). If you have no Hildegard tools, build in one script and check each round with `python3 -B <folder>/scripts/review_mesh.py spec.json` (section 3).',
    GANTREL,
    folder,
    tools,
  ],
  'hildegard-web': [
    'First call the `site_templates` tool, pick the template that fits, and start a site with `site_new`. If you have no Hildegard tools, copy a template folder from `<folder>/templates/` into a new `site/` folder in the working folder and work there, never in `<folder>`.',
    folder,
    tools,
  ],
  'hildegard-loop': [
    'First call the `loop_start` tool with the brief and the `kind` (model, web, image, video or audio). If you have no Hildegard tools, follow "The loop by hand" below.',
    folder,
    tools,
  ],
  'hildegard-design': [
    "First write the copy deck (the Fast path's step 1). Render with a browser already on this computer: `chromium --headless=new --hide-scrollbars --window-size=1080,1350 --screenshot=design.png design.html` (or `google-chrome` with the same flags, at the canvas size). `npx playwright` downloads a browser, so ask the person first; without a browser, hand over the HTML, say it is unrendered and unchecked, and stop.",
    folder,
  ],
  'hildegard-music': [
    'First pick the closest recipe: `python3 -B <folder>/scripts/sfx.py --list` for a sound effect, `music.py --list` for music, `soundscape.py --list` for a long bed. Copy it into your working folder (`cp <folder>/templates/lofi.json mine.json`) and change the copy, never the file in `<folder>`. Run every script from your working folder.',
    folder,
  ],
  'hildegard-motion': [
    'First pick the closest template in `<folder>/templates/` (the table below), copy it into your working folder (`cp <folder>/templates/promo.json promo.json`), change the copy, and run `python3 -B <folder>/scripts/motion.py promo.json --check` until it prints `result: clean`. Where this skill says `<skill>`, that is `<folder>`. If numpy or Pillow is missing, or neither ffmpeg nor PyAV is there, give the person the install line below and install nothing yourself.',
    folder,
  ],
  'hildegard-game': [
    'First write `spec.json` in your working folder for the subsystems in the brief and run `python3 -B <folder>/scripts/check_game.py spec.json` until every line prints OK. Use local assets only, then inspect the running build on a real GPU in headless Chromium before delivering.',
    folder,
  ],
};

/** The block for one skill, in Markdown. */
export const firstBlock = (skill) =>
  `## In Local Studio\n\nThe person's request is at the top of this message and after \`</skill>\`.\n\n${FIRST[skill].join('\n\n')}\n`;

// ---------------------------------------------------------------------------------------------------------------------

const SKIP = (name) => name === '__pycache__' || name.toLowerCase() === '.ds_store' || name.endsWith('.pyc');

/**
 * Why `rel` (slash-separated, from the repository root) can't be read or written as a plain file (or, with `folder`, a
 * folder), or '' if it can.
 */
function pathProblem(repo, rel, folder = false) {
  const parts = rel.split('/');
  let cur = repo;
  for (const [i, part] of parts.entries()) {
    cur = join(cur, part);
    const st = lstatSync(cur, { throwIfNoEntry: false });
    if (!st) return '';
    const here = parts.slice(0, i + 1).join('/');
    if (st.isSymbolicLink()) return `${here} is a link`;
    if (i < parts.length - 1 && !st.isDirectory()) return `${here} is not a folder`;
    if (i === parts.length - 1 && !(folder ? st.isDirectory() : st.isFile()))
      return `${here} is not a ${folder ? 'folder' : 'regular file'}`;
  }
  return '';
}

/** Every file under `rel` (a folder from the repository root), as paths from that folder; links are a problem. */
function walk(repo, rel, { skip = true } = {}) {
  const out = [];
  const problems = [];
  (function go(sub) {
    const at = join(repo, rel, sub);
    for (const name of readdirSync(at).sort()) {
      if (skip && SKIP(name)) continue;
      const r = sub ? `${sub}/${name}` : name;
      const st = lstatSync(join(at, name));
      if (st.isSymbolicLink()) problems.push(`${rel}/${r} is a link`);
      else if (st.isDirectory()) go(r);
      else if (st.isFile()) out.push(r);
      else problems.push(`${rel}/${r} is not a regular file`);
    }
  })('');
  return { files: out, problems };
}

/** Text (no NUL byte) with CRLF read as LF; anything else as it is. */
function canon(bytes) {
  if (bytes.includes(0)) return bytes;
  const text = bytes.toString('utf8');
  return text.includes('\r\n') ? Buffer.from(text.replaceAll('\r\n', '\n'), 'utf8') : bytes;
}

const count = (text, find) => text.split(find).length - 1;

/** Puts the "In Local Studio" block right under the skill's first `# ` title. */
function withFirst(skill, text) {
  const m = /^# .*\n/m.exec(text);
  if (!m)
    throw new Error(`skills/${skill}/SKILL.md has no "# " title for the In Local Studio block to follow`);
  const at = m.index + m[0].length;
  return `${text.slice(0, at)}\n${firstBlock(skill)}${text.slice(at)}`;
}

/**
 * What the sync writes: a Map from paths inside the plugin to their bytes. Throws when a source is missing or a link,
 * or an edit no longer matches its source exactly once.
 */
export function expected(repo = root) {
  const out = new Map();
  const problems = [];
  for (const skill of CRAFT) {
    const base = `skills/${skill}`;
    const bad = pathProblem(repo, `${base}/SKILL.md`);
    if (bad || !existsSync(join(repo, base, 'SKILL.md'))) {
      problems.push(`${base}/SKILL.md: ${bad || 'missing'}`);
      continue;
    }
    if (lstatSync(join(repo, base)).isSymbolicLink()) {
      problems.push(`${base} is a link`);
      continue;
    }
    const { files, problems: p } = walk(repo, base);
    problems.push(...p);
    for (const f of files) out.set(`skills/${skill}/${f}`, canon(readFileSync(join(repo, base, f))));
  }
  for (const [i, e] of EDITS.entries()) {
    const key = `skills/${e.file}`;
    const bytes = out.get(key);
    const n = bytes ? count(bytes.toString('utf8'), e.find) : 0;
    if (n !== 1) {
      problems.push(
        `EDITS[${i}] (${e.why}) matches skills/${e.file} ${n} times, not once: skills/ changed under it, so update the edit in scripts/sync-local-studio-skills.mjs`,
      );
      continue;
    }
    out.set(
      key,
      Buffer.from(
        bytes.toString('utf8').replace(e.find, () => e.replace),
        'utf8',
      ),
    );
  }
  for (const skill of Object.keys(FIRST)) {
    const key = `skills/${skill}/SKILL.md`;
    if (!CRAFT.includes(skill) || !out.has(key)) {
      problems.push(`FIRST names ${skill}, which the sync doesn't ship`);
      continue;
    }
    try {
      out.set(key, Buffer.from(withFirst(skill, out.get(key).toString('utf8')), 'utf8'));
    } catch (e) {
      problems.push(e.message);
    }
  }
  for (const { from, to } of FILES) {
    const bad = pathProblem(repo, from);
    if (bad || !existsSync(join(repo, from))) problems.push(`${from}: ${bad || 'missing'}`);
    else out.set(to, readFileSync(join(repo, from)));
  }
  if (problems.length) throw new Error(problems.join('\n'));
  return out;
}

const runSync = 'run node scripts/sync-local-studio-skills.mjs';

/** Problems with the plugin's copy: missing, different, extra or a link. Reads only. */
export function drift(repo = root) {
  let want;
  try {
    want = expected(repo);
  } catch (e) {
    return e.message.split('\n');
  }
  const problems = [];
  for (const [rel, bytes] of want) {
    const path = `${PLUGIN}/${rel}`;
    const bad = pathProblem(repo, path);
    if (bad) problems.push(`${path}: ${bad}`);
    else if (!existsSync(join(repo, path))) problems.push(`${path} is missing: ${runSync}`);
    else if (!canon(readFileSync(join(repo, path))).equals(bytes))
      problems.push(
        `${path} differs from what the sync makes of skills/: change skills/ (or the edits in scripts/sync-local-studio-skills.mjs), then ${runSync}`,
      );
  }
  const skillsDir = `${PLUGIN}/skills`;
  if (existsSync(join(repo, skillsDir)))
    for (const name of readdirSync(join(repo, skillsDir)).sort()) {
      if (name.toLowerCase() === '.ds_store') continue;
      if (CRAFT.includes(name)) {
        const bad = pathProblem(repo, `${skillsDir}/${name}`, true);
        if (bad) {
          problems.push(`${skillsDir}/${name}: ${bad}`);
          continue;
        }
        const { files, problems: p } = walk(repo, `${skillsDir}/${name}`, { skip: false });
        problems.push(...p);
        for (const f of files)
          if (!want.has(`skills/${name}/${f}`))
            problems.push(`${skillsDir}/${name}/${f} isn't in skills/${name}: ${runSync} to remove it`);
      } else if (!OWN.includes(name))
        problems.push(
          `${skillsDir}/${name} is neither a synced craft skill nor one of the plugin's own: delete it, or add it to CRAFT or OWN in scripts/sync-local-studio-skills.mjs`,
        );
    }
  return problems;
}

/** Writes through a temporary file in the same folder, then renames it over `at`. */
function writeFileAtomic(at, data) {
  mkdirSync(dirname(at), { recursive: true });
  const tmp = join(dirname(at), `.${basename(at)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, data, { flag: 'wx', mode: 0o644 });
    renameSync(tmp, at);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Writes the plugin's copy and removes files the sync no longer makes. Returns { wrote, removed, problems }. */
export function sync(repo = root) {
  const want = expected(repo);
  const wrote = [];
  const removed = [];
  for (const [rel, bytes] of want) {
    const path = `${PLUGIN}/${rel}`;
    const bad = pathProblem(repo, path);
    if (bad) throw new Error(`${path}: ${bad}, so the sync won't write through it`);
    const at = join(repo, path);
    if (existsSync(at) && canon(readFileSync(at)).equals(bytes)) continue;
    writeFileAtomic(at, bytes);
    wrote.push(path);
  }
  for (const skill of CRAFT) {
    const dir = `${PLUGIN}/skills/${skill}`;
    if (!existsSync(join(repo, dir)) || pathProblem(repo, dir, true)) continue;
    const { files } = walk(repo, dir, { skip: false });
    for (const f of files)
      if (!want.has(`skills/${skill}/${f}`)) {
        rmSync(join(repo, dir, f));
        removed.push(`${dir}/${f}`);
      }
    // Folders the removals left empty.
    (function prune(at) {
      for (const name of readdirSync(at)) {
        const p = join(at, name);
        if (lstatSync(p).isDirectory()) {
          prune(p);
          if (readdirSync(p).length === 0) rmdirSync(p);
        }
      }
    })(join(repo, dir));
  }
  return { wrote, removed, problems: drift(repo) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--check')) {
    const problems = drift();
    if (problems.length) {
      console.error(`The Local Studio plugin's skills drifted:\n${problems.map((p) => `  ${p}`).join('\n')}`);
      process.exit(1);
    }
    console.log('The Local Studio plugin’s craft skills match skills/.');
  } else {
    const { wrote, removed, problems } = sync();
    const lines = [...wrote.map((w) => `wrote ${w}`), ...removed.map((r) => `removed ${r}`)];
    console.log(lines.length ? lines.join('\n') : 'The Local Studio plugin’s craft skills are up to date.');
    if (problems.length) {
      console.error(problems.map((p) => `  ${p}`).join('\n'));
      process.exit(1);
    }
  }
}
