# Books: planning, composing, and producing a book

Load this for any book-length work: a novel, a nonfiction book, a memoir, a devotional, a poetry collection, a textbook or course book, a children's picture book, a photo or art book, a family history.

## Sources

- **Robert Bringhurst, *The Elements of Typographic Style* (4th ed., 2012):** the measure (45–75 characters per line, about 66 ideal), leading, margins, the page as a proportion, honoring the content.
- **Jan Tschichold, *The Form of the Book* (1991):** the canon of page proportions (the Van de Graaf canon); the text block placed by classical ratios.
- ***The Chicago Manual of Style* (18th ed.), part 1 ("The Publishing Process"):** the parts of a book and manuscript preparation.
- **John McPhee, *Draft No. 4*:** structure as a diagram before drafting.
- **Shawn Coyne, *The Story Grid* (2015):** a book as a hierarchy of scenes, sequences, acts and global story, with a spreadsheet per scene.
- **Children's picture books:** Uri Shulevitz, *Writing with Pictures* (1985); the 32-page standard; text and image doing different work.

## Planning the whole

- **One sentence for the whole book** (the seed). Then the table of contents as an argument (nonfiction) or a sequence of turns (fiction).
- **A scene or section spreadsheet:** for each unit, what changes, its purpose, its point of view, its length and its status. This is the book's storyboard (`drafting-storyboards.md`, applied to text).
- **The book's arc:** where the reader is at the start, the midpoint turn, the end. Each chapter ends with a pull into the next.
- **Typical lengths:**
  - novels about 70,000–100,000 words (genre-dependent);
  - nonfiction about 50,000–90,000;
  - children's picture books under about 600 words in 32 pages;
  - middle grade about 30,000–55,000.
- **Draft in chapters as separate files** (Markdown), each with a short header note of its purpose. Build the whole with pandoc.

## Parts of a book (Chicago order)

- **Front matter:** half title, series or frontispiece, title page, copyright page, dedication, epigraph, contents, lists of illustrations, foreword, preface, acknowledgments (or in back matter), introduction.
- **Body:** parts, chapters, sections.
- **Back matter:** appendixes, chronology, notes, glossary, bibliography, index, about the author.

## Production

**Typesetting:**
- **Print PDF:**
  - Typst or LaTeX (via pandoc, or written directly) for full control: trim size (6×9 in is common for trade nonfiction and fiction), margins larger on the inside (the gutter), a baseline grid;
  - one well-made serif text face (Garamond, Minion, Caslon, Crimson Pro or EB Garamond for free use) at 10.5–12 pt, with leading about 120–145% of the type size;
  - widows and orphans controlled; hyphenation on with sensible limits;
  - running heads and folios.
- **EPUB:** pandoc to EPUB3 with a cover image (1600×2560 px is common), semantic headings, alt text on images, and a table of contents. Validate with EPUBCheck.
- **Manuscript submission:** standard manuscript format: double-spaced, 12 pt Times New Roman, 1-inch margins, page numbers, scene breaks marked with `#`.
- **Images in books:** 300 ppi at print size, CMYK proofed for print, captions and credits. The art follows the main skill's image method.
- **Covers:** design them at the thumbnail size where buyers see them (pitfall 18). The spine width comes from the page count and paper (the printer's calculator). Allow a 0.125 in bleed. Barcode and ISBN go on the back.
- **Self-publishing specs** (KDP, IngramSpark): check their current templates, bleed and spine rules.

## Revision for books

- **Structural edit first:** order, missing and redundant chapters, the arc, pacing across chapters. Don't line-edit a structure that will change.
- **Then each chapter:** opening, turn, ending.
- **Then line edits:** `writing-craft.md` and `nonfiction-academic.md`.
- **Continuity bible** (fiction): names, ages, dates, places, physical details, timeline. Check every chapter against it.
- **Fact-check** (nonfiction): every claim against its source, with a source list kept per chapter.
- **Beta readers:** a blind critic per chapter or act. Ask "where did you stop caring? what confused you? what do you remember?"

## Checklist

- [ ] One sentence for the book, a table of contents with each chapter's purpose, and a scene or section spreadsheet.
- [ ] Chapters end with a pull, the arc turns at the midpoint, and the ending is earned.
- [ ] Front and back matter are complete and in Chicago order.
- [ ] Print: trim, margins, typeface, leading, widows and orphans, running heads and folios checked in the PDF. EPUB validated.
- [ ] The cover reads at thumbnail size, and the spine is computed from the real page count.
