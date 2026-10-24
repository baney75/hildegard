<!-- Loaded by Hildegard (step 5h) for any song, lyric, hook, hymn, Suno prompt or /suno request, and for fixing a Suno take. "mus" below means this method; "vus" means references/music-video.md. -->

# Songs worth singing, for Suno (merged from mus)

**The bar:** would someone play this twice on purpose? Not "is it accurate," not "does it rhyme," not "did every checklist item pass." A song that is correct, tidy and forgettable is a failure.

## Why songs come out bad (read this first)

These are the failures this skill exists to prevent. The first three sank a real song (2026-10-15, Strong Vincent).

1. **Encyclopedia in meter.** Research became the content. Verse one was a résumé (born here, named this, father did that, enlisted, married), one fact per line, sung in order. Research is ballast, not cargo: it makes the song true and supplies one or two killer details. Nearly all of it gets cut.
2. **Nobody is talking.** A narrator outside the story recounts a life. Songs are speech under pressure: a person, saying something to someone, at a particular moment, because they have to.
3. **Too much time.** Birth to death to widowhood in three minutes leaves no room for a scene. A song lives in minutes or one night, with memory flashing in.
4. **The obvious lane.** Civil War, so fiddle and snare. Love, so piano ballad. The subject's era or category is not the sound. The speaker's emotion is.
5. **Self-graded critique.** The writer scores its own draft 4 out of 5 on everything and ships. Self-critique is inflated, so the gate is a blind critic (step 8).
6. **Too many words for the tempo.** Lines written to be read, not sung. Suno crams them, rushes them or drops syllables. Line length is set by the tempo (step 7).
7. **Effort that looks like work.** Long rule lists invite compliance. Spend the effort on drafting alternatives and cutting.

## Output contract (never vary this)

Above the boxes, two lines:

- The title in bold.
- **The card line:** `Speaker → listener · moment · turn` in one line (for example `Elizabeth Vincent → a young visitor · her parlor, 1913 · his order "not an inch" becomes her vow`). This is the concept card compressed; `vus` rebuilds from it, so never skip it.

Then exactly two fenced code blocks, in this order, each paste-ready:

1. **LYRICS**: the full Suno Lyrics field (section tags, cues, words, nothing else).
2. **STYLE**: the full Suno Styles field (one compact natural-language description).

Below the boxes, one plain settings line, not a box:

`Exclude: <negatives or "none"> · Variety 0 · Style Influence <n>% · Weirdness <n>% · Model v6 (v6-mini on free) · Duration <only if the model shows the control>`

Weirdness: 50 is Suno's baseline. Use 30–45 for genre-faithful songs and 55+ for experimental lanes or `v6-wild`.

After the settings line, at most one **Notes:** line, only when needed: invented details or dramatized speech to know about, idiom flags, a revision summary, or the Instrumental toggle. No essays, craft notes, critic transcripts or checklists in the reply unless asked.

## Platform facts (Suno, verified 2026-10-15; re-check with a quick search if over two months old)

- **Models:** v6 (flagship, default) and v6-wild (exploratory) for Pro/Premier; v6-mini for free. Older models are retired.
- **Limits:** Styles 1,000 characters; Lyrics 5,000; Exclude Styles is its own field. Overflow is cut silently.
- **Variety 0** keeps full control of your style text. **Style Influence** 70–85% for a careful style prompt.
- **Negatives go in Exclude.** Typed into Styles, "male vocal" reads as a request for one.
- **Everything in Lyrics is sung** except `[bracketed cues]`. `(Parentheses)` are usually sung as backing vocals (community convention), so use them only on purpose.
- **v6 reads per-section cues.** `[Verse 1 | hushed, close-mic]` does real work. Keep descriptors under about eight words. The pipe format is a house convention.
- **Takes vary a lot.** Judge changes across both takes, with Variety at 0.
- **No real artist or band names** in either box. Translate references into era, scene, instruments, vocal character and production.

## The method

### 1. Brief

Infer subject, use (gift, worship set, release, joke, class), language and length. Ask one short question only when the answer changes the song materially, such as names for a wedding song. For personal songs, ask once for two or three details only the user knows (a phrase the person says, a place, a habit) unless the brief has them. Never import people or facts from memory unless the brief clearly points at that person. If the user is away, take the most reasonable reading, say which in Notes, and write.

### 2. Research, then cut

When anything is real (a person, place, event, scripture, science, craft), research it before writing, with web search and the user's notes. Collect true, specific, surprising details, then cut hard:

- **Hunt for the object and the contradiction.** The detail that carries a song is usually a physical thing or an irony: the riding crop his bride gave him, the daughter whose middle name was his first name. Find two or three. Dates, titles, job descriptions and "born in" facts almost never belong.
- **Sing at most three or four researched facts**, each arriving as an image, an action or a line of speech, never as a statement.
- **Accuracy still rules.** Whatever you keep must be true. Dramatized speech and small invented business (who said what, a gesture) are fine, but list them in Notes. For sacred songs, check every scriptural and doctrinal claim against the text itself.

### 3. Concept tournament

Write four concept cards. Each card is five lines:

- **Speaker → listener:** who is singing, to whom.
- **Moment:** where and when they are, in minutes or one night, not years.
- **Pressure:** what they want, fear or can't say, and why they're saying it now.
- **Turn:** what has changed, or what the hook means, by the last chorus.
- **Title.**

At least two cards must use a non-obvious speaker. For a historical hero, the obvious speaker is a narrator praising him. Better ones: the person who waited at home, the soldier beside him, the object, the enemy, a descendant today, the hero in the one minute that mattered. Pick the card that makes you feel something when you read its one-line pitch. If none does, write four more. The winner becomes the card line in the output.

### 4. Lane tournament

Name the obvious lane, then two others chosen for the speaker's emotion and the audience. Pick the one that serves the feeling; the obvious lane wins only on that test. Decide vocal identity (who would actually sing these words), tempo and meter. Meter can carry meaning: a widow remembering her wedding in a waltz, a march for someone who can't stop moving. **Fix the BPM now**; it sets the line budget in step 7.

### 5. Chorus first, three ways

Write three complete, different choruses for the winning card. Pick the one that:

- holds the title, ideally first or last line;
- says one feeling, plainly, in about 12–30 words;
- sings on open vowels where notes are held ("ay," "oh," "ah," "ee," not "inch" or "it");
- can mean more by the end of the song than at first hearing.

The chorus is simpler than the verses: shorter lines, fewer images, more repetition.

### 6. Verses and bridge

Every line must be **an image**, **an action** or **something a person says**. Run three line tests and rewrite every line that fails one:

- **Narrator test:** could a documentary narrator or an encyclopedia say this line? Cut or dramatize it. ("Born down in Waterford in thirty-seven" fails. "He kissed it the way you'd kiss a ring" passes.)
- **Any-song test:** could this line sit in a thousand other songs? Replace it with something only this song could contain.
- **Filler test:** is a word or line there for the meter or the rhyme? Rewrite both lines rather than keep it.

Verse 2 brings new information or moves the camera. The bridge tells the truth the chorus avoided, jumps in time, or drops the floor out. The final chorus usually repeats word for word and lands harder because of the bridge; change a word only when the turn needs it.

Structure follows the use: verse–chorus (with an optional pre-chorus) for most songs; AABA when the story is the point; strophic verses with a refrain for hymns and folk ballads.

### 7. Sound pass

- **Line budget by tempo.** Roughly, syllables per sung line: slow ballad or waltz (60–80 BPM) 6–9; mid-tempo (80–110) 7–11; up-tempo (110–140) 8–12; rap 12–20 per bar. Over budget, cut words; never trust Suno to fit them.
- **Stress on beats.** Read every line aloud in rhythm. If a word wrenches (*be-CAUSE* sung *BE-cause*), rewrite.
- **Paired lines match** in syllables (within one) and stress so the melody can repeat. The checker in step 11 prints counts.
- **Mouthfeel:** break consonant pileups and leave breath points.
- **Rhyme ladder:** perfect, family, additive/subtractive, assonance, consonance. An honest slant rhyme beats a forced perfect one. The best rhymes are the right word *and* rhyme (*thing/ring*, where the ring echoes the wedding).
- **Stability as meaning:** matched lines and regular rhyme feel resolved; odd counts and delayed rhyme feel restless. Unsettle where the speaker is unsettled, and resolve in the chorus.

### 8. Blind critic (mandatory)

Self-scoring is inflated. When the Agent tool exists, spawn one fresh agent and give it **only the lyrics** (no brief, research or concept card) with this prompt:

> You are a blunt veteran co-writer and A&R. You are hearing these lyrics once, at tempo, with no context. (1) In one sentence: who is singing to whom, and what is the song about? (2) Score it 1–10 against songs that get replayed on purpose, and say whether you would play it twice, yes or no, and why. (3) Which line would someone still be singing in the car an hour later? If none, say none. (4) Quote the three weakest lines and name the failure for each: résumé or narrator line, cliché, filler for rhyme or meter, unclear on first hearing, unsingable, too many words to sing. (5) Quote the single best line. (6) What one change would most improve the song? No praise padding.

Then:

- If its one-sentence summary misses your card, the song is unclear: fix the frame, not single lines.
- If no line would stick in the car, the chorus failed: go back to step 5.
- Rewrite every weak line it names, unless you can say exactly why the critic is wrong.
- **Ship gate:** score 8 or higher and a "yes." Below that, go back to step 3 or 5, not to line edits, and run one second critic (fresh agent, revised lyrics only). Never more than two critic rounds; if the second still fails, ship the better version and say in Notes what the critic still doubts.

Without an Agent tool, do a hostile pass yourself and write down the three weakest lines before rewriting them. Something is always weakest.

### 9. Build the STYLE box

One or two front-loaded sentences of comma phrases, about 200–500 characters, never over 1,000. Early terms weigh most (community testing). Order: genre anchor plus at most one accent; tempo (state the BPM), meter and feel; vocal identity (gender, register, timbre, delivery); two to four defining instruments; production and era; the arc (sparse verses, where it lifts, where it strips, how it ends). Optional key or mode. No artist names, no negatives, no contradictions, and a mood that matches the lyric.

### 10. Build the LYRICS box

- One tag per section, with a short performance cue where the energy shifts: `[Verse 2 | cello enters]`, `[Bridge | voice alone]`.
- Instrumental moments get a tag with no words under it. Keep intros short (two to four bars) unless the length is the point.
- Vocal handoffs: `[Male Vocal]`, `[Female Vocal]`, `[Duet]`, `[Choir]`, `[Spoken]`.
- Repeat chorus lyrics identically unless a deliberate turnaround changes a word.
- Write numbers as words, avoid acronyms, and spell hard names phonetically (`Gettysburg` is fine; `Chamberlain` might need `Chamber-lin`).
- End with `[Outro | …]` then `[End]`.
- No prose or titles outside brackets.

### 11. Verify mechanics

When a shell exists, save the boxes as `lyrics.txt` and `style.txt` and run this checker (`pip install pronouncing` for accurate syllables; it falls back to a heuristic). Report nothing if it passes; fix and rerun if it fails. Read the syllable counts against step 7's budget and the paired-line rule.

```python
# usage: python3 check_song.py "Title" lyrics.txt style.txt
import re, sys
from collections import defaultdict
try:
    import pronouncing
except ImportError:
    pronouncing = None
title, lyrics, style = sys.argv[1], open(sys.argv[2]).read(), open(sys.argv[3]).read()
fail = []
def syl(w):
    w = re.sub(r"[^a-z']", "", w.lower())
    if not w: return 0
    if pronouncing and (p := pronouncing.phones_for_word(w)):
        return pronouncing.syllable_count(p[0])
    n = len(re.findall(r"[aeiouy]+", w)) - (w.endswith("e") and not w.endswith("le"))
    return max(1, n)
if len(style) > 1000: fail.append(f"style {len(style)} chars > 1000")
if len(lyrics) > 5000: fail.append(f"lyrics {len(lyrics)} chars > 5000")
if title.lower() not in lyrics.lower(): fail.append("title not in lyrics")
if re.search(r"\d", "\n".join(l for l in lyrics.splitlines() if not l.strip().startswith("["))):
    fail.append("digits in sung lines: write numbers as words")
sections, cur = defaultdict(list), None
for l in lyrics.splitlines():
    s = l.strip()
    if s.startswith("["): cur = s.strip("[]").split("|")[0].strip().lower(); sections[cur].append([])
    elif s and cur: sections[cur][-1].append(s)
sung = [l for blocks in sections.values() for b in blocks for l in b]
words = sum(len(l.split()) for l in sung)
choruses = [tuple(b) for k, bl in sections.items() if k.startswith("chorus") for b in bl if b]
if len(set(choruses)) > 1: fail.append(f"{len(set(choruses))} different chorus texts: confirm each change is a deliberate turn")
cliche = r"\b(neon|tapestry|symphony|echoes|whispers|shadows|shattered|ignite|embers|kaleidoscope|labyrinth|velvet|starlit|forevermore|fade away|soul on fire|hearts collide|we rise|break these chains)\b"
hits = sorted(set(m.lower() for m in re.findall(cliche, lyrics, re.I)))
if hits: fail.append("cliche words: " + ", ".join(hits))
print(f"{words} sung words, {len(sung)} lines")   # typical 140-260; rap and epics run longer
for k, bl in sections.items():
    for b in bl:
        if b: print(f"[{k}] syllables:", [sum(syl(w) for w in l.split()) for l in b])
print("FAIL:\n- " + "\n- ".join(fail) if fail else "PASS")
```

By hand: no artist names in either box, and the Exclude line contradicts nothing in Styles.

## Worked example: the failure and the fix

Brief: "Strong Vincent, make the song." (Erie lawyer, born in Waterford, mortally wounded holding Little Round Top at Gettysburg, July 1863.)

**Failed version:** a narrator, birth to burial, fiddle-and-fife march, chorus built on his famous order.

- "Born down in Waterford in thirty-seven, / They gave him his mother's name: Strong." Résumé; narrator test fails.
- "He took it on his own back, and he took the slope." Prose with a forced rhyme; unsingable.
- "On the seventh of July, he was gone." A date and a euphemism; any-song test fails.

**Fixed version:** the winning card was *his widow Elizabeth, fifty years on, telling someone who asked why she never remarried*. The turn: his battlefield order, "don't give an inch," became her vow. The lane: a slow waltz (she is remembering her wedding), low female alto, felt piano and cello. The researched details survive only as images: the riding crop she gave him the day after the wedding, the bugler who wrote her, the daughter whose middle name was "Strong" and who is buried between them.

- "So I gave him the crop off my saddle, / and he kissed it the way you'd kiss a ring."
- "Fifty years I've been holding that hill / from this side of the grave."
- "There's a plot up in Erie with room for three, / and she'll be in the middle again."

A blind critic scored the failed version 5/10 ("a museum placard set to music") and the fixed one 8/10, and still caught two misses: the bridge's payoff depended on "Strong" being his name, which the song never said, and "seven months gone" could be heard as leaving rather than pregnancy. Both were fixed ("His name was Strong, and he grew to fit it"; "I was carrying our little one"). The critic earns its cost.

Same research, same hero. The difference is a speaker, a moment, a turn and the cut.

## Clichés and AI tells to purge (unless deliberately subverted)

Words and images: neon, tapestry, symphony, echoes, whispers, shadows, shattered, ignite, embers, kaleidoscope, labyrinth, velvet, crimson skies, starlit, "the depths of", "dance in the rain", "soul on fire", "hearts collide", "we rise", "break these chains", "lost in the moment", "fade away", "forevermore", "this is our time", "legend", "hero's heart", "never be forgotten".

Rhyme ruts: fire/desire, heart/apart/start, night/light/fight/bright, soul/whole/control, rain/pain, eyes/skies/lies, free/be/see. Not banned, but each must be earned.

Habits: personified abstractions (*hope whispers*); lists of three adjectives; every line end-stopped and the same length; explaining the feeling instead of showing the evidence; a chorus that summarizes the verses; a verse 2 that rephrases verse 1; uplift the song hasn't earned; telling the listener someone was brave instead of showing the brave thing.

Replace a label with evidence. *Burning up* becomes *shirt stuck to my back*. *A hero* becomes *left his sword on the saddle*.

## What the research on listening says (use it to decide, not to decorate)

- **Anticipation pays.** Dopamine rises in anticipation of a musical peak as well as at it (Salimpoor et al., 2011). Build the lean into the chorus; withholding is a tool.
- **Surprise needs a frame.** Unexpected chords please most when the context is predictable (Cheung et al., 2019). Set a pattern before you break it.
- **Repetition breeds fluency.** More repetitive lyrics reached No. 1 more often and faster (Nunes et al., 2015). Repeat the title; say one thing, not three.
- **The hook arrives early now.** Pop intros shrank from about 20 seconds in the mid-1980s to about 5 by 2015 (Léveillé Gauvin, 2018). Keep intros short for streaming lanes unless length is the art.
- **Peaks come from change.** Tears and chills track resolving dissonance, new voices and sudden dynamic shifts (Sloboda, 1991). Plan one or two: the band drops out, a voice enters, a key lift. Spend them sparingly.

## Modes

- **New song:** the full method.
- **Revise the user's lyrics:** keep their voice and best lines; fix prosody, clarity, rhyme and structure; say briefly what changed and why. Replace wholesale only if asked. Still run the blind critic on the result.
- **In the style of an artist:** model the fingerprint (cadence, rhyme density, line shape, diction, themes, sonic era) with entirely original words on a fresh subject. Never reproduce or closely paraphrase existing lyrics. No names in either box.
- **Worship and hymns (congregational):** written for a room to sing, not a soloist to perform. Keep the range to about an octave, melodies stepwise, phrases in four- or eight-bar units, the hook in plain words a first-time visitor can join by the second chorus. Prefer "we" when the room is singing and "I" only for testimony. Every doctrinal claim checked against scripture, with references in Notes. STYLE names a congregational lane (for example "congregational worship, steady 72 BPM, singable mid-range melody, piano and acoustic guitar, full band lift on final chorus"). Ancient-text settings (psalms, the Te Deum, Latin hymns) may use public-domain translations verbatim; say which in Notes.
- **Instrumental:** LYRICS holds only section and instrument cues; STYLE includes `instrumental, no vocals`; note the Instrumental toggle.
- **Other languages:** write natively, respecting stress, vowel endings and phrase length. Flag idioms for native review.
- **Album or persona:** keep a shared style kernel (vocal identity, palette, era) across tracks; vary tempo, mood and arc per song.
- **Fix a take:** the user describes what Suno did. Use the table below; change one thing per generation.

## After generating in Suno

Listen to both takes before judging. Keep Variety at 0 and change one thing at a time. When a take is about 80% right, fix it with Replace Section or Extend rather than rerolling. Expect three to five generations to find the take. If every take is dull, the lyric or the lane is the problem, not the dice: go back to steps 3–5.

| Symptom | Fix, in this order |
|---|---|
| Words rushed, crammed or skipped | Cut syllables to the step 7 budget; split long lines; add a breath with a line break |
| Wrong vocal gender or character | Move the vocal phrase to the front of STYLE; add the opposite to Exclude; add `[Female Vocal]` (or male) on the first section |
| Ignores a section cue | Shorten the cue to three or four words; make it concrete (`voice alone`, not `emotional`) |
| Genre drifts toward generic pop | Raise Style Influence 5–10 points; put the genre anchor first; add the drift genre to Exclude |
| Long or wandering intro | Make `[Intro]` explicit with a short cue (`[Intro | two bars piano]`) or start on `[Verse 1]` |
| Mispronounced name or word | Spell it phonetically or with hyphens; Replace Section for that line only |
| Chorus doesn't lift | Add a lift cue on the chorus tag (`full band enters`); thin the pre-chorus; check the hook holds an open vowel |
| Song ends abruptly or loops | End with `[Outro | …]` and `[End]`; remove trailing repeated lines |
| Every take sounds the same and flat | The lane is wrong; rerun step 4 with a different tempo or meter |