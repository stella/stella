// The packages publish-npm.yml releases, in dependency order. Dependency-free
// on purpose: the release-tag job reads this list before any install.

export const LIBRARY_PACKAGE_ORDER = [
  "auth-model",
  "ai-catalog",
  "anonymize-chat",
  "ui",
  "chat",
  "country-codes",
  "business-registries",
  "conditions",
  "template-conditions",
  "docx-utils",
  "start-runtime",
  "ssr-kit",
  "ssr-testkit",
  "money",
  "calculations",
  "workspace-model",
  "workspace-ui",
  "stable-stringify",
  "time",
  "text-normalize",
  "agent-input",
  "mcp-kit",
] as const;

export const ALL_PACKAGE_ORDER = [...LIBRARY_PACKAGE_ORDER, "cli"] as const;
