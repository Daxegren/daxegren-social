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

- **Base:** this repository, `@daxegren/social-engine`. A framework-free TypeScript library with no runtime
  dependencies (it uses the global `fetch` and `crypto`).
- **David OS module:** David OS (Lovable, TypeScript + Supabase) imports the package and supplies a
  Postgres-backed `Store` (schema in `db/migrations/`). The review queue is a UI over `PostVariant`
  rows with status `draft`; `engine.tick()` runs from a Supabase scheduled function.

## Pieces

| Piece | File | Responsibility |
|---|---|---|
| Domain | `src/domain.ts` | Channels, assets (captured vs generated), posts, briefs, variants |
| Channel rules | `src/channels.ts` | Per-channel limits and `validateVariant` |
| Store | `src/store.ts` | Persistence interface + in-memory implementation |
| Adapters | `src/adapters/*` | One per channel: publish, ingest, metrics. Only place with platform specifics |
| Analysis | `src/analyze.ts` | Engagement rate, best hours, length/media performance, time suggestion |
| Generation | `src/generate.ts` | `ContentGenerator` (Claude implementation) and `MediaGenerator` interface |
| Scheduler | `src/scheduler.ts` | Claims due variants atomically, validates, publishes, retries with backoff |
| Engine | `src/engine.ts` | Orchestrates everything above |

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

Not built yet: Supabase `Store`, a `MediaGenerator` implementation, Instagram carousels and richer insights
(reach/saves), video upload flows for the other channels. Platform limits in `channels.ts` and API
versions in the adapters should be checked against current platform documentation before production use.
