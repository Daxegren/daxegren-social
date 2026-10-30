# daxegren-social

Content engine for my own channels. It reads what I have already published, learns what works, generates new
content from a brief (using my own photos and videos, generated media, or both), and schedules and publishes it.
See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```ts
import { ContentEngine, MemoryStore, InstagramAdapter, LinkedInAdapter, ClaudeContentGenerator } from "@daxegren/social-engine";

const engine = new ContentEngine({
  store: new MemoryStore(), // swap for a Postgres/Supabase Store
  adapters: {
    instagram: new InstagramAdapter({ igUserId, accessToken }),
    linkedin: new LinkedInAdapter({ authorUrn, accessToken }),
  },
  generator: new ClaudeContentGenerator({ apiKey }),
});

await engine.ingest("instagram");                         // learn from what exists
const photo = await engine.addCapturedAsset("image", "https://cdn.example.com/me.jpg");
const brief = await engine.createBrief({ idea: "...", assetIds: [photo.id] });
const drafts = await engine.proposeVariants(brief.id, ["instagram", "linkedin"]);
await engine.approve(drafts[0].id, { scheduledAt: new Date("2026-11-03T08:00:00Z") });
await engine.tick();                                      // run on an interval
```

```bash
npm install
npm test
npm run build
```
