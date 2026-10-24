# Nonfiction, essays, research and academic writing (APA, Chicago, MLA)

Load this for essays, articles, reports, memoir, sermons and talks written out, literature reviews, research papers, theses, and anything that must be cited.

## Sources

- **William Zinsser, *On Writing Well* (30th anniversary ed., 2006):** clarity, simplicity, brevity, humanity. Clutter is the disease.
- **Joseph M. Williams and Joseph Bizup, *Style: Lessons in Clarity and Grace* (12th ed., 2016):**
  - characters as subjects, actions as verbs;
  - old information before new;
  - the topic string that holds a paragraph together.
- **Steven Pinker, *The Sense of Style* (2014):** classic style (show the reader something, as if pointing it out) and the curse of knowledge.
- **John McPhee, *Draft No. 4* (2017):** structure is drawn before drafting; the fourth draft is where the work happens.
- **Wayne C. Booth, Gregory Colomb, Joseph Williams et al., *The Craft of Research* (4th ed., 2016):** topic to question to problem to claim; claims supported by reasons, evidence and warrants, with acknowledgments and responses.
- **Gerald Graff and Cathy Birkenstein, *They Say / I Say* (5th ed., 2021):** enter the conversation. State what others say, then your response.
- **Strunk and White, *The Elements of Style*:** useful on omitting needless words. Some of its grammar rules are wrong; Pinker's critique is fair.
- **Montaigne, Orwell ("Politics and the English Language," 1946), Didion, Baldwin:** the essay as an attempt (*essai*), thinking on the page.
- **The style manuals themselves:**
  - *Publication Manual of the American Psychological Association* (7th ed., 2020);
  - *The Chicago Manual of Style* (18th ed., September 2024);
  - *MLA Handbook* (9th ed., 2021);
  - Purdue OWL for quick checks.

## Intake (a light interview: these answers change the work)

- **The assignment or occasion:** prompt, rubric, length, deadline, audience, the required style guide and edition.
- **The user's own thesis or angle,** and their sources and notes (a Zotero library, PDFs, their notes app). For a student, the course's AI policy decides what help is appropriate. Work in the user's voice, from their argument and their sources, and make it clear what you drafted.
- **Required parts:** abstract, title page, headings, figures, appendix.

## The method

1. **Question and claim.** Turn the topic into a question, the question into a problem (why it matters), and the problem into a claim that someone could reasonably dispute (Booth et al.).
2. **Research:**
   - find primary sources and peer-reviewed work;
   - read the actual source, not a summary of it;
   - record exact quotations with page numbers;
   - check every citation exists (a DOI that resolves at doi.org, or a library catalog record).

   **Never invent a source, a quotation, a page number or a DOI.** If you can't verify one, say so and leave a marked placeholder.
3. **Outline the argument:** claim, then reasons, then evidence for each, then the strongest counterargument with a response, then the conclusion with its implications. McPhee: draw the structure before writing.
4. **Draft fast, in the user's voice.** Topic sentences carry the argument. Read only the first sentence of each paragraph: does the argument still hold?
5. **Revise (Williams):**
   - characters as subjects and actions as verbs ("The committee decided," not "A decision was made by the committee");
   - old information before new;
   - cut nominalizations ("make an analysis of" becomes "analyze");
   - cut hedges that don't measure uncertainty, and cut "very."
6. **Cite and format** (below) with a tool, not by hand.
7. **Check:** every claim sourced, every quotation exact, every citation in the references and every reference cited. Then the rubric line by line.

## Essays (personal, critical, persuasive)

- **The essay is an attempt:** a mind working on a question, not a report of conclusions. Show the turn of thought.
- **Open** with the specific: a scene, a fact, a question. Avoid a throat-clearing paragraph.
- **Structure follows the thinking.** An argument structure (claim, evidence, objection, response) suits critical and persuasive essays; braided or associative structure suits personal essays.
- **End** by opening outward (implications) or by returning to the opening image changed. Don't summarize.

## Citation styles (verify details against the manual for edge cases)

**APA 7th edition (2020):**
- **In-text:** (Author, Year) or Author (Year), adding a page or paragraph number for quotations: (Smith, 2020, p. 14). For three or more authors, use "et al." from the first citation.
- **Reference list:**
  - titled "References," alphabetical, double-spaced, with hanging indents;
  - up to 20 authors listed;
  - DOIs written as `https://doi.org/...`; no publisher location; the publisher name without "Inc." or similar;
  - article and book titles in sentence case; journal names in title case and italics, with italic volume numbers.
- **Student papers:**
  - a title page with title, author, affiliation, course number and name, instructor and due date;
  - page numbers top right; no running head unless required;
  - fonts: Times New Roman 12, Calibri 11, Arial 11, Georgia 11, or Lucida Sans Unicode 10;
  - double spacing; 1-inch margins.
- **Headings:**
  - Level 1: centered, bold, title case;
  - Level 2: flush left, bold, title case;
  - Level 3: flush left, bold italic, title case;
  - Level 4: indented, bold, title case, ending with a period, with the text running on;
  - Level 5: like Level 4, in bold italic.

**Chicago 18th edition (2024).** Two systems:
- **Notes and bibliography** (humanities, history, theology): footnotes, plus a bibliography.
- **Author-date** (sciences).

Changes from the 17th edition:
- DOIs written as URLs;
- publisher place no longer required for books published since 1900;
- bibliographies list up to six authors (more than six: the first three, then "et al.");
- repeated author names in the bibliography instead of the 3-em dash;
- "under" replaces "s.v." for reference-work entries in notes;
- a page range is no longer required for a chapter in an edited book in the bibliography;
- new guidance on citing AI tools.

Shortened notes after the first full note are preferred; "ibid." is discouraged in favor of shortened notes.

**MLA 9th edition (2021):**
- **In-text:** (Author page), for example (Smith 14).
- **Works Cited:** built from the core elements in order: author, title of source, title of container, other contributors, version, number, publisher, publication date, location; then a second container if any.

**Scripture citations:**
- APA and MLA: cite the version in the first citation, e.g. (Rom. 5:8, King James Version); Bible translations go in the reference list in APA. Book-chapter-verse references use the style's abbreviations.
- Chicago: Scripture goes in notes and usually not in the bibliography.

**Use tools, never hand-format a reference list:**
- Keep sources in Zotero (the user's library) or a BibTeX/CSL-JSON file.
- Render with pandoc's citeproc and the official CSL style from the `citation-style-language/styles` repository on GitHub (`apa.csl`, `chicago-notes-bibliography.csl`, `chicago-author-date.csl`, `modern-language-association.csl`). Check the edition in each CSL file's metadata.
- Command: `pandoc paper.md --citeproc --bibliography refs.bib --csl apa.csl --reference-doc apa-template.docx -o paper.docx`.
- Make a `.docx` reference document with the right fonts, spacing, margins and heading styles once, and reuse it.
- Then check the output against the manual for the cases citeproc gets wrong: capitalization of titles, missing DOIs, corporate authors, and odd source types.

## Academic genres

- **IMRaD** (research articles): Introduction, Method, Results, Discussion. The abstract has 150–250 words (APA), giving the problem, method, findings and implications.
- **Literature review:** organized by theme or debate, not as a list of summaries. Synthesize: what the field agrees on, disputes, and lacks.
- **Argumentative or position paper:** claim, reasons, evidence, counterargument and response.
- **Philosophy papers:**
  - state the argument in numbered premises and a conclusion;
  - explain each premise;
  - raise the strongest objection;
  - reply to it.

  Charity to opponents. Quote primary texts with standard citation numbers (Stephanus numbers for Plato, Bekker numbers for Aristotle).
- **Theology papers:** Scripture in context (book, genre, author, audience), then the tradition (fathers, councils, confessions), then the argument. Cite translations and editions.

## Checklist

- [ ] The claim is debatable and specific, and stated early.
- [ ] Each paragraph's first sentence carries the argument.
- [ ] Every source is real and verified, every quotation exact with its page, and nothing is invented.
- [ ] Citations are generated by citeproc with the right CSL and edition, then spot-checked against the manual.
- [ ] Formatting matches the guide and the course rubric: title page, headings, fonts, spacing, margins.
- [ ] The text is in the user's voice and argument, within the course's AI policy.
