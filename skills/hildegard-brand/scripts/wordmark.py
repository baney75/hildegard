#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""wordmark.py: set a name in a Google Fonts typeface as SVG paths, kern it by hand, and measure its spacing.

  python3 wordmark.py "Brickyard Press" --family "Libre Caslon Text" --weight 700 [--out wordmark.svg]
         [--font file.ttf] [--size 200] [--tracking 0] [--kern "Pr:-20,ya:-15"] [--case upper|lower]
         [--color "#1d1a17"] [--report]

--family/--weight fetch the static TrueType file from Google Fonts (cached in ~/.cache/hildegard-fonts); --font uses a
.ttf you already have. Every Google Fonts family is under a license (OFL, Apache or UFL) that allows a logo.
--tracking is in thousandths of an em, added between every pair. --kern adds to (or replaces, with "=") the font's own
kerning for a pair of letters, in font units: "AV:-30" tightens A and V by 30 units, "To:=-90" sets it outright.
--report measures the white area between each pair of letters (needs Pillow) against the font's own HH / nn spacing and
names every pair off by more than 20%, with a first guess at the kern. The numbers point; the eye decides. Also writes
<out>-flipped.png, the wordmark upside down: judge the gaps there, as shapes rather than letters.

The SVG carries data-cap-height, data-x-height and data-baseline (in its own units) so lockup.py can line it up with
the mark. Standard library only for the paths; TrueType outlines (glyf) only, which is what Google Fonts serves."""
import argparse, json, os, re, struct, sys, urllib.parse, urllib.request

CACHE = os.path.join(os.path.expanduser('~'), '.cache', 'hildegard-fonts')


class Font:
    def __init__(self, path):
        self.path = path
        self.b = open(path, 'rb').read()
        b = self.b
        if b[:4] == b'OTTO':
            raise SystemExit(f'{path} has PostScript (CFF) outlines; use the .ttf version (Google Fonts serves TrueType)')
        if b[:4] in (b'wOFF', b'wOF2'):
            raise SystemExit(f'{path} is a web font (WOFF); use the .ttf (--family fetches one)')
        n = struct.unpack('>H', b[4:6])[0]
        self.t = {}
        for i in range(n):
            tag, _, off, ln = struct.unpack('>4sIII', b[12 + 16 * i:28 + 16 * i])
            self.t[tag.decode('latin-1')] = (off, ln)
        h = self.t['head'][0]
        self.upem = self.u16(h + 18)
        self.long_loca = self.i16(h + 50) == 1
        self.num_glyphs = self.u16(self.t['maxp'][0] + 4)
        hh = self.t['hhea'][0]
        self.ascent, self.descent = self.i16(hh + 4), self.i16(hh + 6)
        self.n_hmetrics = self.u16(hh + 34)
        self.cap, self.xh = None, None
        if 'OS/2' in self.t:
            o = self.t['OS/2'][0]
            if self.u16(o) >= 2:
                self.xh, self.cap = self.i16(o + 86), self.i16(o + 88)
        self.cmap = self._cmap()
        self._kern = self._gpos_kern()
        if self.cap is None:
            self.cap = self.bbox(self.gid('H'))[3] if self.gid('H') else int(self.upem * 0.7)
        if self.xh is None:
            self.xh = self.bbox(self.gid('x'))[3] if self.gid('x') else int(self.upem * 0.5)

    def u16(self, o): return struct.unpack('>H', self.b[o:o + 2])[0]
    def i16(self, o): return struct.unpack('>h', self.b[o:o + 2])[0]
    def u32(self, o): return struct.unpack('>I', self.b[o:o + 4])[0]

    def _cmap(self):
        c = self.t['cmap'][0]
        best = None
        for i in range(self.u16(c + 2)):
            pid, eid, off = struct.unpack('>HHI', self.b[c + 4 + 8 * i:c + 12 + 8 * i])
            fmt = self.u16(c + off)
            rank = {(3, 10, 12): 0, (0, 4, 12): 1, (3, 1, 4): 2, (0, 3, 4): 3}.get((pid, eid, fmt), 9 if fmt in (4, 12) else None)
            if rank is not None and (best is None or rank < best[0]):
                best = (rank, c + off, fmt)
        if not best:
            raise SystemExit('no Unicode character map in this font')
        _, o, fmt = best
        m = {}
        if fmt == 12:
            for g in range(self.u32(o + 12)):
                s, e, start = struct.unpack('>III', self.b[o + 16 + 12 * g:o + 28 + 12 * g])
                for cp in range(s, e + 1):
                    m[cp] = start + cp - s
        else:
            seg = self.u16(o + 6) // 2
            ends, starts = o + 14, o + 16 + 2 * seg
            deltas, ranges = starts + 2 * seg, starts + 4 * seg
            for i in range(seg):
                e, s = self.u16(ends + 2 * i), self.u16(starts + 2 * i)
                d, ro = self.i16(deltas + 2 * i), self.u16(ranges + 2 * i)
                for cp in range(s, min(e, 0xFFFE) + 1):
                    if ro == 0:
                        g = (cp + d) & 0xFFFF
                    else:
                        g = self.u16(ranges + 2 * i + ro + 2 * (cp - s))
                        g = (g + d) & 0xFFFF if g else 0
                    if g:
                        m[cp] = g
        return m

    def gid(self, ch):
        return self.cmap.get(ord(ch), 0)

    def advance(self, g):
        h = self.t['hmtx'][0]
        return self.u16(h + 4 * min(g, self.n_hmetrics - 1))

    def _loc(self, g):
        l = self.t['loca'][0]
        if self.long_loca:
            return self.u32(l + 4 * g), self.u32(l + 4 * g + 4)
        return 2 * self.u16(l + 2 * g), 2 * self.u16(l + 2 * g + 2)

    def bbox(self, g):
        s, e = self._loc(g)
        if s == e:
            return (0, 0, 0, 0)
        o = self.t['glyf'][0] + s
        return tuple(self.i16(o + k) for k in (2, 4, 6, 8))

    def contours(self, g, depth=0):
        """[[(x, y, on_curve), ...], ...] in font units."""
        s, e = self._loc(g)
        if s == e or depth > 8:
            return []
        o = self.t['glyf'][0] + s
        nc = self.i16(o)
        if nc >= 0:
            ends = [self.u16(o + 10 + 2 * i) for i in range(nc)]
            p = o + 10 + 2 * nc
            p += 2 + self.u16(p)
            n = ends[-1] + 1 if ends else 0
            flags = []
            while len(flags) < n:
                f = self.b[p]; p += 1
                flags.append(f)
                if f & 8:
                    r = self.b[p]; p += 1
                    flags += [f] * r
            xs, ys, v = [], [], 0
            for f in flags:
                if f & 2:
                    d = self.b[p]; p += 1
                    v += d if f & 16 else -d
                elif not f & 16:
                    v += self.i16(p); p += 2
                xs.append(v)
            v = 0
            for f in flags:
                if f & 4:
                    d = self.b[p]; p += 1
                    v += d if f & 32 else -d
                elif not f & 32:
                    v += self.i16(p); p += 2
                ys.append(v)
            out, start = [], 0
            for end in ends:
                out.append([(xs[i], ys[i], bool(flags[i] & 1)) for i in range(start, end + 1)])
                start = end + 1
            return out
        out, p = [], o + 10
        while True:
            fl, cg = self.u16(p), self.u16(p + 2); p += 4
            if fl & 1:
                a1, a2 = self.i16(p), self.i16(p + 2); p += 4
            else:
                a1, a2 = struct.unpack('>bb', self.b[p:p + 2]); p += 2
            a, b, c, d = 1.0, 0.0, 0.0, 1.0
            f2 = lambda q: self.i16(q) / 16384
            if fl & 8:
                a = d = f2(p); p += 2
            elif fl & 0x40:
                a, d = f2(p), f2(p + 2); p += 4
            elif fl & 0x80:
                a, b, c, d = f2(p), f2(p + 2), f2(p + 4), f2(p + 6); p += 8
            dx, dy = (a1, a2) if fl & 2 else (0, 0)
            for ct in self.contours(cg, depth + 1):
                out.append([(a * x + c * y + dx, b * x + d * y + dy, on) for x, y, on in ct])
            if not fl & 0x20:
                break
        return out

    # GPOS pair kerning (lookup type 2, also inside extension lookups), feature 'kern'
    def _coverage(self, o):
        fmt, out = self.u16(o), {}
        if fmt == 1:
            for i in range(self.u16(o + 2)):
                out[self.u16(o + 4 + 2 * i)] = i
        else:
            for i in range(self.u16(o + 2)):
                s, e, si = self.u16(o + 4 + 6 * i), self.u16(o + 6 + 6 * i), self.u16(o + 8 + 6 * i)
                for g in range(s, e + 1):
                    out[g] = si + g - s
        return out

    def _classdef(self, o):
        fmt, out = self.u16(o), {}
        if fmt == 1:
            s = self.u16(o + 2)
            for i in range(self.u16(o + 4)):
                out[s + i] = self.u16(o + 6 + 2 * i)
        else:
            for i in range(self.u16(o + 2)):
                s, e, k = self.u16(o + 4 + 6 * i), self.u16(o + 6 + 6 * i), self.u16(o + 8 + 6 * i)
                for g in range(s, e + 1):
                    out[g] = k
        return out

    @staticmethod
    def _vsize(vf):
        return 2 * bin(vf & 0xFF).count('1')

    def _xadv(self, o, vf):
        """XAdvance from a ValueRecord at o."""
        p = o
        for bit in range(4):
            if vf & (1 << bit):
                if bit == 2:
                    return self.i16(p)
                p += 2
        return 0

    def _gpos_kern(self):
        if 'GPOS' not in self.t:
            return None
        g = self.t['GPOS'][0]
        fl, ll = g + self.u16(g + 6), g + self.u16(g + 8)
        idx = set()
        for i in range(self.u16(fl)):
            tag = self.b[fl + 2 + 6 * i:fl + 6 + 6 * i]
            if tag == b'kern':
                f = fl + self.u16(fl + 6 + 6 * i)
                idx |= {self.u16(f + 4 + 2 * k) for k in range(self.u16(f + 2))}
        subs = []
        for li in sorted(idx):
            lo = ll + self.u16(ll + 2 + 2 * li)
            typ = self.u16(lo)
            for k in range(self.u16(lo + 4)):
                so = lo + self.u16(lo + 6 + 2 * k)
                if typ == 9:
                    typ2, so = self.u16(so + 2), so + self.u32(so + 4)
                    if typ2 != 2:
                        continue
                elif typ != 2:
                    continue
                subs.append(so)
        return subs

    def kern(self, a, b):
        for so in self._kern or []:
            fmt, cov = self.u16(so), self._coverage(so + self.u16(so + 2))
            if a not in cov:
                continue
            v1, v2 = self.u16(so + 4), self.u16(so + 6)
            s1, s2 = self._vsize(v1), self._vsize(v2)
            if fmt == 1:
                ps = so + self.u16(so + 10 + 2 * cov[a])
                for i in range(self.u16(ps)):
                    r = ps + 2 + i * (2 + s1 + s2)
                    if self.u16(r) == b:
                        return self._xadv(r + 2, v1)
                continue
            if fmt == 2:
                c1 = self._classdef(so + self.u16(so + 8)).get(a, 0)
                c2 = self._classdef(so + self.u16(so + 10)).get(b, 0)
                n2 = self.u16(so + 14)
                r = so + 16 + (c1 * n2 + c2) * (s1 + s2)
                v = self._xadv(r, v1)
                if v:
                    return v
        return 0


def fetch(family, weight, italic=False):
    os.makedirs(CACHE, exist_ok=True)
    key = re.sub(r'\W+', '-', f'{family}-{weight}{"-italic" if italic else ""}').lower()
    path = os.path.join(CACHE, key + '.ttf')
    if os.path.exists(path):
        return path
    spec = f'{family}:ital,wght@{1 if italic else 0},{weight}'
    url = 'https://fonts.googleapis.com/css2?family=' + urllib.parse.quote(spec, safe=':,@')
    try:
        css = urllib.request.urlopen(url, timeout=20).read().decode()
    except Exception as e:
        raise SystemExit(f'could not fetch {family} {weight} from Google Fonts ({e}). Check the family name on '
                         f'fonts.google.com, or download the .ttf yourself and pass --font')
    m = re.search(r'url\((https://[^)]+\.ttf)\)', css)
    if not m:
        raise SystemExit(f'Google Fonts gave no TrueType file for {family} {weight}')
    data = urllib.request.urlopen(m.group(1), timeout=30).read()
    open(path, 'wb').write(data)
    return path


def path_data(contours, ox, s, asc):
    """SVG path data for TrueType quadratic contours, placed at pen x `ox` (font units) and scaled by s."""
    X = lambda x: round((ox + x) * s, 2)
    Y = lambda y: round((asc - y) * s, 2)
    d = []
    for c in contours:
        if not c:
            continue
        pts = c[:]
        if not pts[0][2]:
            if pts[-1][2]:
                pts = [pts[-1]] + pts[:-1]
            else:
                mx, my = (pts[0][0] + pts[-1][0]) / 2, (pts[0][1] + pts[-1][1]) / 2
                pts = [(mx, my, True)] + pts
        d.append(f'M{X(pts[0][0])} {Y(pts[0][1])}')
        i, n = 1, len(pts)
        while i <= n:
            x, y, on = pts[i % n]
            if on:
                d.append(f'L{X(x)} {Y(y)}')
                i += 1
            else:
                nx, ny, non = pts[(i + 1) % n]
                if non:
                    d.append(f'Q{X(x)} {Y(y)} {X(nx)} {Y(ny)}')
                    i += 2
                else:
                    mx, my = (x + nx) / 2, (y + ny) / 2
                    d.append(f'Q{X(x)} {Y(y)} {X(mx)} {Y(my)}')
                    i += 1
        d.append('Z')
    return ''.join(d)


def parse_kern(spec):
    out = {}
    for item in filter(None, (x.strip() for x in (spec or '').split(','))):
        m = re.match(r'^(.)(.)\s*:\s*(=?)\s*(-?\d+)$', item)
        if not m:
            raise SystemExit(f'--kern item {item!r} should look like "AV:-30" or "To:=-90"')
        out[m.group(1) + m.group(2)] = (m.group(3) == '=', int(m.group(4)))
    return out


def layout(font, text, tracking, kern):
    """[(char, gid, pen x)], total advance, kerning used per pair (font units)."""
    pen, out, used = 0, [], {}
    trk = tracking * font.upem / 1000
    prev = None
    for ch in text:
        g = font.gid(ch)
        if prev is not None:
            pair = prev[0] + ch
            k = font.kern(prev[1], g) if font._kern else 0
            if pair in kern:
                rep, v = kern[pair]
                k = v if rep else k + v
            used[pair] = k
            pen += k + trk
        out.append((ch, g, pen))
        pen += font.advance(g)
        prev = (ch, g)
    return out, pen, used


def svg(font, placed, size, color, name):
    s = size / font.upem
    asc = font.ascent
    paths, xs, ys = [], [], []
    for ch, g, x in placed:
        cs = font.contours(g)
        for c in cs:
            for px, py, _ in c:
                xs.append((x + px) * s)
                ys.append((asc - py) * s)
        if cs:
            paths.append(f'<path data-letter="{ch if ch not in "<>&\"" else "?"}" d="{path_data(cs, x, s, asc)}"/>')
    if not xs:
        raise SystemExit('nothing to draw: the font has none of these letters')
    x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
    pad = size * 0.02
    vb = (round(x0 - pad, 2), round(y0 - pad, 2), round(x1 - x0 + 2 * pad, 2), round(y1 - y0 + 2 * pad, 2))
    base = round(asc * s, 2)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{" ".join(map(str, vb))}" '
            f'data-baseline="{base}" data-cap-height="{round(font.cap * s, 2)}" data-x-height="{round(font.xh * s, 2)}" '
            f'aria-label="{name}"><g fill="{color}">\n' + '\n'.join(paths) + '\n</g></svg>\n')


def spacing(font, placed, px=160):
    """Per pair: the mean white gap across the letters' band, against the font's own HH / nn."""
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        return None, 'install Pillow for the spacing report'
    f = ImageFont.truetype(font.path, px)
    s = px / font.upem
    band_cap, band_x = font.cap * s, font.xh * s

    def edges(ch, x, w, base):
        im = Image.new('L', (w, int(base + px * 0.4)), 0)
        ImageDraw.Draw(im).text((x, base), ch, font=f, fill=255, anchor='ls')
        return im

    def gap(a, b, ax, bx, top):
        w = int(bx + px * 1.5)
        base = int(px * 1.2)
        ia, ib = edges(a, ax, w, base), edges(b, bx, w, base)
        la, lb = ia.load(), ib.load()
        bba, bbb = ia.getbbox(), ib.getbbox()
        if not bba or not bbb:
            return None
        depth = 0.25 * band_x  # open sides (r, L, T, k) count only this far in
        tot, rows = 0.0, 0
        for y in range(int(base - top), base):
            ra = next((x for x in range(bba[2] - 1, bba[0] - 1, -1) if la[x, y] > 127), None)
            lb_ = next((x for x in range(bbb[0], bbb[2]) if lb[x, y] > 127), None)
            r = max(ra if ra is not None else -1e9, bba[2] - depth)
            l = min(lb_ if lb_ is not None else 1e9, bbb[0] + depth)
            tot += l - r
            rows += 1
        return tot / max(rows, 1)

    def ref(a, b):
        up = lambda c: c.isupper() or c.isdigit()
        r = ('H' if up(a) else 'n') + ('H' if up(b) else 'n')
        ga, gb = font.gid(r[0]), font.gid(r[1])
        k = font.kern(ga, gb) if font._kern else 0
        top = band_cap if (up(a) or up(b)) else band_x
        return gap(r[0], r[1], 10, 10 + (font.advance(ga) + k) * s, top), top

    out = []
    for (a, ga, xa), (b, gb, xb) in zip(placed, placed[1:]):
        if a.isspace() or b.isspace():
            continue
        r, top = ref(a, b)
        g = gap(a, b, 10, 10 + (xb - xa) * s, top)
        if g is None or not r:
            continue
        off = (g - r) / r
        sug = round(-(g - r) / s * 0.5)
        lim = round(font.upem * 0.08)
        sug = max(-lim, min(lim, sug))
        out.append({'pair': a + b, 'gap_px': round(g, 1), 'ref_px': round(r, 1), 'off': round(off, 3),
                    'suggest_units': sug if abs(off) > 0.2 else 0})
    return out, None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('text')
    ap.add_argument('--family')
    ap.add_argument('--weight', type=int, default=400)
    ap.add_argument('--italic', action='store_true')
    ap.add_argument('--font')
    ap.add_argument('--size', type=float, default=200)
    ap.add_argument('--tracking', type=float, default=0)
    ap.add_argument('--kern', default='')
    ap.add_argument('--case', choices=['upper', 'lower'])
    ap.add_argument('--color', default='#000000')
    ap.add_argument('--out', default='wordmark.svg')
    ap.add_argument('--report', action='store_true')
    a = ap.parse_args()
    if not a.font and not a.family:
        sys.exit('give --family (a Google Fonts family) or --font (a .ttf file)')
    path = a.font or fetch(a.family, a.weight, a.italic)
    font = Font(path)
    text = a.text.upper() if a.case == 'upper' else a.text.lower() if a.case == 'lower' else a.text
    missing = sorted({c for c in text if not c.isspace() and not font.gid(c)})
    if missing:
        sys.exit(f'the font has no glyph for: {" ".join(missing)}')
    kern = parse_kern(a.kern)
    placed, adv, used = layout(font, text, a.tracking, kern)
    rep = None
    if a.report:
        rep, why = spacing(font, placed)
        if why:
            print(why)
    doc = svg(font, placed, a.size, a.color, text)
    open(a.out, 'w', encoding='utf-8').write(doc)
    print(f'{a.out}: "{text}" in {os.path.basename(path)}, {font.upem} units per em, cap height {font.cap}, x-height {font.xh}')
    print('kerning used (font units): ' + ', '.join(f'{p}:{v}' for p, v in used.items() if v) or 'none')
    if kern:
        print('your --kern: ' + ','.join(f'{p}:{"=" if r else ""}{v}' for p, (r, v) in kern.items()))
    if rep:
        print('\nSpacing, measured (gap = mean white between the letters, against the font\'s own HH or nn):')
        for r in rep:
            flag = f'  -> kern {r["suggest_units"]:+d}' if r['suggest_units'] else ''
            print(f'  {r["pair"]}  gap {r["gap_px"]:>5} px  reference {r["ref_px"]:>5}  {r["off"]:+.0%}{flag}')
        sug = ','.join(f'{r["pair"]}:{r["suggest_units"]}' for r in rep if r['suggest_units'])
        print(f'\nPairs to look at, with a first guess: --kern "{sug}"' if sug else '\nEvery pair is within 20% of the reference.')
        print('The numbers point; your eye decides. Apply a guess only if the flipped render shows that gap is wrong, then render again.')
    try:
        from PIL import Image, ImageDraw, ImageFont
        f = ImageFont.truetype(path, 160)
        w = int(adv * 160 / font.upem + 60)
        im = Image.new('L', (w, 260), 255)
        d = ImageDraw.Draw(im)
        for ch, g, x in placed:
            d.text((30 + x * 160 / font.upem, 200), ch, font=f, fill=0, anchor='ls')
        flipped = os.path.splitext(a.out)[0] + '-flipped.png'
        im.rotate(180).save(flipped)
        print(f'Upside down, for judging the gaps: {flipped}')
    except Exception:
        pass
    if a.report:
        json.dump({'text': text, 'font': path, 'kerning': used, 'spacing': rep}, open(os.path.splitext(a.out)[0] + '-spacing.json', 'w'), indent=1)


if __name__ == '__main__':
    main()
