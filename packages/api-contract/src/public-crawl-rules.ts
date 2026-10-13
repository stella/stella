export const PUBLIC_ROBOTS_DENIED_USER_AGENTS = [
  "GPTBot",
  "ClaudeBot",
  "CCBot",
  "Google-Extended",
  "Applebot-Extended",
  "PerplexityBot",
  "Amazonbot",
  "meta-externalagent",
  "Diffbot",
  "ImagesiftBot",
] as const;

export const ROBOTS_DISALLOWED_PATHS = [
  "/api/",
  "/*?q=",
  "/*&q=",
  "/*?query=",
  "/*&query=",
  "/law/*?q=",
  "/law/*&q=",
] as const;
