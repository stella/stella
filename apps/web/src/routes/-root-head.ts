export const PUBLIC_KNOWLEDGE_META = {
  name: "public-knowledge",
  content: "enabled",
} as const;

export const createRootHead = (publicKnowledgeEnabled: boolean) => ({
  meta: [
    { charSet: "utf-8" },
    { name: "viewport", content: "width=device-width, initial-scale=1.0" },
    { title: "stella" },
    ...(publicKnowledgeEnabled ? [PUBLIC_KNOWLEDGE_META] : []),
  ],
  links: [{ rel: "icon", href: "/favicon.svg", type: "image/svg+xml" }],
});
