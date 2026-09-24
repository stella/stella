// Fixture for docs-source-policy/docs-source-policy.
//
// On the repository policy the rule reads the real manifests and sources, so
// the fixture states each policy inline: every `docSourcePolicyCase(...)` call
// is checked as a whole policy and reports its failures at the call.

const docSourcePolicyCase = (policy: unknown): unknown => policy;

// expect-clean: docs-source-policy/docs-source-policy
export const exhaustivePolicy = docSourcePolicyCase({
  dependencies: ["documented-package", "undocumented-package"],
  sources: {
    Example: {
      dependencies: ["documented-package"],
      url: "https://example.com/llms.txt",
    },
  },
  exclusions: [
    {
      dependency: "undocumented-package",
      reason: "no-llms-txt",
      explanation: "The canonical documentation had no llms.txt endpoint.",
      checkedAt: "2026-08-26T00:00:00.000Z",
      expiresAt: "2026-09-25T00:00:00.000Z",
    },
  ],
  now: "2026-08-27T00:00:00.000Z",
});

// oxlint-disable-next-line docs-source-policy/docs-source-policy -- a direct dependency with no source or exclusion
export const unclassifiedDependency = docSourcePolicyCase({
  dependencies: ["documented-package", "new-package"],
  sources: {
    Example: {
      dependencies: ["documented-package"],
      url: "https://example.com/llms.txt",
    },
  },
  exclusions: [],
  now: "2026-08-27T00:00:00.000Z",
});

// oxlint-disable-next-line docs-source-policy/docs-source-policy -- the quarantine expired before `now`
export const expiredQuarantine = docSourcePolicyCase({
  dependencies: ["undocumented-package"],
  sources: {},
  exclusions: [
    {
      dependency: "undocumented-package",
      reason: "no-llms-txt",
      explanation: "The canonical documentation had no llms.txt endpoint.",
      checkedAt: "2026-08-26T00:00:00.000Z",
      expiresAt: "2026-08-27T00:00:00.000Z",
    },
  ],
  now: "2026-08-27T00:00:00.000Z",
});

// oxlint-disable-next-line docs-source-policy/docs-source-policy -- one dependency with both a source and an exclusion
export const doubleClassification = docSourcePolicyCase({
  dependencies: ["documented-package"],
  sources: {
    Example: {
      dependencies: ["documented-package"],
      url: "https://example.com/llms.txt",
    },
  },
  exclusions: [
    {
      dependency: "documented-package",
      reason: "no-llms-txt",
      explanation: "The canonical documentation had no llms.txt endpoint.",
      checkedAt: "2026-08-26T00:00:00.000Z",
      expiresAt: "2026-09-25T00:00:00.000Z",
    },
  ],
  now: "2026-08-27T00:00:00.000Z",
});

const dependencyNames = ["documented-package"];

// oxlint-disable-next-line docs-source-policy/docs-source-policy -- a case that is not a literal policy
export const unreadableCase = docSourcePolicyCase({
  dependencies: dependencyNames,
});
