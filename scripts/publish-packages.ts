// The packages publish-npm.yml releases, in dependency order. Dependency-free
// on purpose: the release-tag job reads this list before any install.

export const LIBRARY_PACKAGE_ORDER = [
  "auth-model",
  "ai-catalog",
  "text-normalize",
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
  "agent-input",
  "mcp-kit",
  "fetch",
  "scan-engine",
] as const;

export const ALL_PACKAGE_ORDER = [...LIBRARY_PACKAGE_ORDER, "cli"] as const;

export const npmReleaseJobId = (directory: string): string =>
  `release-${directory}`;

// Packages whose releases moved to another repository, by package directory,
// with that repository as `github.com/<owner>/<name>`. The journey canary
// accepts npm's latest for one of these only with npm-verified provenance
// from exactly this repository; any other repository declaration falls back
// to the exact version comparison.
// None at present: @stll/time left the package order when its releases moved
// to stella/tooling.
export const MOVED_PACKAGE_REPOSITORIES: Partial<
  Record<(typeof ALL_PACKAGE_ORDER)[number], string>
> = {};
