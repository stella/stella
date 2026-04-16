import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://stll.app",
  integrations: [sitemap(), react()],
  vite: {
    plugins: [tailwindcss()],
  },
});
