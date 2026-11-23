# Carousels

A carousel is a row of swipeable pages of text (Instagram, LinkedIn, Facebook and X show them). The engine writes the
pages, draws them as images and puts them in the review queue like any other draft. **You are not in front of a camera
at any point**; your own photo is optional and becomes the background of the cover.

## What you get

- Claude writes 4–12 pages: a cover with a hook, pages that each carry one idea (a point, a short list, a statement)
  and a closing page. It also writes one caption per channel.
- Every page is drawn as a 1080×1350 JPEG (4:5, the tallest ratio Instagram shows in full). JPEG is also what Instagram
  accepts.
- Each channel gets one draft: the caption plus all pages in order. You approve, edit the caption or reject it, as with
  any draft.
- Cost: only the Claude call (a few cents). Drawing the pages and storing them is free.

Channels that cannot show at least four images (TikTok, YouTube, Pinterest, Snapchat) are skipped. LinkedIn takes at
most 9 pages and X at most 4, so the page count is capped to what the chosen channels accept.

## The "point + takeaway" page

A page can carry a short **takeaway box** ("Ta med dig: …", or "Steal this: …" in English): one practical line the reader
can use, under the explanation. The writer may also mark one or two numbers or key phrases per page in the accent colour.
This is the layout of the popular "Hack 1 / Hack 2 …" case-study carousels: a title, a few short paragraphs with the figures
picked out, and a line to take away. The writer is told to mark only what your brief says: **it must never invent a
figure to have something to highlight.** If you feed it a case study, check every number against its source.

## Ordering one

**From your phone, in the review app:** *Skapa* → write the idea → format **Karusell** → optional comment word → pick
channels → *Beställ utkast*. The next `tick` (at most 15 minutes) turns it into a draft.

**From the GitHub app:** Actions → *Create carousel* → Run workflow.

**From a terminal:**

```bash
npm run social -- carousel "Three things I wish I knew about margin" --channels linkedin,instagram --slides 8 --keyword MALL
```

`--assets <id>` attaches your own photos; the first JPEG or PNG is used behind the cover. `--keyword` adds a closing
page that says "Kommentera MALL". (The comment-to-DM step itself is a feature of Instagram or of a tool such as
ManyChat; the engine only writes the call to action.)

## Look before you post

```bash
npm run social -- carousel "Three things about margin" --channels linkedin --preview ./out
```

draws the pages and captions into `./out` (`page-01.jpg` …, `captions.txt`) without a database or storage. It needs only
`ANTHROPIC_API_KEY`.

## Your look

Set the repository **variables** `CAROUSEL_HANDLE` (printed top left, e.g. `@david`), `CAROUSEL_ACCENT` (`#rrggbb`) and
`CAROUSEL_THEME` (`dark` or `light`). Page layouts live in `src/carousel/render.ts`.

## Limits

- The font covers Latin text including å, ä and ö. Emoji and other scripts are removed from the pages (they would print
  as empty boxes). Captions are not affected.
- Page text is sized from its length, not measured: a very long title can still wrap to many lines. The writer is told to
  keep titles under 70 characters and bodies under 200.
- A photo behind the cover is darkened so the title stays readable, but a very busy photo can still compete with the text.
- Pages are rendered once. To change the wording of a page, order a new carousel; the caption can be edited in the app.
