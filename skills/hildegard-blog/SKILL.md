---
name: hildegard-blog
description: Use for a blog post, newsletter, email, about page, bio or announcement in a person's own voice - learns their voice from samples and edits, interviews them, and posts to their site.
---

# Writing in their voice

A post a real person will publish under their own name. It must sound like them, say only what they told you, and
read as written by a person. Hildegard keeps each writer's voice: the samples they give, every change they make to
your drafts, and the rules learned from both. This skill is all you need for everyday prose.

## Fast path

1. **Open their voice.** With Hildegard linked: call `writing_voice`. It returns their rules (`voice.md`), their
   samples, and the phrases they keep cutting from drafts. Without Hildegard: read `voice.md` and the files in
   `samples/` in the person's project folder, or the pieces they pasted or attached earlier in the chat. Follow the
   rules over your habits, and never use a phrase on the cut list (the phrases they keep cutting, listed at the end of `voice.md`).
   - No samples yet? Ask once: "Paste two or three things you've written that sound like you: posts, emails, even long
     texts." With Hildegard: save each with `writing_voice_add_sample`. Without it: save each as
     `samples/<short-name>.txt` beside `voice.md`. Then write their first rules (below, "Learning the voice").
   - No files and no tools (a chat)? Ask for the samples in the chat, write `voice.md` in your reply, and tell them to
     paste it back next time.
2. **Get the material.** Ask until you hold at least five concrete things only this writer knows (the interview,
   below). If they say "just write it", ask the three that matter most (usually the story, the numbers and the ask),
   say in one line what you're assuming for the rest, and go.
3. **Draft from their facts, in their voice** (the rules below).
4. **Lint until it passes.** Save the draft as `draft.md` and run `python3 scripts/prose_lint.py draft.md` from this
   skill's folder (Python 3 only; the rules are `scripts/prose_rules.json` beside it). With Hildegard linked,
   `lint_writing` or `hildegard lint draft.md` gives the same result. Fix every fail; fix each warn unless `voice.md`
   says it's theirs. Never show a draft that fails. Without Python: check the draft against the Draft rules below,
   line by line, and say you did not run the lint.
5. **Show the draft.** Say which warnings you kept and why, and anything you assumed.
6. **Learn from their edit.** When they send their changed version, with Hildegard linked call
   `writing_voice_record_edit` with your draft and their final. Without Hildegard: keep both as
   `edits/<date>-draft.md` and `edits/<date>-final.md` beside `voice.md` (or in the chat) and compare them yourself:
   what they cut, added and reworded. Then update the rules (below).
7. **Byline and post.** From an interview, the byline is "By <their name>, with Hildegard" unless they choose
   otherwise. With Hildegard linked: post it with `site_post` as a draft first; publish only when they say so.
   Without Hildegard: hand over `<slug>.md`, the post with its title, description, slug, date, byline and
   `draft: true` in a block at the top, in the folder where their other posts live if you can see it. They publish it.

## The interview (one question per message)

Follow what they say; this is the ground to cover, not a script. Usually four to eight questions.

1. **The reader.** "Who reads this, and what do they already know?"
2. **The one thing.** "If they remember one sentence, what should it be?" Press a vague answer once: "What does that
   look like on an ordinary Tuesday?"
3. **The story.** "When did this happen to you? Walk me through it." The day, the place, who was there, what went
   wrong, what it cost.
4. **The numbers.** "How many, how long, how much?" The real figure, not a round one.
5. **The names.** The town, the shop, the tool, the book, the person (a private person only with their consent).
6. **Their words.** "How would you say it to a friend?" Keep their phrases.
7. **The disagreement.** "What would someone who knows this push back on?"
8. **The ask.** "What should the reader do after reading?"

Never answer for them, and never put a word in their mouth to save a question. Save the answers with the post
(`site_post` keeps them as private notes; without Hildegard, put them in `<slug>-notes.md` and never publish it).

## Draft rules

- Lead with the point or the story. No opener about the world, the age we live in, or the reader's struggles.
- Every claim traces to an answer or a source you can name. Never invent a statistic, a quote, a study, a customer,
  a scene or a feeling the writer didn't report. Don't put advice, services, prices, dates, promises or opinions in
  the writer's mouth that they didn't give, even common ones: a shop owner's post that adds "store it somewhere dry"
  is telling customers something the owner never said. An estimate stays an estimate: "about three a day" never
  becomes "three a day". If the piece needs it, ask, or mark it for the writer to confirm and say so in the delivery.
- **Every fact makes it in, with its conditions.** Before you show the draft, go down the brief: each fact, number,
  date and condition is in the draft, said as precisely as the brief says it ("the member rate for families who
  register by March 1", not "the member rate if you register by March 1").
- **Put their numbers to work, only for a worry.** When the brief names a worry the readers have (a price going up, a
  cost) and gives the figures, do the arithmetic for them ("about $4 more a month, while the feed we buy went up
  20%"), exactly. Never turn a goal into a target for the reader (a total into "per family" or "per week") unless the
  writer set it: that reads as a quota.
- Warmth comes from how the writer talks to these readers, not from invented detail. Write as them, to people they
  know: "you", the plain greeting and sign-off they'd use, the joke they made in the interview. Use their phrases
  where they fit, and vary sentence length the way they talk: a run of short sentences reads like a notice, not a
  person.
- **No samples yet?** Take the voice from who is writing to whom: a coach writing to the team's parents is warm and
  plain, says "we" and "you", and reassures as well as informs; a shop owner to regulars writes like they talk over
  the counter. Say in your reply that you'll match their voice better once they share a few pieces.
- **An email** gets a subject line, the greeting they'd use, and their sign-off with their name. A personal email or
  letter has no bullet list.
- A post under about 600 words usually needs no headings at all. Over that, headings only where a reader would scan
  for them, written as what the section says. Never a bold lead-in on every paragraph; that is a slide deck. A page
  people use to plan (a race, an event, a schedule) may be laid out for scanning.
- A list only for things that are really a list (steps, ingredients, a schedule). Elsewhere, pick the one example
  that matters instead of three that sound balanced.
- **No stock lines.** A line any shop or church could post ("we're excited to share", "your support means the
  world", "don't miss out") is filler. Say it with their facts, or cut it.
- End on the ask, said the way the writer would say it to these readers ("See you in the hall after the 10:30"), or
  on the last concrete point. No recap, no moral, no line written to sound wise.
- **The portability test.** Pick three sentences at random, and every paragraph's last sentence. If any could move
  unchanged into someone else's post on the same subject, replace it with a fact from the interview, or cut it.

## Learning the voice

`voice.md` is short, specific and theirs. Write it from samples, and improve it from edits:

- **From samples.** Read every sample, then write what's true of them: typical sentence length and how much it
  varies; how they open and close; how they address the reader ("y'all", "friends", none); words and phrases they
  use often; words they never use; punctuation habits (dashes, exclamation points, parentheses); humor; faith,
  family, place or trade they bring up; how long their pieces run. Quote short examples from the samples for each.
- **From edits.** After you record their edit (step 6), look at what they cut and added. Add a rule only when the same
  kind of change shows up in two edits, or when they tell you directly ("I never say 'journey'"). Write the rule as
  an instruction with an example: "Cuts 'I'm excited to share'. Opens with the news itself."
- **Keep it under about 60 lines.** Merge rules that say the same thing. Remove a rule their later writing breaks.
- Save it with `writing_voice_update` (without Hildegard, write it to `voice.md`, or in your reply if you have no
  files) and tell them in one line what you learned.

## Posting to their site

With Hildegard linked, `site_post` makes the post page in their site's own look, adds it to the blog's index, feed and sitemap, and keeps
the interview notes private. Post as a draft, give them the preview link, and change it until they're happy. Publish
only on their word (`draft: false`). Putting the whole site on the internet is the owner's choice
(`site_publish`); never do it for them. For the title, description and slug, keep the title under 60 characters
and specific, the description 140 to 160 characters, and the first 100 words answering what the title asks.
Without Hildegard, the same limits apply to the title and description in the post file's top block (step 7).

## Deliver

The post, its title and description, the byline, the lint result, any warning you kept and why, anything you assumed,
and what you learned about their voice this time.
