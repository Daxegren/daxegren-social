import { fileURLToPath } from "node:url";

// Vite runs from the repo root (`vite web`), but Tailwind looks for its config in the
// working directory, so point it at web/tailwind.config.js explicitly.
export default {
  plugins: {
    tailwindcss: { config: fileURLToPath(new URL("./tailwind.config.js", import.meta.url)) },
    autoprefixer: {},
  },
};
