import { THEME_COLOR_META } from "@/lib/theme-color";

export const PUBLIC_KNOWLEDGE_META = {
  name: "public-knowledge",
  content: "enabled",
} as const;

export const createRootHead = (publicKnowledgeEnabled: boolean) => ({
  meta: [
    { charSet: "utf-8" },
    {
      name: "viewport",
      // `viewport-fit=cover` lets the shell paint under the notch and home
      // indicator; edge-attached surfaces pad with the safe-area insets.
      content: "width=device-width, initial-scale=1.0, viewport-fit=cover",
    },
    ...THEME_COLOR_META,
    { title: "stella" },
    { name: "robots", content: "noindex,nofollow" },
    ...(publicKnowledgeEnabled ? [PUBLIC_KNOWLEDGE_META] : []),
  ],
  links: [{ rel: "icon", href: "/favicon.svg", type: "image/svg+xml" }],
});
