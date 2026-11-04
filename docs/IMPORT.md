# Importing posts you already published

The engine learns from what you have published. Where a platform's API does not give us your history yet
(LinkedIn without restricted access, or while Meta's app review is pending), import it from a file.

```bash
npm run social -- import linkedin posts.csv --dry-run   # check the file, write nothing
npm run social -- import linkedin posts.csv
```

Or run the **Import published posts** workflow with a public link to the file (it defaults to a dry run).
Importing the same file again never duplicates a post, and re-importing with updated numbers updates the metrics.

## Format

CSV (comma, semicolon or tab separated — Excel exports work) or JSON (`[...]` or `{"posts": [...]}`).
Column names are matched loosely, case and punctuation ignored:

| Field | Accepted column names | Notes |
|---|---|---|
| date (required) | `date`, `published`, `publishedAt`, `timestamp`, `ShareDate`, `created` | `YYYY-MM-DD` or `YYYY-MM-DD HH:MM[:SS]`. No time zone means **UTC**. Other formats such as `03/10/2026` are skipped, because they are ambiguous |
| text (required unless media) | `text`, `body`, `caption`, `content`, `ShareCommentary`, `message` | |
| url | `url`, `link`, `permalink`, `ShareLink` | |
| id | `id`, `externalId`, `postId` | If missing, a stable id is derived from channel, date and text |
| media | `media`, `type` | `image`, `video` or `none`; several separated by `,` `;` or `|`. A `MediaUrl` column counts as an image |
| metrics | `impressions`, `reach`, `views`, `likes` (or `reactions`), `comments`, `shares` (or `reposts`), `saves`, `clicks` | Whole numbers; `12 345` and `1.200` are read as thousands |

Without metrics the post still teaches the engine your voice and topics, but not what performed well.
Rows that cannot be read are skipped and listed with their row number; nothing is guessed.
Limits: 5 MB and 5000 rows per file.

LinkedIn's own data export has `Date`, `ShareLink`, `ShareCommentary`, `MediaUrl` columns, which are recognised.
That is from memory and not checked against a real export, and the export has no metrics.
