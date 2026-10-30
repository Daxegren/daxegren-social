import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Run from the repo root: `vite web`, `vite build web`.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
});
