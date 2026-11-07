#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""screen_check.py: render app screens at a device's size and measure what a reviewer would catch.

  python3 screen_check.py screen.html [empty.html error.html ...] --device iphone [--out screen-check] [--json]

Devices: iphone (390 x 844, iOS), iphone-se (375 x 667, iOS), ipad (820 x 1180, iOS), android (412 x 915),
android-small (360 x 800), desktop (1280 x 800), laptop (1440 x 900), or WxH with --platform ios|android|desktop|web.

For each file it writes <name>.png (2x), and then screens.png, every state side by side for a reviewer, and
report.json. Checks:
  overflow     nothing wider than the screen (sideways scrolling)                                   fail
  contrast     every visible text at least 4.5:1 (3:1 at 24 px, or 18.7 px bold) against its background  fail
  clipped      text cut off by its box (no ellipsis) or running off the screen                       fail
  targets      tap targets under 24 px fail; under the platform's size (44 pt iOS, 48 dp Android,
               24 px desktop) warn
  text-size    text under 11 px fails; body under the platform's (17 pt iOS, 16 sp Android, 14 px desktop) warns
  safe-area    text or controls under the iOS status bar or home indicator (warn)
  placeholder  lorem ipsum, "Item 1", "TODO", "your text here" (fail)
  fonts, alt   more than two families (warn); an image with no alt (warn)

Needs Chromium (Playwright's, or chromium on PATH) and Python 3.9+; Pillow for the side-by-side sheet."""
import argparse, html, json, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from browser import chromium_dom, chromium_shot, find_chromium  # noqa: E402

DEVICES = {
    'iphone': (390, 844, 'ios'), 'iphone-se': (375, 667, 'ios'), 'ipad': (820, 1180, 'ios'),
    'android': (412, 915, 'android'), 'android-small': (360, 800, 'android'),
    'desktop': (1280, 800, 'desktop'), 'laptop': (1440, 900, 'desktop'),
}
PLATFORM = {  # min target, body size, safe top, safe bottom
    'ios': (44, 17, 47, 34), 'android': (48, 16, 0, 0), 'desktop': (24, 14, 0, 0), 'web': (44, 16, 0, 0),
}

AUDIT = r"""(()=>{
const W=w.innerWidth,H=w.innerHeight,S=w.getComputedStyle.bind(w);
const vis=el=>{for(let n=el;n&&n.nodeType===1;n=n.parentElement){const s=S(n);if(s.display==='none'||s.visibility==='hidden'||+s.opacity===0)return false}
  const r=el.getBoundingClientRect();return r.width>0&&r.height>0};
const parse=c=>{const m=(c||'').match(/rgba?\(([^)]+)\)/);if(!m)return null;const p=m[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat);return [p[0],p[1],p[2],p.length>3?p[3]:1]};
const over=(t,b)=>{const a=t[3];return [t[0]*a+b[0]*(1-a),t[1]*a+b[1]*(1-a),t[2]*a+b[2]*(1-a),1]};
const L=c=>{const f=v=>{v/=255;return v<=0.04045?v/12.92:Math.pow((v+0.055)/1.055,2.4)};return 0.2126*f(c[0])+0.7152*f(c[1])+0.0722*f(c[2])};
const cr=(a,b)=>{const x=L(a),y=L(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05)};
const hex=c=>'#'+c.slice(0,3).map(v=>Math.round(v).toString(16).padStart(2,'0')).join('');
const bgOf=el=>{const ch=[];for(let n=el;n&&n.nodeType===1;n=n.parentElement)ch.push(n);let c=[255,255,255,1],img=false;
  for(const n of ch.reverse()){const s=S(n);const b=parse(s.backgroundColor);if(b&&b[3]>0){c=over(b,c);if(b[3]>=1)img=false}
    if(s.backgroundImage&&s.backgroundImage!=='none')img=true}return {c,img}};
const label=el=>((el.getAttribute('aria-label')||el.textContent||el.getAttribute('title')||el.tagName)+'').replace(/\s+/g,' ').trim().slice(0,40);
const out={W,H,scrollW:d.documentElement.scrollWidth,scrollH:d.documentElement.scrollHeight,contrast:[],texts:0,sizes:[],clipped:[],offscreen:[],
  targets:0,small:[],fonts:{},noAlt:0,placeholder:[],safe:[],viewport:!!d.querySelector('meta[name=viewport]'),title:d.title||''};
const seen=new Set();const tw=d.createTreeWalker(d.body,NodeFilter.SHOW_TEXT);let t;
while((t=tw.nextNode())){const s0=t.textContent.trim();if(!s0)continue;const el=t.parentElement;if(!el||seen.has(el)||el.closest('svg,script,style,noscript'))continue;
  seen.add(el);if(!vis(el))continue;if(el.closest('[aria-hidden=true]')&&!el.closest('[data-system]'))continue;
  const s=S(el),fs=parseFloat(s.fontSize),fw=parseInt(s.fontWeight)||400;out.texts++;
  const txt=s0.replace(/\s+/g,' ').slice(0,40);out.sizes.push([fs,txt,!!el.closest('[data-system]'),s0.length]);
  if(!el.closest('[data-system]'))out.fonts[s.fontFamily.split(',')[0].replace(/["']/g,'').trim()]=1;
  const bg=bgOf(el);const fg=parse(s.color);if(fg&&!bg.img){const c=over(fg,bg.c);const r=cr(c,bg.c);const large=fs>=24||(fs>=18.66&&fw>=700);const need=large?3:4.5;
    if(r<need-0.005)out.contrast.push({text:txt,ratio:Math.round(r*100)/100,need,fg:hex(c),bg:hex(bg.c),size:fs})}
  const r=el.getBoundingClientRect();
  if((s.overflowX==='hidden'||s.overflowX==='clip'||s.overflow==='hidden')&&el.scrollWidth>el.clientWidth+1&&s.textOverflow!=='ellipsis')out.clipped.push(txt);
  if(r.right>W+1||r.left<-1)out.offscreen.push(txt);
  if(/lorem ipsum|dolor sit amet|\bTODO\b|your text here|placeholder text|^item \d+$/i.test(s0))out.placeholder.push(txt);
  if(!el.closest('[data-system]')&&(r.top<SAFE_TOP||r.bottom>H-SAFE_BOTTOM)&&r.bottom>0&&r.top<H)out.safe.push(txt)}
const sel='a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=switch],[role=menuitem],[onclick]';
for(const el of d.querySelectorAll(sel)){if(!vis(el)||el.closest('[data-system]'))continue;out.targets++;const r=el.getBoundingClientRect();const m=Math.min(r.width,r.height);
  if(m<MIN_TARGET)out.small.push({label:label(el),w:Math.round(r.width),h:Math.round(r.height)});
  if((r.top<SAFE_TOP||r.bottom>H-SAFE_BOTTOM)&&r.top<H)out.safe.push('control: '+label(el))}
for(const im of d.querySelectorAll('img'))if(!im.hasAttribute('alt'))out.noAlt++;
out.fonts=Object.keys(out.fonts);return out})()"""


def audit(page, w, h, plat):
    tgt, _, top, bottom = PLATFORM[plat]
    js = AUDIT.replace('MIN_TARGET', str(tgt)).replace('SAFE_TOP', str(top)).replace('SAFE_BOTTOM', str(bottom))
    return chromium_dom(page, w, h, js)


def judge(a, plat):
    """[(state, check, message)] for one screen's audit."""
    tgt, body, _, _ = PLATFORM[plat]
    res = []
    add = lambda st, k, m: res.append((st, k, m))
    if a.get('error'):
        return [('fail', 'audit', a['error'])]
    over = a['scrollW'] - a['W']
    add('fail' if over > 1 else 'pass', 'overflow', f'{over} px wider than the screen' if over > 1 else 'fits the width')
    c = a['contrast']
    add('fail' if c else 'pass', 'contrast', f'{len(c)} of {a["texts"]} texts under WCAG AA: ' + '; '.join(
        f'"{x["text"]}" {x["ratio"]}:1 ({x["fg"]} on {x["bg"]}, needs {x["need"]})' for x in c[:4]) if c else f'all {a["texts"]} texts pass AA')
    cl = a['clipped'] + a['offscreen']
    add('fail' if cl else 'pass', 'clipped', ('cut off: ' + '; '.join(f'"{x}"' for x in cl[:4])) if cl else 'no text cut off')
    tiny = [x for x in a['small'] if min(x['w'], x['h']) < 24]
    small = [x for x in a['small'] if x not in tiny]
    if tiny:
        add('fail', 'targets', f'{len(tiny)} under 24 px: ' + '; '.join(f'"{x["label"]}" {x["w"]}x{x["h"]}' for x in tiny[:4]))
    elif small:
        add('warn', 'targets', f'{len(small)} under {tgt} px: ' + '; '.join(f'"{x["label"]}" {x["w"]}x{x["h"]}' for x in small[:4]))
    else:
        add('pass', 'targets', f'all {a["targets"]} at least {tgt} px')
    own = [(s, t, n) for s, t, system, n in a['sizes'] if not system]
    under = [(s, t) for s, t, _ in own if s < 11]
    if under:
        add('fail', 'text-size', 'under 11 px: ' + '; '.join(f'"{t}" {s:g} px' for s, t in under[:4]))
    elif own:
        chars = {}
        for s, _, n in own:
            chars[s] = chars.get(s, 0) + n
        most = max(chars, key=chars.get)  # the size that carries the most words
        low = most < body - 2
        add('warn' if low else 'pass', 'text-size', f'smallest {min(chars):g} px; most words at {most:g} px'
            + (f'; the reading size on {plat} is {body}' if low else ''))
    if a['safe']:
        add('warn', 'safe-area', 'under the status bar or home indicator: ' + '; '.join(f'"{x}"' for x in a['safe'][:4]))
    if a['placeholder']:
        add('fail', 'placeholder', 'placeholder copy: ' + '; '.join(f'"{x}"' for x in a['placeholder'][:4]))
    if len(a['fonts']) > 2:
        add('warn', 'fonts', f'{len(a["fonts"])} families: {", ".join(a["fonts"])}')
    if a['noAlt']:
        add('warn', 'alt', f'{a["noAlt"]} images with no alt')
    return res


def sheet(names, out, w, h):
    e = html.escape
    figs = ''.join(f'<figure><img src="{e(n)}.png" width="{w}" height="{h}"><figcaption>{e(n)}</figcaption></figure>' for n in names)
    page = os.path.join(out, 'screens.html')
    open(page, 'w', encoding='utf-8').write(
        '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#e9e7e3;font:14px system-ui,sans-serif}'
        '.row{display:flex;gap:32px;padding:32px;align-items:flex-start}figure{margin:0}img{display:block;border-radius:18px;'
        'box-shadow:0 0 0 1px #0002,0 12px 30px #0002;background:#fff}figcaption{margin-top:10px;color:#444;font-weight:600}</style></head>'
        f'<body><div class="row">{figs}</div></body></html>')
    W, H = 32 + len(names) * (w + 32), h + 100
    png = os.path.join(out, 'screens.png')
    return png if chromium_shot(page, png, W, H) else None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('files', nargs='+')
    ap.add_argument('--device', default='iphone')
    ap.add_argument('--platform', choices=list(PLATFORM))
    ap.add_argument('--out', default='screen-check')
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args()
    if a.device in DEVICES:
        w, h, plat = DEVICES[a.device]
    else:
        m = re.fullmatch(r'(\d+)x(\d+)', a.device)
        if not m:
            sys.exit(f'--device must be one of {", ".join(DEVICES)} or WxH')
        w, h, plat = int(m.group(1)), int(m.group(2)), 'web'
    plat = a.platform or plat
    if not find_chromium():
        sys.exit('No Chromium found. Install Playwright\'s (npx playwright install chromium) or chromium, or set HILDEGARD_CHROMIUM. '
                 'Without one, open each file in a browser at the device size and check the list in the docstring by eye.')
    os.makedirs(a.out, exist_ok=True)
    rep, failed, names = {'device': a.device, 'size': [w, h], 'platform': plat, 'screens': {}}, False, []
    for f in a.files:
        if not os.path.exists(f):
            sys.exit(f'no such file: {f}')
        n = os.path.splitext(os.path.basename(f))[0]
        names.append(n)
        chromium_shot(f, os.path.join(a.out, f'{n}.png'), w, h, scale=2)
        au = audit(f, w, h, plat) or {'error': 'the page did not finish loading in Chromium'}
        checks = judge(au, plat)
        failed |= any(s == 'fail' for s, _, _ in checks)
        rep['screens'][n] = {'checks': [{'state': s, 'check': k, 'message': m} for s, k, m in checks],
                             'audit': {k: v for k, v in au.items() if k != 'sizes'}}
        if not a.json:
            print(f'\n{n} ({w} x {h}, {plat})')
            for s, k, m in checks:
                print(f'  {s.upper():<4} {k}: {m}')
    rep['sheet'] = sheet(names, a.out, w, h)
    json.dump(rep, open(os.path.join(a.out, 'report.json'), 'w'), indent=1)
    if a.json:
        print(json.dumps(rep, indent=1))
    else:
        print(f'\nScreens: {rep["sheet"] or "(no sheet)"}. Look at every PNG at full size before you believe these lines.')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
