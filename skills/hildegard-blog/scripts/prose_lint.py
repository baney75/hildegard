#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Lint prose for the tells that make writing read as machine-made. Stdlib only, plain python3.

  python3 prose_lint.py FILE [FILE...]     lint files; "-" reads stdin
  python3 prose_lint.py --json FILE        the lint as JSON, the shape of ProseLint in packages/craft/src/prose.ts
  python3 prose_lint.py --max 10 FILE      show up to 10 places per finding (1 or more, default 6)
  python3 prose_lint.py --strict FILE      for writing that must carry no tells: the em dash and every other wording or
                                           shape warn (not headings) fails too. The default only warns on them.

Run it on every piece of prose before anyone reads it: a blog post, an email, a page, a caption, a script. Fix every
fail. Fix each warn too, unless it is the writer's deliberate voice. Lint again until it passes. Exit status is 1
when any input fails, 0 when all pass, and 2 for bad usage or a file that can't be read. With several inputs, --json
prints a list of {file, ok, words, findings}.

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


NEWLINE = re.compile("\n")
ASTRAL = re.compile("[\U00010000-\U0010ffff]")


class Text:
    """The text as given, with where its lines start and where UTF-16 pairs fall, to report JavaScript's offsets."""

    def __init__(self, text):
        self.text = text
        self.nl = [m.start() for m in NEWLINE.finditer(text)]
        self.astral = [m.start() for m in ASTRAL.finditer(text)]

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
    # Front matter: after an optional byte order mark, with either line ending, and at the end of the text.
    text = rx(r"\A\ufeff?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|\Z)").sub(b, text)
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
    text = rx(r"(<(?!(?:insert|your|add)\s)[^>\n]+>)|<(?:insert|your|add)\s[^>\n]+>|<>|<[^\n]*").sub(when_closed(blank), text)
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


def needle_of(p):
    """The lowercase text every match of `p` must begin with, or "" when the pattern doesn't open on plain letters: its
    leading run of letters, digits, spaces and hyphens, less the last character when a quantifier makes that optional.
    A pattern with a bar outside its groups has no such prefix."""
    depth, in_class, i = 0, False, 0
    while i < len(p):
        c = p[i]
        if c == "\\":
            i += 1
        elif in_class:
            in_class = c != "]"
        elif c == "[":
            in_class = True
        elif c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
        elif c == "|" and depth == 0:
            return ""
        i += 1
    run = re.match(r"[a-zA-Z0-9 -]*", p).group(0)
    nxt = p[len(run) : len(run) + 1]
    return (run[:-1] if nxt in ("?", "*", "{") else run).lower()


class Phrase:
    """One phrase pattern, compiled once, with the text its matches begin with."""

    def __init__(self, rule, p):
        self.rule = rule
        self.rx = bounded(p)
        self.needle = needle_of(p)


# Every phrase pattern, in rule order and then pattern order, compiled once.
COMPILED = [Phrase(rule_id, p) for rule_id, rule in RULES["phrases"].items() for p in rule["patterns"]]


def trie_regex(words):
    """A prefix tree of the needles as a regex, so each position is tried against a handful of letters, not 170 words."""
    root = {}
    for w in words:
        n = root
        for c in w:
            n = n.setdefault(c, {})
        n[""] = True

    def rx_(n):
        alts = [re.escape(c) + rx_(n[c]) for c in sorted(n) if c != ""]
        if not alts:
            return ""
        # A node that also ends a needle makes the rest optional.
        if "" in n:
            return "(?:" + "|".join(alts) + ")?"
        return alts[0] if len(alts) == 1 else "(?:" + "|".join(alts) + ")"

    return rx_(root)


# Word starts where some pattern's needle begins. Zero-width, so every start is found, overlaps included.
STARTS = rx(r"(?<![\w-])(?=" + trie_regex(sorted({c.needle for c in COMPILED if c.needle})) + ")", re.I)
# The patterns whose needle begins with each character.
BY_FIRST = {}
for _i, _c in enumerate(COMPILED):
    if _c.needle:
        BY_FIRST.setdefault(_c.needle[0], []).append(_i)


def phrase_hits_naive(prose):
    """Every match of every phrase pattern, as finditer finds them one pattern at a time: the reference."""
    return [list(c.rx.finditer(prose)) for c in COMPILED]


def phrase_hits(prose):
    """The same hits, found fast. Most patterns open on fixed letters (their needle), so one pass finds the word starts
    where any needle begins, and a pattern's regex is tried only at a start whose first letter is its own: leftmost,
    non-overlapping, exactly what scanning the whole text with that pattern gives. The needle is checked against the
    lowercased text first when that text has the same length (a few capitals change length when lowercased); the check
    can only skip a place where the regex would fail anyway."""
    out = [[] for _ in COMPILED]
    lower = prose.lower()
    exact = len(lower) == len(prose)
    end = [0] * len(COMPILED)
    for i, c in enumerate(COMPILED):
        if not c.needle:
            out[i] = list(c.rx.finditer(prose))
    for m in STARTS.finditer(prose):
        at = m.start()
        for i in BY_FIRST.get(lower[at] if exact else prose[at].lower(), ()):
            c = COMPILED[i]
            if at < end[i] or (exact and not lower.startswith(c.needle, at)):
                continue
            hit = c.rx.match(prose, at)
            if hit:
                end[i] = hit.end()
                out[i].append(hit)
    return out


WORD = re.compile(r"[^\W_](?:[^\W_]|['’-])*")


def count_words(s):
    return len(WORD.findall(s))


# [^\S\n]*, not \s*: the lookahead must stop at the line's end, or a run of blank lines is rescanned from every line.
PARA = rx(r"[^\n]+(?:\n(?!" + SNL + r"*\n)[^\n]+)*")


def paragraphs(prose):
    """(text, index, words) for each block between blank lines."""
    return [(m.group(0), m.start(), count_words(m.group(0))) for m in PARA.finditer(prose) if jstrip(m.group(0))]


HEADING = rx(rf"\A{S}{{0,3}}#{{1,6}}{S}")
LINE_HEADING = rx(rf"\A{SNL}{{0,3}}#{{1,6}}{S}")
LIST = rx(rf"\A{S}{{0,3}}(?:[-*+]|\d+[.)]){S}")
EMOJI_LINE = rx(
    rf"{LINE_START}{S}{{0,3}}(?:#{{1,6}}{S}*|[-*+]{S}+|\d+\.{S}+)?"
    r"[\U0001F300-\U0001FAFF\u2600-\u27bf\u2b50\u2705\u274c]"
)
NOT_BUT = [
    # Only the contrasts a writer sets up, not an everyday hedge: "not about rules, but", never "not cheap, but".
    rx(
        r"\b(?:not|isn['’]?t|aren['’]?t|wasn['’]?t|weren['’]?t) (?:about|just|merely|simply|a|an|the|because|that)\b"
        + f"[^.\\n]{{1,60}}?,{S}*but\\b",
        re.I,
    ),
    rx(rf"\b(?:it|this|that)['’]?s not\b[^.\n]{{1,60}}[.;]{S}+(?:it|this|that)['’]?s\b", re.I),
    rx(rf"\b(?:it|this|that) (?:is|was) not\b[^.\n]{{1,60}}[.;]{S}+(?:it|this|that) (?:is|was)\b", re.I),
    rx(rf"\bnot (?:just|merely) [^.\n]{{1,60}}?,?{S}+but(?: also)?\b", re.I),
    rx(rf"\byou (?:don['’]?t|do not) need [^.\n]{{1,60}}\.{S}+you need\b", re.I),
    rx(rf"\bmore than (?:just |only |merely )?(?:a|an) [^.\n]{{1,50}}[.;]{S}+(?:it|this|that|they|these)(?: was| is| were| are|['’]s)\b", re.I),
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
BOLD = rx(r"\*\*[^*\n]+\*\*|__[^_\n]+__")
# The em dash (U+2014), and a double hyphen set off by spaces, which is how a plain-text writer types one. Never a
# hyphen or an en dash, so "2020-2024", "pages 10-12" and "--max" are not found. Found with str.find, not a regex: an
# alternation with no letter to start on is tried at every character, and most text has no dash at all.
EM = "\u2014"
SPACED = " -- "


def dashes(prose, t):
    at = []
    for needle, shift, n in ((EM, 0, 1), (SPACED, 1, 2)):
        i = prose.find(needle)
        while i >= 0:
            at.append((i + shift, n))
            i = prose.find(needle, i + 1)
    return [t.locate(i, t.text[i : i + n]) for i, n in sorted(at)]
LW = r"(?:[^\W\d_]|['’-])"
# "sleep, reading, play, or dinner": a list of three or more, the rhythm generated prose falls into.
TRIAD = re.compile(rf"(?<![\w'’-]){LW}+(?: {LW}+){{0,3}}, {LW}+(?: {LW}+){{0,3}},? (?:and|or) {LW}+")
# Lists of three, found by clause. A list lies inside one run of letters, apostrophes, hyphens, spaces and commas, so
# only the runs that hold a comma and an "and" or "or" are matched, each from one character early so the lookbehind
# still sees what comes before. The same matches as scanning the whole text, in a third of the time.
CLAUSE = re.compile(rf"(?:{LW}| |,)+")
AND_OR = re.compile(r" (?:and|or) ")


def triads(prose, t):
    out = []
    for run in CLAUSE.finditer(prose):
        clause = run.group(0)
        if len(clause) < 10 or ", " not in clause or not AND_OR.search(clause):
            continue
        start = max(0, run.start() - 1)
        for m in TRIAD.finditer(prose, start, run.end()):
            out.append(t.locate(m.start(), t.text[m.start() : m.end()]))
    return out


BOLD_LEAD = rx(rf"\A{S}*(?:\*\*|__)[^*_\n]{{2,80}}(?:\*\*|__)")
# A last paragraph that opens on a recap. The first group is the unmistakable ones; "ultimately" can open a story.
ENDING = rx(rf"\A{S}*(?:(in conclusion|in summary|to sum up|all in all)|ultimately|overall|in the end)\b[,:]?", re.I)


# A list item that opens on a bold label: "- **When:** Saturday".
BOLD_LIST_LEAD = rx(rf"{LINE_START}{SNL}{{0,3}}[-*+]{SNL}+(?:\*\*|__)[^*_\n]{{1,60}}(?:\*\*|__)")
# A heading below the title, to the end of its line.
HEADING_LINE = rx(rf"{LINE_START}{SNL}{{0,3}}#{{2,6}}{SNL}+{NS}[^\n]*")


def is_marker_word(m):
    return re.fullmatch("[A-Z]+", m) is not None


# The placeholder patterns, compiled once: capitals are whole words and the rest match in any case. "XX/XX/XXXX" and
# "(xxx) xxx-xxxx" are templates in any case; a run of x groups joined only by spaces ("Love, Gran XX XX") is kisses.
MARKERS = [
    rx(rf"\b{m}\b" if is_marker_word(m) else js_pattern(m), 0 if is_marker_word(m) else re.I) for m in RULES["markers"]
]
# A link reference definition, "[website]: https://example.org": the label it defines, up to the colon.
REF_DEF = rx(rf"{LINE_START}{SNL}{{0,3}}\[([^\]\n]+)\]:")
# What must follow the colon, as in CommonMark: a destination that is not another bracket, so a template line
# "[Phone number]: [on the door]" defines nothing. Read in the text itself, since the lint blanks URLs.
REF_DEST = rx(rf"{SNL}*(?:<[^>\n]+>|[^{WS}\[<]{NS}*)")


def label_key(s):
    return rx(f"{S}+").sub(" ", s).strip(JS_WS).lower()
# The kinds of weak tell that count toward stacked-tells: findings that come from one habit are one kind.
KINDS = RULES["stacked"]["kinds"]
# Pairs of kinds that never stack with each other.
APART = RULES["stacked"]["apart"]
# The warns that fail in the strict profile.
STRICT = set(RULES["strict"]["fail"])


def lint_prose(text, strict=False):
    """Lint words a person will read. `ok` is False when any finding fails.

    `strict` is the profile for writing that must carry no tells: every warn listed in strict.fail (the em dash and the
    rest of the wording and shape tells) fails. The default leaves them warnings, because none of them tells a person
    from a machine well enough to fail a piece."""
    t = Text(text)
    prose = blank_non_prose(text)
    all_paras = paragraphs(prose)
    # A word never spans a line break, so the paragraphs hold every word of the text.
    words = sum(p[2] for p in all_paras)
    findings = []

    def add(id_, severity, why, fix, matches):
        if matches:
            findings.append({"id": id_, "severity": severity, "why": why, "fix": fix, "matches": matches})

    unquoted = unquote(prose)
    hits = phrase_hits(unquoted)
    name_not_heading = lambda p, i, m: is_name(p, i, m) and not t.on_heading(p, i)
    at = 0
    for id_, rule in RULES["phrases"].items():
        skip = name_not_heading if rule.get("exemptNames") else None
        found = sorted(
            [m for h in hits[at : at + len(rule["patterns"])] for m in h if not (skip and skip(unquoted, m.start(), m.group(0)))],
            key=lambda m: m.start(),
        )
        at += len(rule["patterns"])
        # Two patterns can open on the same words ("we're grateful to", "we're grateful"): one phrase is one match.
        matches = [
            t.locate(m.start(), t.text[m.start() : m.end()])
            for i, m in enumerate(found)
            if i == 0 or m.start() != found[i - 1].start()
        ]
        if "density" in rule and len(matches) / max(1, words) <= rule["density"]:
            continue
        if "minHits" in rule and len(matches) < rule["minHits"]:
            continue
        add(id_, rule["severity"], rule["why"], rule["fix"], matches)

    # Readers in 2026 take an em dash for a machine tell, but people write them too (40 percent of the human corpus), so
    # it only ever warns and is no kind of weak tell for stacked-tells.
    add(
        "em-dash",
        "warn",
        "Readers now take an em dash for a machine tell.",
        "Use a comma, a colon, parentheses or two sentences. Keep it only where it is truly your own.",
        dashes(prose, t),
    )

    # Two patterns can match the same span ("not just a tool, but"): one contrast is one match.
    not_but = []
    for m in sorted([m for re_ in NOT_BUT for m in t.all(re_, prose)], key=lambda m: m["index"]):
        if not not_but or m["index"] != not_but[-1]["index"]:
            not_but.append(m)
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

    paras = [p for p in all_paras if not HEADING.match(p[0])]
    ending = ENDING.match(paras[-1][0]) if paras and len(paras) > 2 else None
    if ending:
        ptext, pindex, _ = paras[-1]
        ptext = text[pindex : pindex + len(ptext)]
        add(
            "summary-ending",
            "fail" if ending.group(1) else "warn",
            "The last paragraph sums up what the reader just read.",
            "End on the last concrete point, or on what to do next.",
            [t.locate(pindex, jstrip(ptext).split("\n")[0])],
        )

    lists = triads(prose, t)
    tr = RULES["triads"]
    if words >= tr["minWords"] and (len(lists) * 100) / words > tr["perHundred"]:
        add(
            "triads",
            "warn",
            f"{len(lists)} lists of three or more in {words} words. Generated prose falls into that rhythm.",
            "Keep the lists that are real lists. Elsewhere, name the one thing that matters.",
            lists,
        )

    bl = RULES["boldLeads"]
    leads = [p for p in paras if BOLD_LEAD.match(p[0])]
    if len(leads) >= bl["min"] and len(leads) / len(paras) >= bl["share"]:
        add(
            "bold-leads",
            "warn",
            "Paragraph after paragraph opens on a bold label, like slides.",
            "Write paragraphs that lead with their point, or use real headings if it is a reference page.",
            [t.locate(p[1], jstrip(text[p[1] : p[1] + BOLD_LEAD.match(p[0]).end()])) for p in leads],
        )

    body = [p for p in paras if not LIST.match(p[0]) and not re.match(rf"{S}*\|", p[0])]
    u = RULES["uniform"]
    if (
        len(body) >= u["minParagraphs"]
        and sum(1 for p in body if p[2] <= u["maxWords"]) / len(body) >= u["share"]
        and all(p[2] <= u["longest"] for p in body)
    ):
        first = body[0]
        add(
            "uniform-paragraphs",
            "warn",
            f"All {len(body)} paragraphs run {min(p[2] for p in body)} to {max(p[2] for p in body)} words. "
            "Generated drafts cut every paragraph to the same short size.",
            "Let one paragraph run long where the thought needs it, and fold a one-line paragraph into its neighbor.",
            [t.locate(first[1], jstrip(text[first[1] : first[1] + len(first[0])]).split("\n")[0])],
        )

    list_leads = t.all(BOLD_LIST_LEAD, prose)
    if len(list_leads) >= RULES["boldListLeads"]["min"]:
        add(
            "bold-list-leads",
            "warn",
            "Bullets that each open on a bold label read as a template.",
            "Write the items as plain lines, or as sentences that carry their own point.",
            list_leads,
        )

    headings = t.all(HEADING_LINE, prose)
    hd = RULES["headings"]
    if len(headings) >= hd["min"] and (len(headings) * 100) / max(1, words) > hd["perHundred"]:
        add(
            "headings",
            "warn",
            f"{len(headings)} headings in {words} words. A heading every few lines turns a short piece into slides.",
            "Keep the headings a reader would scan to, and write the rest as paragraphs.",
            [{**h, "text": jstrip(h["text"])} for h in headings],
        )

    add(
        "emoji-heading",
        "fail",
        "Emoji as section markers.",
        "Delete them. Headings carry the structure.",
        t.all(EMOJI_LINE, prose),
    )

    bold = []
    for ptext, pindex, _ in paras:
        if LIST.match(ptext) or re.match(rf"{S}*\|", ptext):
            continue
        hits = list(BOLD.finditer(ptext))
        if len(hits) > RULES["bold"]["perParagraph"]:
            bold.extend(t.locate(pindex + h.start(), text[pindex + h.start() : pindex + h.end()]) for h in hits)
    add("bold", "warn", "Bold sprinkled through a paragraph shouts.", "Let the sentence carry the weight.", bold)

    # A bracketed word that the text defines as a link reference is a link, not a slot: "Visit our [website]".
    labels = None

    def is_defined_link(p, _index, m):
        nonlocal labels
        if not m.startswith("["):
            return False
        if labels is None:
            labels = {label_key(d.group(1)) for d in REF_DEF.finditer(p) if REF_DEST.match(t.text, d.end())}
        return label_key(m[1:-1]) in labels

    add(
        "unfinished",
        "fail",
        "Placeholder text left in.",
        "Write the real words, or cut the line.",
        sorted([m for pattern in MARKERS for m in t.all(pattern, unquoted, is_defined_link)], key=lambda m: m["index"]),
    )

    # No single weak tell proves anything. Several different ones in one piece is how generated drafts read.
    kinds = [fs for fs in ([f for f in findings if f["id"] in ids] for ids in KINDS) if fs]
    # Some pairs say nothing together ("The good news is..." and a bold day of the week): a kind counts only beside a
    # kind it isn't apart from.
    def only(fs, i):
        return all(f["id"] == i for f in fs)

    def apart(a, b):
        return any((only(a, x) and only(b, y)) or (only(a, y) and only(b, x)) for x, y in APART)

    weak = [fs for fs in kinds if any(o is not fs and not apart(fs, o) for o in kinds)]
    if len(weak) >= RULES["stacked"]["min"]:
        add(
            "stacked-tells",
            "fail",
            f"{len(weak)} different small tells in {words} words ({', '.join(f['id'] for fs in weak for f in fs)}). "
            "Each one is common alone; together they read as machine-made.",
            "Rewrite the ones that are not your own voice until only one kind remains.",
            sorted([fs[0]["matches"][0] for fs in weak], key=lambda m: m["index"]),
        )

    if strict:
        for f in findings:
            if f["severity"] == "warn" and f["id"] in STRICT:
                f["severity"] = "fail"
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
    ap.add_argument("--strict", action="store_true", help="fail on the em dash and every other tell, not only warn")
    ap.add_argument("--max", type=int, default=6, help="places shown per finding, 1 or more (default 6)")
    a = ap.parse_args()  # a bad flag or no files: exit status 2
    if a.max < 1:
        print("--max takes a whole number of places, 1 or more.", file=sys.stderr)
        return 2
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    results = []
    for f in a.files:
        try:
            raw = sys.stdin.buffer.read() if f == "-" else open(f, "rb").read()
        except OSError:
            print(f"I can't read {f}.", file=sys.stderr)
            return 2
        results.append((f, lint_prose(raw.decode("utf-8", errors="replace"), a.strict)))
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
