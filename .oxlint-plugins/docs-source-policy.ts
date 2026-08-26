// Every direct external dependency must have one deliberate documentation
// disposition: coverage by an llms.txt source, or a time-bounded explanation
// that no source exists. The policy is exact in both directions, so adding or
// removing a dependency cannot silently drift from the documentation MCP.
//
// A no-llms-txt classification is evidence about mutable upstream state, not
// a permanent exemption. Its quarantine expires within 31 days and the
// scheduled lint run forces another check.

import { eslintCompatPlugin } from "@oxlint/plugins";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  DOC_SOURCE_EXCLUSIONS,
  DOC_SOURCES,
  type DocSource,
  type NoLlmsTxtExclusion,
} from "../.claude/mcp/doc-sources.ts";
import { filenameForContext } from "./utils.ts";

const RULE_NAME = "docs-source-policy";
const POLICY_PATH_PARTS = [".claude", "mcp", "doc-sources.ts"] as const;
const POLICY_PATH_SUFFIX = POLICY_PATH_PARTS.join("/");
const FIXTURE_PATH_SUFFIX =
  ".oxlint-plugins/__fixtures__/docs-source-policy.fixture.ts";
const MAX_QUARANTINE_MILLISECONDS = 31 * 24 * 60 * 60 * 1000;
const EXACT_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

type DocumentationSourcePolicyOptions = {
  dependencies: ReadonlySet<string>;
  exclusions: readonly NoLlmsTxtExclusion[];
  now: Date;
  sources: Readonly<Record<string, DocSource>>;
};

const readDependencyNames = (value: unknown): string[] =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.keys(value)
    : [];

const readManifestDependencies = (manifestPath: string): string[] => {
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"));
  if (typeof manifest !== "object" || manifest === null) {
    return [];
  }
  return [
    ...readDependencyNames(
      "dependencies" in manifest ? manifest.dependencies : undefined,
    ),
    ...readDependencyNames(
      "devDependencies" in manifest ? manifest.devDependencies : undefined,
    ),
  ];
};

const dependencyManifestPaths = (root: string): string[] => {
  const manifests = [path.join(root, "package.json")];
  for (const workspaceRoot of ["apps", "packages"]) {
    const directory = path.join(root, workspaceRoot);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const manifest = path.join(directory, entry.name, "package.json");
      if (existsSync(manifest)) {
        manifests.push(manifest);
      }
    }
  }
  return manifests;
};

export const readFirstLevelDependencies = (root: string): Set<string> =>
  new Set(
    dependencyManifestPaths(root)
      .flatMap(readManifestDependencies)
      .filter((dependency) => !dependency.startsWith("@stll/"))
      .toSorted(),
  );

const parsedExactUtcTimestamp = (value: string): number | null => {
  if (!EXACT_UTC_TIMESTAMP.test(value)) {
    return null;
  }
  const milliseconds = Date.parse(value);
  return Number.isNaN(milliseconds) ? null : milliseconds;
};

const addClassification = (
  classifications: Map<string, string[]>,
  dependency: string,
  disposition: string,
): void => {
  const current = classifications.get(dependency);
  if (current === undefined) {
    classifications.set(dependency, [disposition]);
    return;
  }
  current.push(disposition);
};

export const checkDocumentationSourcePolicy = ({
  dependencies,
  exclusions,
  now,
  sources,
}: DocumentationSourcePolicyOptions): string[] => {
  const failures: string[] = [];
  const classifications = new Map<string, string[]>();

  for (const [sourceName, source] of Object.entries(sources)) {
    if (source.dependencies.length === 0) {
      failures.push(`${sourceName} has no covered dependencies.`);
    }
    if (!URL.canParse(source.url)) {
      failures.push(`${sourceName} has an invalid llms.txt URL.`);
    } else {
      const url = new URL(source.url);
      if (url.protocol !== "https:" || !url.pathname.endsWith("/llms.txt")) {
        failures.push(
          `${sourceName} must use an HTTPS URL ending in /llms.txt.`,
        );
      }
    }
    for (const dependency of source.dependencies) {
      addClassification(classifications, dependency, `source ${sourceName}`);
    }
  }

  for (const exclusion of exclusions) {
    addClassification(classifications, exclusion.dependency, "exclusion");
    if (exclusion.explanation.trim().length === 0) {
      failures.push(`${exclusion.dependency} has no exclusion explanation.`);
    }

    const checkedAt = parsedExactUtcTimestamp(exclusion.checkedAt);
    const expiresAt = parsedExactUtcTimestamp(exclusion.expiresAt);
    if (checkedAt === null) {
      failures.push(
        `${exclusion.dependency} has an invalid no-llms-txt checkedAt timestamp.`,
      );
      continue;
    }
    if (expiresAt === null) {
      failures.push(
        `${exclusion.dependency} has an invalid no-llms-txt expiresAt timestamp.`,
      );
      continue;
    }
    if (expiresAt <= checkedAt) {
      failures.push(
        `${exclusion.dependency} has a no-llms-txt quarantine that does not follow its check time.`,
      );
    }
    if (expiresAt - checkedAt > MAX_QUARANTINE_MILLISECONDS) {
      failures.push(
        `${exclusion.dependency} has a no-llms-txt quarantine longer than 31 days.`,
      );
    }
    if (now.getTime() >= expiresAt) {
      failures.push(
        `${exclusion.dependency} has an expired no-llms-txt quarantine (${exclusion.expiresAt}); recheck its canonical documentation.`,
      );
    }
  }

  for (const dependency of dependencies) {
    if (!classifications.has(dependency)) {
      failures.push(
        `${dependency} is a direct dependency without an llms.txt source or explained exclusion.`,
      );
    }
  }

  for (const [dependency, dispositions] of classifications) {
    if (!dependencies.has(dependency)) {
      failures.push(
        `${dependency} is classified by ${dispositions.join(" and ")} but is not a direct dependency.`,
      );
    }
    if (dispositions.length > 1) {
      failures.push(
        `${dependency} is classified by ${dispositions.join(" and ")}.`,
      );
    }
  }

  return failures.toSorted();
};

const repositoryRootForPolicy = (filename: string): string => {
  let root = filename;
  for (const _part of POLICY_PATH_PARTS) {
    root = path.dirname(root);
  }
  return root;
};

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          fixture:
            "The documentation-source policy rule must execute against its fixture.",
          policyFailure: "{{failure}}",
        },
        schema: [],
      },
      createOnce(context) {
        let filename = "";
        let isFixture = false;
        let isPolicy = false;

        return {
          before() {
            filename = filenameForContext(context);
            isFixture = filename.endsWith(FIXTURE_PATH_SUFFIX);
            isPolicy = filename.endsWith(POLICY_PATH_SUFFIX);
            return isFixture || isPolicy;
          },
          Program(node) {
            if (isFixture) {
              context.report({ node, messageId: "fixture" });
              return;
            }
            if (!isPolicy) {
              return;
            }

            const root = repositoryRootForPolicy(filename);
            const failures = checkDocumentationSourcePolicy({
              dependencies: readFirstLevelDependencies(root),
              exclusions: DOC_SOURCE_EXCLUSIONS,
              now: new Date(),
              sources: DOC_SOURCES,
            });
            for (const failure of failures) {
              context.report({
                data: { failure },
                node,
                messageId: "policyFailure",
              });
            }
          },
        };
      },
    },
  },
});
