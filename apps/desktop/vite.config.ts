import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [tailwindcss(), react()],
  root: "src/mainview",
  build: {
    emptyOutDir: true,
    outDir: "../../dist",
  },
  server: {
    port: 5177,
    strictPort: true,
  },
});
