export const CODE_CHECK_LEGS = ["api", "web", "rest"] as const;
export type CodeCheckLeg = (typeof CODE_CHECK_LEGS)[number];

// Keep three runners: move the remaining slow lint/typecheck workspaces into
// the API and web legs. Unlisted and newly added workspaces belong to rest.
const NAMED_LEG_PATHS = {
  api: [
    "apps/api",
    "apps/collab",
    "apps/legal-atlas-runner",
    "packages/agent-engine",
    "packages/api-client",
    "packages/api-contract",
    "packages/concurrency",
    "packages/fetch",
    "packages/redis-config",
    "packages/scripts",
    "packages/start-runtime",
  ],
  web: [
    "apps/web",
    "apps/landing",
    "apps/desktop",
    "apps/extension",
    "apps/playground",
    "packages/cli",
    "packages/ui",
    "packages/workspace-ui",
    "packages/ssr-kit",
    "packages/ssr-testkit",
    "packages/analytics-config",
    "packages/clipboard",
    "packages/skills",
    "packages/template-packs",
    "packages/anonymize-chat",
  ],
} as const satisfies Record<Exclude<CodeCheckLeg, "rest">, readonly string[]>;

export const ownsCodeCheckPath = (file: string, leg: CodeCheckLeg): boolean => {
  if (leg === "rest") {
    return !CODE_CHECK_LEGS.some(
      (other) => other !== "rest" && ownsCodeCheckPath(file, other),
    );
  }
  return NAMED_LEG_PATHS[leg].some(
    (owner) => file === owner || file.startsWith(`${owner}/`),
  );
};
