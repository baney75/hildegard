# SPDX-License-Identifier: AGPL-3.0-only
"""Edit the words and the media follows: a word-timed transcript becomes a text file to cut from, and the cuts become an
edit list. Also the fillers, the false starts, and the captions that come out of the same words.

Whisper's word times are rough (tens of milliseconds either way), so a cut never lands on a word's own edge: it runs from
`margin` after the last kept word to `margin` before the next, and is skipped when that leaves less than 40 ms.
"""

import difflib
import re

DEFAULT_FILLERS = ["um", "uh", "uhm", "umm", "er", "erm", "ah", "hmm", "mm", "mmm"]
# Words that are fillers only when spoken as a hesitation: with a pause or a comma beside them, and not after a word
# that needs them ("I like", "would like", "looks like").
HEDGES = [["like"], ["you", "know"], ["i", "mean"], ["sort", "of"], ["kind", "of"], ["basically"], ["actually"]]
NEEDS_LIKE = {"i", "we", "you", "they", "would", "wouldn't", "don't", "do", "did", "didn't", "looks", "look", "looked",
              "feel", "feels", "felt", "just", "something", "much", "more", "most", "what", "who", "that", "would've",
              "i'd", "we'd", "they'd", "you'd", "he", "she", "it", "people", "really", "also", "to", "not", "never"}
STOP = set("a an the and or but so of to in on at for with is are was were be been it this that these those i you he she we "
           "they my your our their as by from not do does did have has had will would can could should just then than "
           "there here what which who how if at about into over very really".split())
END = re.compile(r"[.?!…]+[\"”’')\]]*$")
MIN_CUT = 0.04


class TranscriptError(Exception):
    """A plain one-line reason, shown to the person as it is."""


def norm(w):
    return re.sub(r"[^\w']+", "", w.lower().replace("’", "'")).strip("'")


def words_of(transcript):
    """Flat [{i, start, end, word}] from transcribe's result ({segments:[{words}]}), {words:[…]}, or a list of words."""
    if isinstance(transcript, dict) and "segments" in transcript:
        raw = [w for s in transcript["segments"] for w in s.get("words", [])]
        if not raw and any(s.get("text") for s in transcript["segments"]):
            raise TranscriptError("That transcript has text but no word times. Transcribe again with word timestamps.")
    elif isinstance(transcript, dict) and "words" in transcript:
        raw = transcript["words"]
    elif isinstance(transcript, list):
        raw = transcript
    else:
        raise TranscriptError("That doesn’t look like a transcript with word times.")
    out = []
    for w in raw:
        text = str(w.get("word", w.get("text", ""))).strip()
        if not text:
            continue
        try:
            a, b = float(w["start"]), float(w["end"])
        except (KeyError, TypeError, ValueError):
            raise TranscriptError("Every word in the transcript needs a start and an end time.")
        out.append({"i": len(out), "start": a, "end": max(b, a), "word": text})
    out.sort(key=lambda w: (w["start"], w["end"]))
    for i, w in enumerate(out):
        w["i"] = i
    if not out:
        raise TranscriptError("The transcript has no words in it.")
    return out


def sentences(words, gap=0.9, longest=40):
    """[[word, …]]: broken after end punctuation, at a gap of `gap` seconds, or after `longest` words."""
    out, cur = [], []
    for k, w in enumerate(words):
        cur.append(w)
        nxt = words[k + 1] if k + 1 < len(words) else None
        if END.search(w["word"]) or nxt is None or nxt["start"] - w["end"] >= gap or len(cur) >= longest:
            out.append(cur)
            cur = []
    return out


# ── The text file ───────────────────────────────────────────────────────────────────────────────────────────────

HEADER = (
    "# Delete words, or whole lines, to cut them out of the video. The picture and sound follow the words.\n"
    "# Do not add, change or reorder words (the sound can’t be changed). The [12.3] at the start of a line is a time in\n"
    "# seconds; leave it or delete it. Lines that start with # are ignored.\n"
)
TIME = re.compile(r"^\s*\[\s*\d+(?:\.\d+)?\s*\]\s*")


def to_text(words):
    lines = [HEADER]
    for s in sentences(words):
        lines.append(f"[{s[0]['start']:.1f}] " + " ".join(w["word"] for w in s) + "\n")
    return "\n".join(lines)


def deleted_from_text(words, text):
    """Which words were deleted from the text file. Returns (set of word indices, [notes]).

    The edited words are matched to the originals by sequence, ignoring case and punctuation, so deleting a word or a
    line removes exactly those words; anything added or changed is reported and ignored."""
    toks = []
    for line in text.splitlines():
        if line.lstrip().startswith("#"):
            continue
        line = TIME.sub("", line)
        toks.extend(t for t in line.split() if norm(t))
    a = [norm(w["word"]) for w in words]
    b = [norm(t) for t in toks]
    sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    deleted, notes = set(), []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "delete":
            deleted.update(range(i1, i2))
        elif tag == "insert":
            notes.append(f"Ignored added words near {words[min(i1, len(words) - 1)]['start']:.1f}s: “{' '.join(toks[j1:j2])}”. The sound can’t be changed.")
        elif tag == "replace":
            # A reworded stretch: keep the original (the audio says that), but a pure spelling fix is fine.
            if i2 - i1 == j2 - j1:
                notes.append(f"Ignored changed words near {words[i1]['start']:.1f}s: “{' '.join(toks[j1:j2])}” (the audio still says “{' '.join(w['word'] for w in words[i1:i2])}”).")
            else:
                # Fewer words than before: treat the surplus originals as deleted, only when the rest matches.
                notes.append(f"Ignored reworded text near {words[i1]['start']:.1f}s. Delete words to cut them; don’t retype them.")
    return deleted, notes


# ── Fillers and false starts ────────────────────────────────────────────────────────────────────────────────────


def _hesitation(words, i, n):
    """Whether words[i:i+n] sit in a hesitation: a comma beside them, or a pause on a side."""
    prev = words[i - 1] if i > 0 else None
    nxt = words[i + n] if i + n < len(words) else None
    last = words[i + n - 1]
    comma = (prev is not None and prev["word"].rstrip().endswith((",", "\u2014", "-", "\u2026"))) or last["word"].rstrip().endswith((",", "\u2026", "-"))
    pause = (prev is not None and words[i]["start"] - prev["end"] >= 0.2) or (nxt is not None and nxt["start"] - last["end"] >= 0.2)
    return comma or pause


def find_fillers(words, fillers=None, hedges=True, strict=False):
    """{word index: filler text}. Fillers (um, uh…) always go. Hedges (like, you know, I mean…) go only as a hesitation,
    unless `strict`. Pass `fillers` to replace the default list (a phrase is words joined by spaces)."""
    plain = {tuple(norm(x) for x in f.split()) for f in (fillers or DEFAULT_FILLERS)}
    ph = set(plain)
    out = {}
    n = len(words)
    nw = [norm(w["word"]) for w in words]
    for i in range(n):
        for size in (3, 2, 1):
            if i + size > n:
                continue
            key = tuple(nw[i : i + size])
            if key in ph and not any(j in out for j in range(i, i + size)):
                for j in range(i, i + size):
                    out[j] = " ".join(nw[i : i + size])
                break
    if hedges:
        for h in HEDGES:
            size = len(h)
            for i in range(n - size + 1):
                if tuple(nw[i : i + size]) != tuple(h) or any(j in out for j in range(i, i + size)):
                    continue
                if h == ["like"] and i > 0 and nw[i - 1] in NEEDS_LIKE:
                    continue
                if strict or _hesitation(words, i, size):
                    # "kind of" and "sort of" are meaningful unless hesitating; only the hesitating ones go.
                    for j in range(i, i + size):
                        out[j] = " ".join(h)
    return out


def find_bad_takes(words, min_words=2, lookahead=3, window=12.0):
    """{word index: reason} for earlier takes of a line the speaker then said again. The last take stays.

    A sentence whose opening (its first three words, or all of it if shorter, at least two) is how a later sentence within
    `lookahead` sentences and `window` seconds opens is a false start. Inside one sentence, a phrase of up to four words
    said twice in a row ("so the so the thing") loses its first copy."""
    out = {}
    sents = sentences(words)
    nw = [[norm(w["word"]) for w in s] for s in sents]
    for i in range(len(sents) - 1):
        k = min(3, len(nw[i]))
        if k < min_words:
            continue
        for j in range(i + 1, min(len(sents), i + 1 + lookahead)):
            if sents[j][0]["start"] - sents[i][-1]["end"] > window:
                break
            if nw[j][:k] == nw[i][:k]:
                for w in sents[i]:
                    out[w["i"]] = f"said again at {sents[j][0]['start']:.1f}s"
                break
    for s, n in zip(sents, nw):
        i = 0
        while i < len(n):
            hit = False
            for size in (4, 3, 2, 1):
                if i + 2 * size <= len(n) and n[i : i + size] == n[i + size : i + 2 * size] and all(n[i : i + size]):
                    gap = s[i + size]["start"] - s[i + size - 1]["end"]
                    if size == 1 and (gap > 0.5 or n[i] in STOP - {"i", "the", "a", "to", "and", "of", "we", "it"}):
                        continue
                    for w in s[i : i + size]:
                        out.setdefault(w["i"], "repeated just after")
                    i += size
                    hit = True
                    break
            if not hit:
                i += 1
    return out


# ── From deleted words to cuts ──────────────────────────────────────────────────────────────────────────────────


def cuts_for(words, deleted, why, margin=0.05, duration=None):
    """[(start, end, why)] for runs of deleted word indices; also [notes] for runs too tight to cut.

    `deleted` maps word index → reason (a set works with `why` as the reason for all)."""
    reasons = deleted if isinstance(deleted, dict) else {i: why for i in deleted}
    idx = sorted(reasons)
    cuts, notes = [], []
    k = 0
    while k < len(idx):
        j = k
        while j + 1 < len(idx) and idx[j + 1] == idx[j] + 1:
            j += 1
        first, last = idx[k], idx[j]
        prev_w = words[first - 1] if first > 0 else None
        next_w = words[last + 1] if last + 1 < len(words) else None
        a = prev_w["end"] + margin if prev_w else 0.0
        b = next_w["start"] - margin if next_w else (duration if duration is not None else words[last]["end"] + margin)
        a, b = max(0.0, a), max(a, b)
        if duration is not None:
            b = min(b, duration)
        text = " ".join(words[x]["word"] for x in range(first, last + 1))
        reason = reasons[first]
        if b - a >= MIN_CUT:
            cuts.append((round(a, 3), round(b, 3), reason))
        else:
            notes.append(f"Left “{text}” at {words[first]['start']:.1f}s: only {max(0.0, b - a) * 1000:.0f} ms is clear of the words beside it.")
        k = j + 1
    return cuts, notes


# ── Captions ────────────────────────────────────────────────────────────────────────────────────────────────────


def _wrap(words, per_line, lines):
    """Greedy wrap into at most `lines` lines of about `per_line` characters; None if it doesn't fit."""
    out, cur = [], ""
    for w in words:
        add = (cur + " " + w) if cur else w
        if len(add) <= per_line or not cur:
            cur = add
        else:
            out.append(cur)
            cur = w
    if cur:
        out.append(cur)
    return out if len(out) <= lines else None


def make_cues(words, max_chars=38, max_lines=2, min_seconds=1.0, max_seconds=6.0):
    """[{start, end, lines: [str]}] from words timed in the output ({word, start, end}), in order.

    A cue breaks at the end of a sentence, at a pause of 0.6 s or more, at a comma once it is two-thirds full, or when
    it would need more than `max_lines` lines or run past `max_seconds`. Each stays on screen at least `min_seconds`
    when the next one allows."""
    cues, cur = [], []

    def flush():
        nonlocal cur
        if cur:
            cues.append({"start": cur[0]["start"], "end": cur[-1]["end"], "words": [w["word"] for w in cur]})
        cur = []

    for k, w in enumerate(words):
        if cur:
            test = _wrap([x["word"] for x in cur] + [w["word"]], max_chars, max_lines)
            if test is None or w["end"] - cur[0]["start"] > max_seconds or w["start"] - cur[-1]["end"] >= 0.6:
                flush()
        cur.append(w)
        text = " ".join(x["word"] for x in cur)
        if END.search(w["word"]):
            flush()
        elif w["word"].endswith(",") and len(text) >= max_chars * max_lines * 0.66:
            flush()
    flush()
    out = []
    for i, c in enumerate(cues):
        lines = _wrap(c["words"], max_chars, max_lines) or [" ".join(c["words"])]
        # Break long text into balanced lines rather than one full line and one short.
        if len(lines) > 1:
            total = " ".join(c["words"])
            target = max(1, round(len(total) / len(lines)) + 2)
            balanced = _wrap(c["words"], min(max_chars, target), max_lines)
            if balanced:
                lines = balanced
        end = c["end"]
        nxt = cues[i + 1]["start"] if i + 1 < len(cues) else None
        want = c["start"] + min_seconds
        if end < want:
            end = min(want, (nxt - 0.02) if nxt is not None else want)
        if nxt is not None and end > nxt - 0.02:
            end = max(c["start"] + 0.2, nxt - 0.02)
        out.append({"start": round(c["start"], 3), "end": round(max(end, c["start"] + 0.2), 3), "lines": lines})
    return out


# ── A plan from a transcript ────────────────────────────────────────────────────────────────────────────────────


def content_value(sentence):
    """New content words per second: what a sentence adds that the listener didn't already have."""
    seen = set()
    n = 0
    for w in sentence:
        x = norm(w["word"])
        if x and x not in STOP and len(x) > 2:
            n += 1
    dur = max(0.5, sentence[-1]["end"] - sentence[0]["start"])
    return n / dur


def trim_to(words, deleted, target_seconds, cut_seconds, protect=1):
    """Extra deletions to bring a length down to `target_seconds`: whole sentences, least content per second first. The
    first and last `protect` sentences stay. `cut_seconds(deleted_idx)` says how long the cut would make the video."""
    sents = sentences(words)
    order = sorted(range(protect, max(protect, len(sents) - protect)), key=lambda i: content_value(sents[i]))
    extra = {}
    cur = set(deleted)
    for i in order:
        if cut_seconds(cur) <= target_seconds:
            break
        for w in sents[i]:
            if w["i"] not in cur:
                extra[w["i"]] = "trimmed to length: least said per second"
                cur.add(w["i"])
    return extra
