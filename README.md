# daxegren-social

Content engine for my own channels. It reads what I have already published, learns what works, generates new
content from a brief (using my own photos and videos, generated media, or both), and schedules and publishes it
— with a review queue in between.

- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Deploy, setup and running costs: [docs/DEPLOY.md](docs/DEPLOY.md)

```
Generate drafts (GitHub Actions form) → review queue (web/) → tick publishes → learn → better drafts
```

## Develop

```bash
npm install
npm test            # engine, Postgres store + RLS (real Postgres via PGlite), worker, review queue
npm run typecheck
npm run dev:web     # review queue; needs web/.env (see web/.env.example)
npm run build:web
```

## Worker commands

```bash
npm run build
export DATABASE_URL=...            # plus channel / ANTHROPIC_API_KEY variables, see docs/DEPLOY.md
npm run social -- migrate
npm run social -- add-asset image https://example.com/me.jpg        # your own photo/video
npm run social -- media video "slow pan" --source https://example.com/product.jpg   # costs money, capped
npm run social -- generate "Why I build in public" --channels linkedin,instagram --assets <id>
npm run social -- tick
npm run social -- ingest instagram
```

## Use as a library

```ts
import { ContentEngine, PostgresStore, LinkedInAdapter, ClaudeContentGenerator } from "@daxegren/social-engine";

const engine = new ContentEngine({
  store: new PostgresStore(sql),
  adapters: { linkedin: new LinkedInAdapter({ authorUrn, accessToken }) },
  generator: new ClaudeContentGenerator({ apiKey }),
});
```
