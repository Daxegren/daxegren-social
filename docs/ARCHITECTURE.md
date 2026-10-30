# Architecture

The engine is a loop: **ingest → analyse → generate → review → schedule → publish → measure**, and the
measurements feed the next round of analysis.

```
 channels ──ingest──▶ PublishedPost ──analyse──▶ ChannelInsights
    ▲                      ▲                          │
    │                      │ (published variants      ▼
 publish                   │  re-enter the corpus)  generate ◀── ContentBrief + Assets
    │                      │                          │
 scheduler ◀── approve ◀── PostVariant (draft) ◀──────┘
```

## Where it lives

One repository, `@daxegren/social-engine`, standalone:

- `src/` — the engine: a framework-free TypeScript library (global `fetch` and `crypto`, no runtime
  dependencies; `pg` is only used by the worker).
- `src/worker/` — the command line the automation runs: `migrate`, `tick`, `ingest`, `refresh-metrics`, `generate`.
- `web/` — the review queue: a static React app that talks to Supabase directly and imports the channel
  rules from `src/`, so it validates with exactly the rules the scheduler enforces.
- `db/migrations/` — the Postgres schema and the row-level-security rules the browser relies on.
- `.github/workflows/` — CI, and the worker running on a schedule. See [DEPLOY.md](DEPLOY.md).

## Pieces

| Piece | File | Responsibility |
|---|---|---|
| Domain | `src/domain.ts` | Channels, assets (captured vs generated), posts, briefs, variants |
| Channel rules | `src/channels.ts` | Per-channel limits and `validateVariant` |
| Store | `src/store.ts`, `src/postgres-store.ts` | Persistence interface; in-memory and Postgres implementations (same contract tests) |
| Adapters | `src/adapters/*` | One per channel: publish, ingest, metrics. Only place with platform specifics |
| Analysis | `src/analyze.ts` | Engagement rate, best hours, length/media performance, time suggestion |
| Generation | `src/generate.ts` | `ContentGenerator` (Claude implementation) and `MediaGenerator` interface |
| Scheduler | `src/scheduler.ts` | Claims due variants atomically, validates, publishes, retries with backoff |
| Engine | `src/engine.ts` | Orchestrates everything above |
| Worker | `src/worker/*` | Wires the engine from environment variables; CLI and migrations |
| Review queue | `web/` | Edit, schedule, approve or reject drafts; read-only views of the rest |

## Decisions

- **Human approval by default.** Generated variants are `draft` until approved. `autoApprove` opts a channel
  out of review, and only for variants that pass channel validation.
- **No double posts.** A variant is claimed with an atomic `scheduled → publishing` transition before the
  network call. If a worker dies mid-publish the variant stays `publishing` and needs a manual look,
  because retrying automatically could duplicate a post that actually went out.
- **Retryable vs permanent errors.** 429/5xx/network errors retry with backoff; other 4xx fail immediately.
- **Own and generated media are the same thing to the engine.** Both are `Asset`s; only `origin` differs.
  Anything with a public https URL can be attached.
- **Ingestion fallback.** Where a platform's API does not expose your history (LinkedIn without restricted
  access), `engine.importPosts` accepts data from an export.

## Status

| Channel | Publish | Ingest | Metrics |
|---|---|---|---|
| Instagram | image, reel | yes (likes, comments) | likes, comments |
| LinkedIn | text, one image | via `importPosts` | no |
| Facebook, TikTok, Pinterest, YouTube, X, Snapchat | not yet — implement `ChannelAdapter` | | |

Not built yet: a `MediaGenerator` implementation, Instagram carousels and richer insights (reach/saves), video
upload flows for the other channels, recovery of variants stranded in `publishing`. Platform limits in
`channels.ts` and API versions in the adapters should be checked against current platform documentation before
production use.
