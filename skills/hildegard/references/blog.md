# Blog posts, newsletters, web pages and other everyday prose

Read this for any piece a person will publish under their own name and read on a screen: a blog post, a newsletter,
an about page, a product page, a long social post, a church or club announcement. Academic work is
`nonfiction-academic.md`; fiction, poetry and scripts are `writing-craft.md`.

## Why these come out reading as AI

A model drafts a post the moment it has a topic. With nothing from the writer it has nothing specific to say, so it
fills the page with what any post on the subject would say: a list of three benefits, a bold label on every
paragraph, a warm closing line. No single sentence is wrong. The whole thing could be about anyone, and readers can
tell. The fix is not better sentences. It is material: the writer's own story, numbers, names and phrases, gathered
before the first line is drafted.

## 1. Interview for material (one question per message)

Ask until you hold at least five concrete things only this writer knows, then stop. Usually four to eight
questions. Follow what they say; these are the ground to cover, not a script.

1. **The reader.** “Who reads this, and what do they already know?” A neighbor, a customer, a parent, an engineer.
2. **The one thing.** “If they remember one sentence from it, what should it be?” Press a vague answer once: “What
   does that look like on an ordinary Tuesday?”
3. **The story.** “When did this happen to you? Walk me through it.” Get the day, the place, who was there, what went
   wrong, what it cost.
4. **The numbers.** “How many, how long, how much?” Hours, dollars, miles, people, years. Ask for the real figure,
   not a round one.
5. **The names.** The town, the shop, the tool, the book, the person (with their consent if it's a private person).
6. **Their words.** “How would you say it to a friend?” Keep the phrases they use and the way they use them. If they
   have published writing, ask for a sample and read it for vocabulary, sentence length and humor.
7. **The disagreement.** “What would someone who knows this subject push back on?” A post that takes no position is
   filler.
8. **The ask.** “What should the reader do after reading?” Call, sign up, try the method, come on Sunday.

When the writer wants it fast (“just write it”), ask the three that matter most for this piece (usually the story,
the numbers and the ask), say in one line what you're assuming for the rest, and go.

## 2. Outline from their answers

Write the outline as their facts in order, not as topic headings. Each line names the specific thing it carries:
“the March weekend the order count tripled, 40 to 120 a day” rather than “Growth challenges.” Show it to them before
drafting a long piece. A line with no fact behind it is a sign to ask, not to invent.

## 3. Draft in their voice

- Lead with the point or the story. No opener about the world, the age we live in, or the reader's struggles.
- Every claim traces to an answer or a source you can name. Never invent a statistic, a quote, a study, a customer,
  a scene or a feeling the writer didn't report. Don't put advice, services, prices, dates or opinions in the
  writer's mouth that they didn't give, even common ones: a shop owner's post that adds “store it somewhere dry” is
  telling customers something the owner never said. If the piece needs it, ask, or mark it for the writer to
  confirm and say so in the delivery.
- Warmth comes from how the writer talks to these readers, not from invented detail. Write as them, to people they
  know: “you”, the plain greeting and sign-off they'd use, the joke they made in the interview. Use their phrases
  where they fit, and vary sentence length the way they talk.
- A post under about 600 words usually needs no headings at all. Over that, headings only where a reader would scan
  for them, written as what the section says. Never a bold lead-in on every paragraph; that is a slide deck.
- A list only for things that are really a list (steps, ingredients, a schedule). Elsewhere, pick the one example
  that matters instead of three that sound balanced.
- End on the ask, said the way the writer would say it to these readers (“See you in the hall after the 10:30”), or
  on the last concrete point. No recap, no moral, no line written to sound wise.

## 4. Lint until it passes

Run the prose lint on the draft and on every revision. With Hildegard connected, call `lint_writing`. Without it:

```sh
python3 scripts/prose_lint.py draft.md
```

Fix every finding marked fail. Fix each one marked warn unless it is the writer's real voice (a list that really has three parts, bold
labels on a reference page), and tell them which warnings you kept and why. Lint again after each fix; new sentences
bring new tells. Never show a draft that fails.

The lint catches the tells it can see. It can't catch a post with nothing to say. Before delivering, check the
portability test by hand: pick three sentences at random. If any could move unchanged into someone else's post on
the same subject, replace it with a fact from the interview, or cut it.

## 5. Make it findable (SEO), last

Search and AI answers reward a page that answers a real question with first-hand detail. Do this after the post
reads well; never bend a sentence for a keyword.

- **Title**: under 60 characters, the words a reader would search, and specific (“Moving a 40-order-a-day shop
  from SQLite to Postgres”, not “Database Lessons”).
- **Description**: 140 to 160 characters, what the reader gets, in plain words. It's the line under the title in
  search results.
- **Slug**: short, lowercase, hyphenated, no dates or stop words unless they matter.
- **One H1** (the title), then H2s a reader would actually search or scan for.
- **First 100 words** answer the question the title asks.
- **Images** with alt text that says what is in them; a share image at 1200 × 630.
- **Links**: two or three to the writer's own related pages, and to any source cited.
- **Structured data** where the site supports it: `BlogPosting` with author, date and image.

## 6. Deliver

Give the post as Markdown with front matter (title, description, slug, date, author, tags), ready to paste or
publish. Under it, in a few lines: the lint result, any warnings kept and why, every fact you could not confirm,
and anything left for the writer to fill.
