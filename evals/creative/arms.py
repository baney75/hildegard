# SPDX-License-Identifier: AGPL-3.0-only
"""arms.py: prepare the brand eval's skill arms and inputs.

  python3 arms.py [--skills ../../skills] [--tasks tasks-brand.json heldout-brand.json]

Writes into $EVAL_DIR (default ~/.cache/hildegard-creative-eval):
  arms/council/skills    this checkout's skills as they are
  arms/nocouncil/skills  the same skills with the council taken out: every <!-- council:start --> ... <!-- council:end -->
                         block, every table row that names hildegard-council or council.py, the hildegard-council skill,
                         and the council's script and rubrics in the skills that carry copies
  inputs/<task>/logo.svg the client's logo for each brand task, set with hildegard-brand's wordmark.py

respond.sh uses any arm folder here by name (`respond.sh council haiku l1-maumee-bee`). Prints what it removed, so a
reviewer can see that the two arms differ only by the council."""
import json, os, re, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
E = os.environ.get('EVAL_DIR', os.path.expanduser('~/.cache/hildegard-creative-eval'))
BLOCK = re.compile(r'<!-- council:start -->.*?<!-- council:end -->\n?', re.S)


def strip(text):
    out = BLOCK.sub('', text)
    lines = [l for l in out.split('\n') if not (l.lstrip().startswith('|') and re.search(r'hildegard-council|council\.py', l))]
    return '\n'.join(lines)


def main():
    a = sys.argv[1:]
    skills = os.path.abspath(a[a.index('--skills') + 1] if '--skills' in a else os.path.join(HERE, '..', '..', 'skills'))
    tasks = a[a.index('--tasks') + 1:] if '--tasks' in a else ['tasks-brand.json', 'heldout-brand.json']
    for arm in ('council', 'nocouncil'):
        dst = os.path.join(E, 'arms', arm, 'skills')
        shutil.rmtree(dst, ignore_errors=True)
        shutil.copytree(skills, dst, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    no = os.path.join(E, 'arms', 'nocouncil', 'skills')
    shutil.rmtree(os.path.join(no, 'hildegard-council'))
    removed = ['hildegard-council/']
    for root, _, files in os.walk(no):
        for f in files:
            p = os.path.join(root, f)
            rel = os.path.relpath(p, no)
            if f in ('council.py', 'rubrics.md'):
                os.remove(p)
                removed.append(rel)
            elif f.endswith('.md'):
                t = open(p, encoding='utf-8').read()
                s = strip(t)
                if s != t:
                    open(p, 'w', encoding='utf-8').write(s)
                    removed.append(f'{rel}: {len(t) - len(s)} characters')
    left = subprocess.run(['grep', '-rliE', r'hildegard-council|council\.py|rubrics\.md|\bthe council\b|\bcouncil\b (protocol|step|round)', no], capture_output=True, text=True).stdout.split()
    print('nocouncil arm, removed:\n  ' + '\n  '.join(removed))
    if left:
        sys.exit('the word "council" is still in: ' + ', '.join(left))
    wm = os.path.join(skills, 'hildegard-brand', 'scripts', 'wordmark.py')
    for f in tasks:
        for t in json.load(open(os.path.join(HERE, f))):
            if t['domain'] != 'brand':
                continue
            d = os.path.join(E, 'inputs', t['id'])
            os.makedirs(d, exist_ok=True)
            lg = t['logo']
            subprocess.run([sys.executable, wm, lg['text'], '--family', lg['family'], '--weight', str(lg['weight']),
                            '--color', lg['color'], '--out', os.path.join(d, 'logo.svg')], check=True, capture_output=True)
            for junk in ('logo-flipped.png', 'logo-spacing.json'):
                if os.path.exists(os.path.join(d, junk)):
                    os.remove(os.path.join(d, junk))
            print('input', t['id'], 'logo.svg')


if __name__ == '__main__':
    main()
