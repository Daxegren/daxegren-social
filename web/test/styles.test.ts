import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import postcssrc from "postcss-load-config";
import { expect, it } from "vitest";

// Regression: Tailwind silently emitted no utilities when it could not find its config,
// which leaves the whole UI unstyled while every other test still passes.
// Loads web/postcss.config.js the way Vite does, with the working directory at the repo root.
it("postcss generates the utility classes the components use", async () => {
  const webDir = fileURLToPath(new URL("..", import.meta.url));
  const from = fileURLToPath(new URL("../src/index.css", import.meta.url));
  const { plugins } = await postcssrc({}, webDir);
  const out = await postcss(plugins).process(readFileSync(from, "utf8"), { from });
  for (const cls of ["bg-emerald-600", "border-slate-200", "tabular-nums", "max-w-3xl"]) {
    expect(out.css, cls).toContain(`.${cls}`);
  }
});
