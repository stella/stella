export const PUBLIC_CRAWL_AGENT_CLASSIFICATIONS = {
  training: [
    "GPTBot",
    "ClaudeBot",
    "CCBot",
    "Google-Extended",
    "Applebot-Extended",
    "meta-externalagent",
    "Diffbot",
    "ImagesiftBot",
    "Amazonbot",
  ],
  search: ["OAI-SearchBot", "Claude-SearchBot", "PerplexityBot"],
} as const satisfies Record<"training" | "search", readonly string[]>;

export const PUBLIC_ROBOTS_DENIED_USER_AGENTS =
  PUBLIC_CRAWL_AGENT_CLASSIFICATIONS.training;

export const PUBLIC_ROBOTS_ALLOWED_SEARCH_USER_AGENTS =
  PUBLIC_CRAWL_AGENT_CLASSIFICATIONS.search;

export const ROBOTS_DISALLOWED_PATHS = [
  "/api/",
  "/*?q=",
  "/*&q=",
  "/*?query=",
  "/*&query=",
  "/law/*?q=",
  "/law/*&q=",
] as const;
