# Deploy and cost

No Lovable and no server of your own. Four pieces, each with a free tier as far as I know — **check current
pricing and limits on each provider's site before relying on this**; they change.

| Piece | Where | What it does | Cost driver |
|---|---|---|---|
| Database + login | Supabase | `social_*` tables, sign-in for the review queue | Free tier; projects on it pause when inactive (the 15-minute tick keeps it awake) |
| Review queue | Cloudflare Pages (or Netlify, Vercel, GitHub Pages) | Static site from `web/` | Static hosting |
| Worker | GitHub Actions | `tick` every 15 min, daily learn, manual "Generate drafts" | Free for public repos. Private repos have a monthly minute quota; 15-minute ticks would exceed the free quota, so use ~30–60 min or keep the repo public |
| Content generation | Anthropic API | Drafts | Per token — the real running cost |

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

Then add the **variable** `SOCIAL_ENABLED` = `true`. Until it is set, none of the worker workflows do anything.
A channel is enabled when its secrets are present. Optional secret `AUTO_APPROVE_CHANNELS` (e.g. `linkedin`)
skips review for those channels — leave it unset until you trust the output.

Day to day: Actions → **Generate drafts** → fill in the idea and channels → review in the queue → approved
posts are published by the next tick.

## Things to know

- **Default branch.** The repository's default branch is currently the feature branch it was created on.
  Scheduled workflows only run from the default branch; change it in Settings → Branches when you merge.
- **Scheduled workflows pause.** GitHub disables scheduled workflows on public repos after 60 days without
  repository activity. Re-enable them in the Actions tab if that happens.
- **Timing.** GitHub's cron is best effort and often a few minutes late; a post goes out at the first tick after
  its scheduled time.
- **A cancelled run can strand a post.** If a run is killed mid-publish the variant stays `publishing`
  (retrying automatically could post twice). Check the platform, then fix the row by hand.
- **Public repo.** Code and docs are public. Secrets live only in Actions secrets and are not exposed to
  workflows triggered from forks. Never commit tokens or `.env` files.
- **Platform access.** Instagram publishing needs a business/creator account and Meta app review; LinkedIn
  needs the Posts API product. Neither is something this repo can do for you.
