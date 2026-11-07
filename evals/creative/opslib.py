# SPDX-License-Identifier: AGPL-3.0-only
"""Shared by score_ops.py and report_ops.py: reads a responder's transcript into commands, outputs and the final answer, and a
few text helpers for checking an answer's facts."""
import json, os, re

CODE_RX = re.compile(r'\bHG-(?!XXXX)[A-Z0-9]{4}-[A-Z0-9]{4}\b|hgc1_[A-Za-z0-9_-]{16,}')
SENT_RX = re.compile(r'(?<=[.!?])\s+|\n+|\s+[-•*]\s+')
# words that make a sentence not a claim that something happened
NOT_DONE = re.compile(r"\b(not|n't|no|nothing|never|without|none|yet|until|once|unless|waiting|will|would|after|before|if|when|whenever|can|could|ready to|need|needs|once you|should|then|afterwards|later|next)\b", re.I)
OFFLINE_RX = re.compile(r"\b(offline|off-line|not answering|isn[’']t answering|no(?:t)? respon\w*|unreachable|unavailable|not available|not reachable|can[’']?t reach|down|powered[\s-]off|switched[\s-]off|turned[\s-]off|shut[\s-]?down|is off|not online|not running|isn[’']t running|asleep)\b", re.I)
ONLINE_RX = re.compile(r"\b(online|answers?|answering|reachable|up and running|is up|running|responds?|responding|available|connected|healthy)\b", re.I)
NEG_RX = re.compile(r"\b(not|no|never|cannot|unreachable)\b|n[’']t\b", re.I)
CLAUSE_RX = re.compile(r'[;,]\s*|\s+(?:and|but|while|whereas)\s+', re.I)
MODEL_RX = {
    'wan-2-2-ti2v-5b': r'wan[\s-]*2[\s.\-]*2|ti2v',
    'flux-2-klein-4b': r'flux',
    'z-image-turbo': r'z[\s-]*image',
    'qwen-image-2512': r'qwen[\s-]*image(?![\s-]*edit)|2512',
    'qwen-image-edit-2511': r'qwen[\s-]*image[\s-]*edit|2511',
    'ltx-2-5-distilled': r'ltx[\s-]*2[\s.\-]*5',
    'ltx-2-distilled': r'ltx[\s-]*2(?![\s.\-]*5)',
}


def sentences(text):
    return [s.strip() for s in SENT_RX.split(text or '') if s.strip()]


def mentions(text, model_id):
    return bool(re.search(MODEL_RX[model_id], text or '', re.I))


def affirmed(text, model_id):
    """True when a sentence mentions the model without a negation or condition: the answer says it is there/was done."""
    return any(mentions(s, model_id) and not NOT_DONE.search(s) for s in sentences(text))


def parse_transcript(model, run):
    """-> {commands: [{cmd, out}], writes: [{path, content}], final} from transcript.jsonl (Claude stream-json or Codex --json)."""
    commands, writes, pending = [], [], {}
    path = os.path.join(run, 'transcript.jsonl')
    lines = open(path, errors='replace').read().splitlines() if os.path.exists(path) else []
    for line in lines:
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if model == 'haiku':
            if d.get('type') == 'assistant':
                for c in d.get('message', {}).get('content', []):
                    if c.get('type') != 'tool_use':
                        continue
                    i = c.get('input', {})
                    if c['name'] == 'Bash':
                        rec = {'cmd': i.get('command', ''), 'out': ''}
                        commands.append(rec)
                        pending[c['id']] = rec
                    elif c['name'] == 'Write':
                        writes.append({'path': i.get('file_path', ''), 'content': i.get('content', '')})
            elif d.get('type') == 'user':
                m = d.get('message', {})
                for c in m.get('content', []) if isinstance(m.get('content'), list) else []:
                    if c.get('type') == 'tool_result' and c.get('tool_use_id') in pending:
                        body = c.get('content')
                        if isinstance(body, list):
                            body = '\n'.join(b.get('text', '') for b in body if isinstance(b, dict))
                        pending[c['tool_use_id']]['out'] = body or ''
        else:
            it = d.get('item') or {}
            if d.get('type') == 'item.completed':
                if it.get('type') == 'command_execution':
                    commands.append({'cmd': it.get('command', ''), 'out': it.get('aggregated_output', '') or ''})
                elif it.get('type') == 'file_change':
                    writes.append({'path': json.dumps(it.get('changes', [])), 'content': ''})
    final = open(os.path.join(run, 'final.txt'), errors='replace').read() if os.path.exists(os.path.join(run, 'final.txt')) else ''
    return {'commands': commands, 'writes': writes, 'final': final}


def text_files(root, limit=2_000_000):
    """(path, text) for every small text file under root."""
    out = []
    for dp, _dn, fn in os.walk(root):
        for f in fn:
            p = os.path.join(dp, f)
            try:
                if os.path.getsize(p) > limit:
                    continue
                data = open(p, 'rb').read()
                if b'\0' in data[:2000]:
                    continue
                out.append((p, data.decode(errors='replace')))
            except OSError:
                pass
    return out


def amounts_gb(text):
    """Every size in the text as decimal gigabytes and as GiB: [(value, unit-as-written)]."""
    out = []
    for m in re.finditer(r'(\d+(?:[.,]\d+)?)\s*(TB|TiB|GB|GiB|G|MB|MiB)\b', text or ''):
        v = float(m.group(1).replace(',', '.'))
        u = m.group(2)
        out.append((v * (1000 if u in ('TB', 'TiB') else 1 if u in ('GB', 'G', 'GiB') else 0.001), u))
    return out


def _state(text, dev):
    t = text.replace(dev, ' ')
    if OFFLINE_RX.search(t) or (NEG_RX.search(t) and not re.search(r'not (offline|down)', t, re.I)):
        return 'off'
    if ONLINE_RX.search(t):
        return 'on'
    return None


def device_state(text, dev):
    """'on', 'off' or None: what the answer says about one device, read clause by clause so that "gpu-box is online and old-pc
    is not answering" gives each its own."""
    for s in sentences(text):
        if dev not in s:
            continue
        parts = [c for c in CLAUSE_RX.split(s) if c]
        for i, c in enumerate(parts):
            if dev not in c:
                continue
            ahead = lambda k: ' '.join(parts[i:i + k + 1])
            for probe in (c, ahead(1), ahead(2)):
                st = _state(probe, dev)
                if st:
                    return st
        # "The laptop was set to render on gpu-box, your desktop. It is switched off, so ...": the state is in the next sentence
        k = sentences(text).index(s)
        nxt = sentences(text)[k + 1] if k + 1 < len(sentences(text)) else ''
        if re.match(r'(it|that|this|the (desktop|machine|computer|device|pc|box))\b', nxt, re.I):
            st = _state(nxt, dev)
            if st:
                return st
    return None


KEEP_RX = re.compile(r"\b(kept|keep|keeping|keeps|left|leave|leaving|untouched|intact|still|preserved|safe|unchanged|not|n't|no|never)\b", re.I)
REMOVE_RX = re.compile(r"\b(remov\w*|delet\w*|freed|erased|wiped|deleted|gone|cleared)\b", re.I)


def claims_removed(text, model_id):
    """True when one clause of the answer says the model was removed (not kept, not left alone)."""
    for s in sentences(text):
        for c in CLAUSE_RX.split(s):
            if mentions(c, model_id) and REMOVE_RX.search(c) and not KEEP_RX.search(c):
                return True
    return False
