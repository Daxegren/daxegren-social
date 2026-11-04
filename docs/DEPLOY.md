# Deploy and cost

No Lovable and no server of your own. Four pieces, each with a free tier as far as I know — **check current
pricing and limits on each provider's site before relying on this**; they change.

| Piece | Where | What it does | Cost driver |
|---|---|---|---|
| Database + login | Supabase | `social_*` tables, sign-in for the review queue | Free tier; projects on it pause when inactive (the 15-minute tick keeps it awake) |
| Review queue | Cloudflare Pages (or Netlify, Vercel, GitHub Pages) | Static site from `web/` | Static hosting |
| Worker | GitHub Actions | `tick` every 15 min, daily learn, manual "Generate drafts" | Free for public repos. Private repos have a monthly minute quota; 15-minute ticks would exceed the free quota, so use ~30–60 min or keep the repo public |
| Content generation | Anthropic API | Drafts | Per token |
| Video generation | Higgsfield | Clips from a product image or a text prompt | Per clip — roughly 0.07–0.30 USD each according to the notes in Ecomduct CoPilot; capped per month (below) |
| Image generation | Google Gemini API | Images from a prompt, optionally based on a reference photo | Per image (estimate 0.04 USD, configurable); shares the monthly cap with video |
| Generated files | Supabase Storage | Durable public URLs the platforms fetch media from | Storage quota |

Costs that scale with what you publish rather than with hosting: the Anthropic API, X's paid API, and any
image/video generation you connect later.

## Setup

### 1. Supabase

1. Create (or un-pause) a project. Copy the **Session pooler** connection string (Project → Connect). GitHub's
   runners are IPv4-only and the direct database host may be IPv6-only, so use the pooler. *(Verify this in
   the dashboard.)*
2. Apply the schema from your machine:
   ```bash
   DATABASE_URL='<pooler connection string>' npm run build && DATABASE_URL='<…>' npm run social -- migrate
   ```
3. Authentication → Users → add your user. The login form only signs in existing users, so nobody can register.
4. Authentication → URL configuration → set *Site URL* to the review queue's address (otherwise the e-mail link points to localhost).
5. Make yourself a reviewer — without this the queue is empty by design:
   ```sql
   insert into social_admins (user_id) values ('<your id from auth.users>');
   ```

The public storage bucket `social-media` is created by migration 0005 (images and video, 50 MB per file — Supabase's free
plan caps single uploads at 50 MB as far as I know; check the current limit). Files get unguessable paths, and the
platforms need a public URL to fetch media from anyway.

After setting secrets, run the **Check setup** workflow. It is free and read-only: it checks the database, migrations,
the bucket and every key you have set, and tells you what is wrong without ever printing a secret.

### 2. Review queue (Cloudflare Pages)

Connect the repo. Build command `npm ci && npm run build:web`, output directory `web/dist`, environment variables
`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (the **publishable** key — never the service-role key).

### 3. Worker (GitHub Actions)

Repository → Settings → Secrets and variables → Actions:

| Secret | Needed for |
|---|---|
| `DATABASE_URL` | everything (pooler connection string) |
| `ANTHROPIC_API_KEY` | generating drafts |
| `LINKEDIN_AUTHOR_URN`, `LINKEDIN_ACCESS_TOKEN` | publishing to LinkedIn |
| `INSTAGRAM_USER_ID`, `INSTAGRAM_ACCESS_TOKEN` | publishing to / learning from Instagram |
| `HIGGSFIELD_API_KEY` (`KEY_ID:KEY_SECRET`) | generating video |
| `GEMINI_API_KEY` | generating images. A key from **Google AI Studio**, with its own billing — a consumer Gemini subscription is not an API key |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | storing generated video. **Service-role key: Actions secret only, never in the browser** |

Optional variables `GEMINI_IMAGE_MODEL` (default `gemini-2.5-flash-image`) and `GEMINI_IMAGE_COST_USD` (default 0.04) — check Google's current model list and prices. Optional variable `MEDIA_MONTHLY_CAP_USD` (default 50) is the hard monthly limit on video spend.

Then add the **variable** `SOCIAL_ENABLED` = `true`. Until it is set, none of the worker workflows do anything.
A channel is enabled when its secrets are present. Optional secret `AUTO_APPROVE_CHANNELS` (e.g. `linkedin`)
skips review for those channels — leave it unset until you trust the output.

Day to day, from your phone:

- **Skapa (in the review app):** take or pick a photo/video, say what the post is about, choose channels, press
  *Beställ utkast*. The next `tick` (every 15 minutes, or run the **Publish due posts** workflow yourself) turns the
  request into drafts, which appear under *Granskningskö › Utkast*. Failed requests show their reason in *Dina
  beställningar*. HEIC photos are refused with a hint (iPhone: Settings › Camera › Formats › Most Compatible).
- **Your own photo or video from a computer:** `npm run social -- add-asset image <public https url>` also works.
- **Generated image:** Actions → **Generate image** (optionally with a reference photo URL). **Run it once first and read the log:** the Gemini adapter was written from memory of the API and has not been confirmed against a live key.
- **Generated video:** Actions → **Generate video** → prompt, source image URL, model. It waits for the clip, stores it,
  and prints `asset <id>`. Costs money; refuses to start past the monthly cap. A clip that is still rendering when the
  job times out is collected by the next `tick`.
- **Drafts:** Actions → **Generate drafts** → fill in the idea and channels (paste asset ids to attach media) → review in the queue → approved
posts are published by the next tick.

## Things to know

- **Default branch.** The repository's default branch is currently the feature branch it was created on.
  Scheduled workflows only run from the default branch; change it in Settings → Branches when you merge.
- **Scheduled workflows pause.** GitHub disables scheduled workflows on public repos after 60 days without
  repository activity. Re-enable them in the Actions tab if that happens.
- **Timing.** GitHub's cron is best effort and often a few minutes late; a post goes out at the first tick after
  its scheduled time.
- **Video spend is bounded, not exact.** The cap counts started jobs at their estimate until the provider reports
  the real cost. Two jobs started at the same moment can together pass the cap slightly. Higgsfield does not
  always report actual cost, so figures are estimates.
- **A request can strand too.** If a run is killed while it is drafting a request, the request stays at
  *Skapar utkast…*. Order it again.
- **A cancelled run can strand a post.** If a run is killed mid-publish the variant stays `publishing`
  (retrying automatically could post twice). Check the platform, then fix the row by hand.
- **Public repo.** Code and docs are public. Secrets live only in Actions secrets and are not exposed to
  workflows triggered from forks. Never commit tokens or `.env` files.
- **Platform access.** Instagram publishing needs a business/creator account and Meta app review; LinkedIn
  needs the Posts API product. Neither is something this repo can do for you.
