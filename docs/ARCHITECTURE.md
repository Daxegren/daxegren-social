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
- `src/worker/` — the command line the automation runs: `doctor`, `migrate`, `tick`, `ingest`, `import`, `refresh-metrics`, `add-asset`, `media`, `generate`.
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
| Generation | `src/generate.ts` | `ContentGenerator` (Claude implementation) |
| Media | `src/media.ts`, `src/adapters/higgsfield.ts`, `src/adapters/gemini-image.ts`, `src/adapters/supabase-storage.ts` | Paid video (Higgsfield) and image (Gemini) generation as persisted jobs: estimate, monthly cap, submit, poll, copy to durable storage, register as an `Asset` |
| Scheduler | `src/scheduler.ts` | Claims due variants atomically, validates, publishes, retries with backoff |
| Engine | `src/engine.ts` | Orchestrates everything above |
| Worker | `src/worker/*` | Wires the engine from environment variables; CLI and migrations |
| Review queue | `web/` | Edit, schedule, approve or reject drafts; read-only views of the rest |
| Create | `web/src/CreateView.tsx` | Mobile-first: upload own media, describe the post, pick channels, order drafts |
| Doctor, import | `src/worker/doctor.ts`, `src/worker/importer.ts` | Free setup check; load previously published posts from CSV/JSON (see [IMPORT.md](IMPORT.md)) |

## Decisions

- **Human approval by default.** Generated variants are `draft` until approved. `autoApprove` opts a channel
  out of review, and only for variants that pass channel validation.
- **No double posts.** A variant is claimed with an atomic `scheduled → publishing` transition before the
  network call. If a worker dies mid-publish the variant stays `publishing`; after 30 minutes `tick` marks it
  `failed` with an explanation and notifies you, and you press *Försök igen* after checking the platform — it is
  never retried automatically, because that could duplicate a post that actually went out.
- **The browser can only do narrow things.** A reviewer can edit and approve drafts, upload into their own
  `uploads/<user id>/` folder, register such an upload as a *captured* asset, and create a brief as a *request*.
  Everything else (drafting, publishing, generating media, results) happens in the worker with the service role.
  Each of these is enforced in the database (row-level security and storage policies) and covered by tests.
- **Requests, not remote calls.** The app cannot trigger the worker (that would need a secret in the browser), so
  it writes a request row; `tick` claims it atomically and turns it into drafts, or records why it failed.
- **Retryable vs permanent errors.** 429/5xx/network errors retry with backoff; other 4xx fail immediately.
- **Paid work is persisted before it is paid for.** A media job row exists before the provider is called, and the
  provider's job id is saved right after submitting, so a finished clip can always be collected by a later `tick`.
  The asset reuses the job's id, so collecting twice cannot duplicate it.
- **Own and generated media are the same thing to the engine.** Both are `Asset`s; only `origin` differs.
  Anything with a public https URL can be attached.
- **Ingestion fallback.** Where a platform's API does not expose your history (LinkedIn without restricted
  access), `engine.importPosts` accepts data from an export.

## Status

| Channel | Publish | Ingest | Metrics |
|---|---|---|---|
| Instagram | image, reel, carousel (2–10 images/videos) | yes (likes, comments) | likes, comments |
| Facebook (Page) | text, photo(s), video | yes (reactions, comments, shares) | reactions, comments, shares |
| LinkedIn | text, one image | via `importPosts` | no |
| TikTok, Pinterest, YouTube, X, Snapchat | not yet — implement `ChannelAdapter` | | |

Video generation is ported from the `content.generate.media` capability in Ecomduct CoPilot (Higgsfield) and checked
against Higgsfield's documentation and OpenAPI file (2026-11-06): statuses, the estimate and idempotency behaviour,
and the request fields of Kling 2.5 Standard/Pro and Hailuo 2.3. Kling 3.0 Turbo and Seedance 2.0 are not in that file,
so their endpoints are unconfirmed. Nothing has been run against a live key. Image
generation uses the Gemini API directly, because the Ecomduct CoPilot and Cockpit X implementations call OpenAI image
models through the Lovable AI Gateway, which only works inside Lovable. The Gemini adapter follows Google's documentation of
the Interactions API (checked 2026-11-06) but has not yet been run against a live key.

Not built yet: richer insights (reach/saves), video
upload flows for the other channels. The Facebook adapter and the Instagram carousel were written from memory of the Graph API and have not been
confirmed against a live account. Platform limits in
`channels.ts` and API versions in the adapters should be checked against current platform documentation before
production use.
