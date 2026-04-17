import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://stll.app",
  base: "/docs",
  redirects: {
    "/": "/getting-started/introduction",
  },
  integrations: [
    starlight({
      title: "stella",
      logo: {
        src: "./src/assets/stella-logo.svg",
        replacesTitle: true,
      },
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/stella/stella" },
        { icon: "x.com", label: "X", href: "https://x.com/stll_app" },
        { icon: "linkedin", label: "LinkedIn", href: "https://www.linkedin.com/company/stella-app" },
      ],
      sidebar: [
        {
          label: "Getting Started",
          autogenerate: { directory: "getting-started" },
        },
        {
          label: "Guides",
          autogenerate: { directory: "guides" },
        },
        {
          label: "Reference",
          autogenerate: { directory: "reference" },
        },
      ],
      customCss: ["./src/styles/custom.css"],
    }),
  ],
});
