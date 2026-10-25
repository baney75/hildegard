// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The print sheet: one self-contained page, to print on A4 or send to whoever prints the part (a friend, a teammate,
 * a print shop). It says what the part is for, shows it from every side, and puts down what it takes (time,
 * filament, money, beside what it costs to buy), how the parts fit, every dimension with where it came from, what is
 * still unknown, and what still fails. After print3d's hand-off by mfranzon (MIT; see THIRD_PARTY_NOTICES.md).
 *
 * Everything in it is escaped text and one embedded image; the page loads nothing and runs nothing.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Loop, Round } from './loop.ts';
import type { Printer } from './printer.ts';

const esc = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const mm = (n: unknown) => (typeof n === 'number' ? `${Math.round(n * 100) / 100}` : '');
const money = (n: number, cur: string) => `${n.toFixed(2)} ${cur}`;

interface Pair {
  a: string;
  b: string;
  declared: string | null;
  clearance_mm: number | null;
  interference_mm: number;
  verdict: string;
}
interface Like {
  view: string;
  iou: number;
  photo_mm: number[];
  model_mm: number[];
}

export function handoffHtml(l: Loop, r: Round, printer: Printer | undefined, sheet: string | null): string {
  const info = r.review.info;
  const s = r.slice ?? null;
  const ev = l.target.evidence;
  const listing = ev?.listing;
  const size = (info.size as number[] | undefined)?.map(mm).join(' × ');
  const parts = (info.parts as string[] | undefined) ?? [];
  const fits = (info.fits as Pair[] | undefined) ?? [];
  const likeness = (info.likeness as Like[] | undefined) ?? [];
  const open = r.review.checks.filter((c) => c.status !== 'pass');

  const facts: [string, string][] = [
    ['Size', size ? `${size} mm` : ''],
    ['Parts', parts.length ? parts.join(', ') : 'one'],
    ['Print time', s?.time ?? ''],
    [
      'Filament',
      s?.grams !== null && s?.grams !== undefined ? `${s.grams} g of ${printer?.material ?? 'PLA'}` : '',
    ],
    ['Layers', s?.layers ? String(s.layers) : ''],
    ['Filament cost', s?.cost !== null && s?.cost !== undefined ? `${money(s.cost, s.currency)} spent` : ''],
  ];
  if (listing && s?.cost !== null && s?.cost !== undefined && listing.currency === s.currency)
    facts.push([
      'Against buying it',
      `${money(listing.price, listing.currency)} to buy, so printing it saves ${money(Math.max(0, listing.price - s.cost), listing.currency)}`,
    ]);
  const factRows = facts
    .filter(([, v]) => v)
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td class="num">${esc(v)}</td></tr>`)
    .join('');

  const fitRows = fits
    .map(
      (p) =>
        `<tr><td>${esc(p.a)} and ${esc(p.b)}</td><td>${esc(p.declared ?? 'touching or apart')}</td><td class="num">${p.interference_mm > 0 ? `overlap ${mm(p.interference_mm)}` : p.clearance_mm !== null ? `${mm(p.clearance_mm)} per side` : 'touching'}</td><td>${esc(p.verdict)}</td></tr>`,
    )
    .join('');
  const likeRows = likeness
    .map(
      (v) =>
        `<tr><td>${esc(v.view)}</td><td class="num">${Math.round(v.iou * 100)}%</td><td class="num">${v.photo_mm.map(mm).join(' × ')}</td><td class="num">${v.model_mm.map(mm).join(' × ')}</td></tr>`,
    )
    .join('');
  const dimRows = (ev?.dims ?? [])
    .map(
      (d) =>
        `<tr><td>${esc(d.name)}</td><td class="num">${mm(d.mm)}${d.toleranceMm !== undefined ? ` ± ${mm(d.toleranceMm)}` : ''}</td><td>${esc(d.source)}</td><td>${esc(d.how ?? '')}</td></tr>`,
    )
    .join('');
  const unknowns = (ev?.unknowns ?? []).map((u) => `<li>${esc(u)}</li>`).join('');
  const notes = open
    .map((c) => `<li><b>${c.status === 'fail' ? 'Fails' : 'Check'}: ${esc(c.id)}.</b> ${esc(c.detail)}</li>`)
    .join('');
  const table = (head: string[], rows: string) =>
    rows
      ? `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`
      : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(l.title)} · print sheet</title>
<style>
:root{--canvas:#f4efe4;--panel:#fbf8f1;--ink:#1f1c17;--muted:#5d574c;--hair:#d9d1c1;--brand:#1f6b4f;--gold:#9a7417;--ember:#a8431c;color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:var(--canvas);color:var(--ink);font:15px/1.5 "Source Sans 3","Source Sans Pro",system-ui,sans-serif}
main{max-width:52rem;margin:0 auto;padding:2rem 1.25rem 3rem}
h1{font:600 2.25rem/1.1 "Cormorant Garamond",Georgia,serif;margin:0 0 .25rem}
h2{font:600 1.35rem/1.2 "Cormorant Garamond",Georgia,serif;margin:1.75rem 0 .5rem;padding-top:.75rem;border-top:1px solid var(--hair)}
.lede{color:var(--muted);margin:0 0 1rem}
.num,td.num{font-family:"DM Mono",ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums}
table{border-collapse:collapse;width:100%;margin:.25rem 0 .5rem;background:var(--panel)}
th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid var(--hair);vertical-align:top}
thead th{font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
tbody th{font-weight:600;width:12rem}
img{display:block;width:100%;height:auto;border:1px solid var(--hair);border-radius:8px;background:#181816}
ul{padding-left:1.2rem;margin:.25rem 0}
li{margin:.2rem 0}
.brief{background:var(--panel);border-left:3px solid var(--brand);padding:.75rem 1rem;border-radius:4px}
.fails b{color:var(--ember)}
footer{margin-top:2rem;color:var(--muted);font-size:.85rem}
@media print{body{background:#fff}main{padding:0;max-width:none}h2{break-after:avoid}table,img{break-inside:avoid}}
</style></head>
<body><main>
<h1>${esc(l.title)}</h1>
<p class="lede">Print sheet · round ${r.n} of ${l.rounds.length} · ${esc(new Date(l.updatedAt).toISOString().slice(0, 10))}${printer ? ` · ${esc(printer.name)}, ${mm(printer.nozzleMm)} mm nozzle, ${esc(printer.material)}` : ''}</p>
<div class="brief"><p><b>For</b> ${esc(l.brief.for)}</p><p><b>What</b> ${esc(l.brief.what)}</p>${l.brief.specifics.length ? `<ul>${l.brief.specifics.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>
${sheet ? `<h2>Every side</h2><img alt="The part from eight sides, from below, and its silhouettes" src="data:image/jpeg;base64,${sheet}">` : ''}
<h2>What it takes</h2>
<table><tbody>${factRows}</tbody></table>
${s ? `<p class="lede">Sliced with ${esc(s.slicer)}${s.gcode ? ` into ${esc(s.gcode)}` : ''}. Check the preview in your slicer before you print.</p>` : '<p class="lede">Not sliced here. Open the model in your slicer for time and filament.</p>'}
${fitRows ? `<h2>How the parts fit</h2>${table(['Parts', 'Fit', 'Measured', 'Verdict'], fitRows)}<p class="lede">Clearance per side, as modelled, against ${printer?.calibrated.length ? `this printer’s calibrated clearances (${esc(printer.calibratedAt ?? '')})` : 'the usual starting points (print the fit coupon to calibrate)'}.</p>` : ''}
${likeRows ? `<h2>Against the photograph</h2>${table(['View', 'Match', 'Photo, mm', 'Model, mm'], likeRows)}` : ''}
${dimRows ? `<h2>Every dimension, and where it came from</h2>${table(['Dimension', 'mm', 'Source', 'How'], dimRows)}` : ''}
${unknowns ? `<h2>Check these first on the print</h2><ul>${unknowns}</ul>` : ''}
${notes ? `<h2>Still open</h2><ul class="fails">${notes}</ul>` : ''}
${l.note ? `<h2>From the maker</h2><p>${esc(l.note)}</p>` : ''}
<footer>Made with Hildegard, on your own computer. The model was checked and sliced, not printed: hold it to the brief once it is. Files: ${esc(r.file)}${s?.gcode ? `, ${esc(s.gcode)}` : ''}.</footer>
</main></body></html>
`;
}

/** Writes the print sheet beside the round. */
export function writeHandoff(path: string, l: Loop, r: Round, printer?: Printer) {
  const sheetFile = r.sheet ? join(dirname(path), r.sheet) : null;
  const sheet = sheetFile && existsSync(sheetFile) ? readFileSync(sheetFile).toString('base64') : null;
  writeFileSync(path, handoffHtml(l, r, printer, sheet));
}
