#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Lint prose for the tells that make writing read as machine-made. Stdlib only, plain python3.

  python3 prose_lint.py FILE [FILE...]     lint files; "-" reads stdin
  python3 prose_lint.py --json FILE        the lint as JSON, the shape of ProseLint in packages/craft/src/prose.ts
  python3 prose_lint.py --max 10 FILE      show up to 10 places per finding (default 6)

Run it on every piece of prose before anyone reads it: a blog post, an email, a page, a caption, a script. Fix every
fail. Fix each warn too, unless it is the writer's deliberate voice. Lint again until it passes. Exit status is 1
when any input fails and 0 otherwise. With several inputs, --json prints a list of {file, ok, words, findings}.

It checks words a person reads, not image or video prompts. The rules live in prose_rules.json beside this file; the
same file feeds packages/craft/src/prose.ts, which this script reproduces rule for rule (same ids, severities, texts,
and 1-based line and column). packages/craft/test/prose-py.test.ts runs both on shared cases and the repo's docs.

Differences from the TypeScript engine, all at the edges of Unicode:
  - JavaScript's \\p{L}, \\p{N}, \\p{Lu} and \\p{Ll} become [^\\W\\d_] and [^\\W_] (letters and digits, which also
    admit a few numeric symbols like "²") and unicodedata categories for the capitals.
  - Offsets, lines and columns count UTF-16 units, as JavaScript does, so an emoji is two columns wide.
  - describe's 60-character cut counts code points, so it never splits an emoji.
"""
import argparse
import json
import math
import os
import re
import sys
import unicodedata
from bisect import bisect_left

RULES = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "prose_rules.json"), encoding="utf-8"))

# JavaScript's \s, written out: Python's differs at a few control characters and U+FEFF.
WS = r"\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
S = f"[{WS}]"
NS = f"[^{WS}]"
SNL = f"[{WS.replace(chr(92) + 'n', '')}]"  # \s without the newline: JavaScript's [^\S\n]
JS_WS = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
EOL = "\n\r\u2028\u2029"
LET = r"[^\W\d_]"  # \p{L}
LINE_START = f"(?<![^{EOL}])"  # ^ with the m flag
FLAGS = re.ASCII  # \w, \b and \d mean ASCII, as in JavaScript (no u flag)


def rx(pattern, extra=0):
    return re.compile(pattern, FLAGS | extra)


def js_pattern(p):
    """A rules-file pattern with JavaScript's meaning for '.', which stops at any line terminator."""
    out, i, in_class = [], 0, False
    while i < len(p):
        c = p[i]
        if c == "\\":
            out.append(p[i : i + 2])
            i += 2
            continue
        if in_class:
            in_class = c != "]"
        elif c == "[":
            in_class = True
        elif c == ".":
            out.append(f"[^{EOL}]")
            i += 1
            continue
        out.append(c)
        i += 1
    return "".join(out)


def jstrip(s):
    return s.strip(JS_WS)


class Text:
    """The text as given, with where its lines start and where UTF-16 pairs fall, to report JavaScript's offsets."""

    def __init__(self, text):
        self.text = text
        self.nl = [i for i, c in enumerate(text) if c == "\n"]
        self.astral = [i for i, c in enumerate(text) if ord(c) > 0xFFFF]

    def u16(self, i):
        return i + bisect_left(self.astral, i) if self.astral else i

    def on_heading(self, prose, index):
        """True when the line `index` is on is a Markdown heading. The marker is at most ten characters in."""
        before = bisect_left(self.nl, index)
        start = self.nl[before - 1] + 1 if before else 0
        return LINE_HEADING.match(prose[start : start + 10]) is not None

    def locate(self, index, match):
        before = bisect_left(self.nl, index)
        last = self.u16(self.nl[before - 1]) if before else -1
        at = self.u16(index)
        return {"text": match, "index": at, "line": before + 1, "column": at - last}

    def all(self, rx_, prose, skip=None):
        return [
            self.locate(m.start(), self.text[m.start() : m.end()])
            for m in rx_.finditer(prose)
            if not (skip and skip(prose, m.start(), m.group(0)))
        ]


def blank(m):
    return re.sub(r"[^\n]", " ", m)


BLOCK_CLOSE = rx(r"</(script|style|code|pre)>", re.I)
BLOCK_OPEN = rx(r"<(script|style|code|pre)\b", re.I)


def blank_blocks(text):
    """<script>, <style>, <code> and <pre> through their closing tag, blanked; one with no closing tag is left alone.

    The plain pattern `<(script|style|code|pre)\\b[\\s\\S]*?</\\1>` scans to the end of the text from every unclosed
    opener, so this looks for each tag's last closing tag once and skips the openers after it."""
    last = {}
    for m in BLOCK_CLOSE.finditer(text):
        last[m.group(1).lower()] = m.start()
    out, at, pos = [], 0, 0
    while True:
        m = BLOCK_OPEN.search(text, pos)
        if not m:
            break
        name = m.group(1).lower()
        if last.get(name, -1) <= m.start():
            pos = m.end()
            continue
        c = rx(rf"</{name}>", re.I).search(text, m.end())
        out.append(text[at : m.start()] + blank(text[m.start() : c.end()]))
        at = pos = c.end()
    return "".join(out) + text[at:]


def when_closed(blanked):
    """A replacement that blanks only the first alternative's match; the other alternatives consume what can't match."""
    return lambda m: blanked(m.group(0)) if m.group(1) else m.group(0)


def blank_non_prose(text):
    """Code, URLs, link targets and HTML that isn't prose, blanked to spaces of the same length.

    The image, tag and link patterns each have a second alternative that consumes the doomed rest of the line when
    the closer is missing, as prose.ts does: otherwise '<<<<...' fails from every opener and rescans the line."""
    b = lambda m: blank(m.group(0))
    text = rx(r"\A---\n[\s\S]*?\n---\n").sub(b, text)
    text = rx(r"```[\s\S]*?```").sub(b, text)
    text = rx(r"~~~[\s\S]*?~~~").sub(b, text)
    # Inline code reads as one word in its sentence: "call `lint_writing` on it" is not a fragment.
    text = rx(r"`[^`]{0,400}?`").sub(lambda m: "x" + blank(m.group(0)[1:]), text)
    # ![alt](target). Not closed: no ] on the line, a ] with no ( after it, or a ( with no ) after it.
    text = rx(r"(!\[[^\]\n]*\]\([^)\n]*\))|!\[[^\]\n]*\](?!\()|!\[[^\]\n]*(?=\n|\Z)|!\[[^\]\n]*\]\([^\n]*").sub(
        when_closed(blank), text
    )
    text = blank_blocks(text)
    # <tag>. Not closed: "<>", or no > on the rest of the line.
    text = rx(r"(<[^>\n]+>)|<>|<[^\n]*").sub(when_closed(blank), text)
    # ](target). Not closed: no ) on the rest of the line.
    text = rx(r"(\]\([^)\n]*\))|\]\([^\n]*").sub(when_closed(lambda s: "](" + blank(s[2:])), text)
    text = rx(rf"https?://[^{WS})>\]]+").sub(b, text)
    return text


def unquote(prose):
    return rx(r"\"[^\"\n]{1,80}\"|“[^”\n]{1,80}”").sub(lambda m: blank(m.group(0)), prose)


def is_name(prose, index, match):
    """A match that starts with a capital in the middle of a sentence (after a lowercase letter, a comma or a
    semicolon and a space, as count_specifics reads it) is a name, not the word: "Pastor Mike Foster", "Beacon Street".
    Only the exemptNames rules use it, and never on a heading, where Title Case capitalises every word."""
    return (
        unicodedata.category(match[0]) == "Lu"
        and index >= 2
        and prose[index - 1] == " "
        and (unicodedata.category(prose[index - 2]) == "Ll" or prose[index - 2] in ",;")
    )


def bounded(p):
    return rx(rf"(?<![\w-])(?:{js_pattern(p)})(?![\w-])", re.I)


WORD = re.compile(r"[^\W_](?:[^\W_]|['’-])*")


def count_words(s):
    return len(WORD.findall(s))


# [^\S\n]*, not \s*: the lookahead must stop at the line's end, or a run of blank lines is rescanned from every line.
PARA = rx(r"[^\n]+(?:\n(?!" + SNL + r"*\n)[^\n]+)*")


def paragraphs(prose):
    return [(m.group(0), m.start()) for m in PARA.finditer(prose) if jstrip(m.group(0))]


HEADING = rx(rf"\A{S}{{0,3}}#{{1,6}}{S}")
LINE_HEADING = rx(rf"\A{SNL}{{0,3}}#{{1,6}}{S}")
LIST = rx(rf"\A{S}{{0,3}}(?:[-*+]|\d+[.)]){S}")
# One sentence: its first character, then up to the first whole run of . ! or ? that ends a word. After the first
# character the run must start where it begins, or a greedy run is retried from every character of 'a!!!!...!b'.
_RUN = rf"[.!?]+(?![.!?])[\"”’)]*(?={S}|\Z)"
SENTENCE = rx(rf"{NS}(?:(?:{_RUN}|\Z)|[\s\S]*?(?:(?<![.!?]){_RUN}|\Z))")


def sentences(prose):
    """Sentences of running prose (not headings or list items): (text, index, words)."""
    out = []
    for ptext, pindex in paragraphs(prose):
        if HEADING.match(ptext) or LIST.match(ptext):
            continue
        for m in SENTENCE.finditer(ptext):
            t = jstrip(m.group(0))
            if not t:
                continue
            lead = len(m.group(0)) - len(m.group(0).lstrip(JS_WS))
            out.append((t, pindex + m.start() + lead, count_words(t)))
    return out


EMOJI_LINE = rx(
    rf"{LINE_START}{S}{{0,3}}(?:#{{1,6}}{S}*|[-*+]{S}+|\d+\.{S}+)?"
    r"[\U0001F300-\U0001FAFF\u2600-\u27bf\u2b50\u2705\u274c]"
)
NOT_BUT = [
    # Only the contrasts a writer sets up, not an everyday hedge: "not about rules, but", never "not cheap, but".
    rx(
        r"\b(?:not|isn['’]?t|aren['’]?t|wasn['’]?t|weren['’]?t) (?:about|just|only|merely|simply|a|an|the|because|that)\b"
        + f"[^.\\n]{{1,60}}?,{S}*but\\b",
        re.I,
    ),
    rx(rf"\b(?:it|this|that)['’]?s not\b[^.\n]{{1,60}}[.;]{S}+(?:it|this|that)['’]?s\b", re.I),
    rx(rf"\b(?:it|this|that) (?:is|was) not\b[^.\n]{{1,60}}[.;]{S}+(?:it|this|that) (?:is|was)\b", re.I),
    rx(rf"\bnot (?:just|only|merely) [^.\n]{{1,60}}?,?{S}+but(?: also)?\b", re.I),
    rx(rf"\byou (?:don['’]?t|do not) need [^.\n]{{1,60}}\.{S}+you need\b", re.I),
    rx(rf"\bthe (?:question|problem|issue|point) (?:isn['’]?t|is not) [^.\n]{{1,60}}[.,;]{S}+(?:it['’]?s|it is)\b", re.I),
]
NEGATIVE_LIST = rx(
    rf"(?:{LINE_START}|[.!?]{S}+)(Not an? [^.!?\n]{{1,40}}\.{S}+Not an? [^.!?\n]{{1,40}}\.)", re.I
)
ING_TAIL = rx(
    rf",{S}+(?:highlighting|underscoring|reflecting|showcasing|emphasizing|emphasising|demonstrating|signaling"
    r"|signalling|illustrating|cementing|solidifying|reinforcing|symbolizing)\b",
    re.I,
)
COLON_REVEAL = rx(
    rf"(?:{LINE_START}|[.!?]{S}+)((?:The|My|Our|Their|One|Here['’]s|What) (?:[\w'’-]+ ){{0,5}}"
    r"(?:detail|part|secret|trick|catch|twist|kicker|answer|truth|reason|result|difference|fix|best part"
    rf"|worst part|key|something|one thing)\b[^.:!?\n]{{0,40}}: [a-z])"
)
# An em dash anywhere; an en dash or a double hyphen only between words, never in a range like 9 - 5.
DASHES = re.compile(rf"\u2014|(?:(?<={LET})|(?<={LET},)) (?:\u2013|--) (?={LET})")
BOLD = rx(r"\*\*[^*\n]+\*\*|__[^_\n]+__")
LW = r"(?:[^\W\d_]|['’-])"
# "sleep, reading, play, or dinner": a list of three or more, the rhythm generated prose falls into.
TRIAD = re.compile(rf"(?<![\w'’-]){LW}+(?: {LW}+){{0,3}}, {LW}+(?: {LW}+){{0,3}},? (?:and|or) {LW}+")
BOLD_LEAD = rx(rf"\A{S}*(?:\*\*|__)[^*_\n]{{2,80}}(?:\*\*|__)")
NUMBER = rx(r"\b\d[\d,.:]*\b")
ENDING = rx(rf"\A{S}*(?:ultimately|overall|in the end|in conclusion|in summary|to sum up|all in all)\b[,:]?", re.I)


def count_specifics(unquoted):
    """Numbers, and capitalised words that don't start a sentence: the names, dates and amounts a real piece is made of."""
    n = len(NUMBER.findall(unquoted))
    for m in re.finditer(" ", unquoted):
        j = m.start()
        if j < 1 or j + 2 >= len(unquoted):
            continue
        prev, c, nxt = unquoted[j - 1], unquoted[j + 1], unquoted[j + 2]
        if (unicodedata.category(prev) == "Ll" or prev in ",;") and unicodedata.category(c) == "Lu" and unicodedata.category(nxt) == "Ll":
            n += 1
    return n


def is_marker_word(m):
    return re.fullmatch("[A-Z]+", m) is not None


def lint_prose(text):
    """Lint words a person will read. `ok` is False when any finding fails."""
    t = Text(text)
    prose = blank_non_prose(text)
    words = count_words(prose)
    findings = []

    def add(id_, severity, why, fix, matches):
        if matches:
            findings.append({"id": id_, "severity": severity, "why": why, "fix": fix, "matches": matches})

    unquoted = unquote(prose)
    name_not_heading = lambda p, i, m: is_name(p, i, m) and not t.on_heading(p, i)
    for id_, rule in RULES["phrases"].items():
        skip = name_not_heading if rule.get("exemptNames") else None
        matches = sorted(
            [m for p in rule["patterns"] for m in t.all(bounded(p), unquoted, skip)], key=lambda m: m["index"]
        )
        if "density" in rule and len(matches) / max(1, words) <= rule["density"]:
            continue
        add(id_, rule["severity"], rule["why"], rule["fix"], matches)

    # Dashes: none in short copy, a couple in a long piece, never two in one paragraph.
    dashes = t.all(DASHES, prose)
    if dashes:
        d = RULES["dashes"]
        crowded = any(len(DASHES.findall(p)) > d["perParagraph"] for p, _ in paragraphs(prose))
        fail = words <= d["shortWords"] or len(dashes) > d["perDocument"] or crowded
        add(
            "dashes",
            "fail" if fail else "warn",
            "Dashes as a rhythm crutch are the best-known tell of generated prose.",
            "Use a full stop, a comma, a colon or parentheses. Keep a dash only where nothing else works.",
            dashes,
        )

    not_but = sorted([m for re_ in NOT_BUT for m in t.all(re_, prose)], key=lambda m: m["index"])
    if not_but:
        add(
            "not-but",
            "fail" if len(not_but) > RULES["notBut"]["perDocument"] else "warn",
            "“It’s not X, it’s Y” contrasts set up a point the writer could just make.",
            "State Y directly.",
            not_but,
        )

    add(
        "negative-list",
        "fail",
        "“Not a X. Not a Y.” builds suspense the reader didn’t ask for.",
        "Say what it is.",
        [t.locate(m.start(1), text[m.start(1) : m.end(1)]) for m in NEGATIVE_LIST.finditer(prose)],
    )

    add(
        "ing-tail",
        "fail",
        "A trailing “-ing” clause that claims meaning instead of explaining it.",
        "Say what actually follows, or end the sentence.",
        t.all(ING_TAIL, prose),
    )

    reveals = []
    for m in COLON_REVEAL.finditer(prose):
        line_start = prose.rfind("\n", 0, m.start() + 1) + 1
        if not LIST.match(prose[line_start:]):
            reveals.append(t.locate(m.start(1), text[m.start(1) : m.end(1)]))
    add(
        "colon-reveal",
        "warn",
        "A noun phrase, a colon, then a reveal: fake drama.",
        "Write it as a plain sentence. Keep colons for lists, labels and quotes.",
        reveals,
    )

    said = sentences(prose)
    run, max_words = RULES["fragments"]["run"], RULES["fragments"]["maxWords"]
    frags = []
    start = -1
    for i in range(len(said) + 1):
        if i < len(said) and 0 < said[i][2] <= max_words:
            if start < 0:
                start = i
            continue
        if start >= 0 and i - start >= run:
            frags.append(t.locate(said[start][1], " ".join(s[0] for s in said[start:i])))
        start = -1
    add(
        "fragments",
        "warn",
        "Stacked short fragments, “That’s it. That’s the whole thing.”, read as a performance.",
        "Join them into full sentences.",
        frags,
    )

    lengths = [s[2] for s in said if s[2] > 0]
    if len(lengths) >= RULES["rhythm"]["minSentences"]:
        mean = sum(lengths) / len(lengths)
        sq = 0.0
        for n in lengths:  # a plain loop: sum() on floats rounds differently from JavaScript's reduce
            sq += (n - mean) * (n - mean)
        sd = math.sqrt(sq / len(lengths))
        if sd / mean < RULES["rhythm"]["minSpread"]:
            add(
                "rhythm",
                "warn",
                f"Every sentence runs about {math.floor(mean + 0.5)} words. Even length is a machine rhythm.",
                "Vary it where the point allows: a short sentence for weight, a longer one to carry a thought through.",
                [t.locate(said[0][1], said[0][0])],
            )

    paras = [p for p in paragraphs(prose) if not HEADING.match(p[0])]
    if paras and len(paras) > 2 and ENDING.match(paras[-1][0]):
        ptext, pindex = paras[-1]
        add(
            "summary-ending",
            "fail",
            "The last paragraph sums up what the reader just read.",
            "End on the last concrete point, or on what to do next.",
            [t.locate(pindex, jstrip(ptext).split("\n")[0])],
        )

    triads = t.all(TRIAD, prose)
    tr = RULES["triads"]
    if words >= tr["minWords"] and (len(triads) * 100) / words > tr["perHundred"]:
        add(
            "triads",
            "warn",
            f"{len(triads)} lists of three or more in {words} words. Generated prose falls into that rhythm.",
            "Keep the lists that are real lists. Elsewhere, name the one thing that matters.",
            triads,
        )

    bl = RULES["boldLeads"]
    leads = [p for p in paras if BOLD_LEAD.match(p[0])]
    if len(leads) >= bl["min"] and len(leads) / len(paras) >= bl["share"]:
        add(
            "bold-leads",
            "warn",
            "Paragraph after paragraph opens on a bold label, like slides.",
            "Write paragraphs that lead with their point, or use real headings if it is a reference page.",
            [t.locate(p[1], jstrip(BOLD_LEAD.match(p[0]).group(0))) for p in leads],
        )

    sp = RULES["specifics"]
    specifics = count_specifics(unquoted)
    if words >= sp["minWords"] and (specifics * 100) / words < sp["perHundred"] and said:
        add(
            "specifics",
            "warn",
            f"Only {specifics} names, numbers or dates in {words} words. A piece with none could be about anyone.",
            "Add the specific: who, where, how many, which year, what it cost.",
            [t.locate(said[0][1], said[0][0])],
        )

    add(
        "emoji-heading",
        "fail",
        "Emoji as section markers.",
        "Delete them. Headings carry the structure.",
        t.all(EMOJI_LINE, prose),
    )

    bold = []
    for ptext, pindex in paras:
        if LIST.match(ptext) or re.match(rf"{S}*\|", ptext):
            continue
        hits = list(BOLD.finditer(ptext))
        if len(hits) > RULES["bold"]["perParagraph"]:
            bold.extend(t.locate(pindex + h.start(), h.group(0)) for h in hits)
    add("bold", "warn", "Bold sprinkled through a paragraph shouts.", "Let the sentence carry the weight.", bold)

    unfinished = []
    for m in RULES["markers"]:
        upper = is_marker_word(m)
        pattern = rx(rf"\b{m}\b" if upper else js_pattern(m), 0 if upper else re.I)
        unfinished.extend(t.all(pattern, unquoted))
    unfinished.sort(key=lambda m: m["index"])
    add("unfinished", "fail", "Placeholder text left in.", "Write the real words, or cut the line.", unfinished)

    return {"ok": not any(f["severity"] == "fail" for f in findings), "words": words, "findings": findings}


def describe_prose_lint(lint, max_matches=6):
    """The lint as lines a person or an agent reads: each finding, where it is, and what to do."""
    if not lint["findings"]:
        return f"Clean: no tells in {lint['words']} words."
    fails = sum(1 for f in lint["findings"] if f["severity"] == "fail")
    if lint["ok"]:
        head = f"Passes, with {len(lint['findings'])} to weigh ({lint['words']} words)."
    else:
        head = f"Fails: {fails} {'tell' if fails == 1 else 'tells'} to fix ({lint['words']} words)."
    lines = [head]
    for f in lint["findings"]:
        where = "; ".join(
            "{}:{} “{}”".format(m["line"], m["column"], m["text"][:57] + "…" if len(m["text"]) > 60 else m["text"])
            for m in f["matches"][:max_matches]
        )
        more = f" and {len(f['matches']) - max_matches} more" if len(f["matches"]) > max_matches else ""
        lines.append(f"- {f['severity']} {f['id']}: {f['why']} {f['fix']} At {where}{more}.")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description="Lint prose for the tells of machine-made writing.")
    ap.add_argument("files", nargs="+", metavar="FILE", help='files to lint; "-" reads stdin')
    ap.add_argument("--json", action="store_true", help="print the lint as JSON")
    ap.add_argument("--max", type=int, default=6, help="places shown per finding (default 6)")
    a = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    results = []
    for f in a.files:
        raw = sys.stdin.buffer.read() if f == "-" else open(f, "rb").read()
        results.append((f, lint_prose(raw.decode("utf-8", errors="replace"))))
    if a.json:
        out = results[0][1] if len(results) == 1 else [{"file": f, **l} for f, l in results]
        print(json.dumps(out, ensure_ascii=False, indent=2))
    else:
        for i, (f, l) in enumerate(results):
            if len(results) > 1:
                print(("\n" if i else "") + ("stdin" if f == "-" else f))
            print(describe_prose_lint(l, a.max))
    return 1 if any(not l["ok"] for _, l in results) else 0


if __name__ == "__main__":
    sys.exit(main())
