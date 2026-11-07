---
name: hildegard-blog
description: Use for a blog post, newsletter, email, about page, bio or announcement in a person's own voice - learns their voice from samples and edits, interviews them, and posts to their site.
---

# Writing in their voice

A post a real person will publish under their own name. It must sound like them, say only what they told you, and
read as written by a person. Hildegard keeps each writer's voice: the samples they give, every change they make to
your drafts, and the rules learned from both. This skill is all you need for everyday prose.

## Fast path

1. **Open their voice.** Call `writing_voice`. It returns their rules (`voice.md`), their samples, and the phrases
   they keep cutting from drafts. Follow the rules over your habits, and never use a phrase on the cut list.
   - No samples yet? Ask once: "Paste two or three things you've written that sound like you: posts, emails, even long
     texts." Save each with `writing_voice_add_sample`. Then write their first rules (below, "Learning the voice").
   - No Hildegard tools? Ask for the samples in chat and keep the rules in your reply for them to save.
2. **Get the material.** Ask until you hold at least five concrete things only this writer knows (the interview,
   below). If they say "just write it", ask the three that matter most (usually the story, the numbers and the ask),
   say in one line what you're assuming for the rest, and go.
3. **Draft from their facts, in their voice** (the rules below).
4. **Lint until it passes.** With Hildegard linked, `lint_writing`; with it installed, `hildegard lint draft.md`;
   otherwise `python3 scripts/prose_lint.py draft.md` in the **hildegard** skill's folder. Fix every fail; fix each warn unless `voice.md` says it's theirs. Never show a draft that fails.
5. **Show the draft.** Say which warnings you kept and why, and anything you assumed.
6. **Learn from their edit.** When they send their changed version, call `writing_voice_record_edit` with your draft
   and their final. Then update the rules (below).
7. **Byline and post.** From an interview, the byline is "By <their name>, with Hildegard" unless they choose
   otherwise. Post it with `site_post` as a draft first; publish only when they say so.

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
(`site_post` keeps them as private notes).

## Draft rules

- Lead with the point or the story. No opener about the world, the age we live in, or the reader's struggles.
- **Only their facts.** Every claim traces to something they said or a source you can name. Never invent a number,
  quote, customer, scene, feeling, price, date, piece of advice or opinion, even a common one. An estimate stays an
  estimate: "about three a day" never becomes "three a day". If the piece needs a fact you don't have, ask, or mark
  it for them to confirm.
- **Their voice.** Their greeting and sign-off, their phrases where they fit, their sentence length, their humor and
  convictions as they stated them. Write to their readers the way they talk to them.
- Under about 600 words, usually no headings. Never a bold label on every paragraph. A list only for a real list.
- End on the ask, said their way, or on the last concrete point. No recap, no moral, no line written to sound wise.
- **The portability test.** Pick three sentences at random. If any could move unchanged into someone else's post on
  the subject, replace it with one of their facts, or cut it.

## Learning the voice

`voice.md` is short, specific and theirs. Write it from samples, and improve it from edits:

- **From samples.** Read every sample, then write what's true of them: typical sentence length and how much it
  varies; how they open and close; how they address the reader ("y'all", "friends", none); words and phrases they
  use often; words they never use; punctuation habits (dashes, exclamation points, parentheses); humor; faith,
  family, place or trade they bring up; how long their pieces run. Quote short examples from the samples for each.
- **From edits.** After `writing_voice_record_edit`, look at what they cut and added. Add a rule only when the same
  kind of change shows up in two edits, or when they tell you directly ("I never say 'journey'"). Write the rule as
  an instruction with an example: "Cuts 'I'm excited to share'. Opens with the news itself."
- **Keep it under about 60 lines.** Merge rules that say the same thing. Remove a rule their later writing breaks.
- Save it with `writing_voice_update` and tell them in one line what you learned.

## Posting to their site

`site_post` makes the post page in their site's own look, adds it to the blog's index, feed and sitemap, and keeps
the interview notes private. Post as a draft, give them the preview link, and change it until they're happy. Publish
only on their word (`draft: false`). Putting the whole site on the internet is the owner's choice
(`site_publish`); never do it for them. For the title, description and slug, keep the title under 60 characters
and specific, the description 140 to 160 characters, and the first 100 words answering what the title asks.

## Deliver

The post, its title and description, the byline, the lint result, any warning you kept and why, anything you assumed,
and what you learned about their voice this time.
