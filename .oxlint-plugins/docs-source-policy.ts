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
import {
  filenameForContext,
  getPropertyName,
  isAstNode,
  isCallTo,
  isStringLiteral,
} from "./utils.ts";

const RULE_NAME = "docs-source-policy";
const POLICY_PATH_PARTS = [".claude", "mcp", "doc-sources.ts"] as const;
const POLICY_PATH_SUFFIX = POLICY_PATH_PARTS.join("/");
const FIXTURE_PATH_SUFFIX =
  ".oxlint-plugins/__fixtures__/docs-source-policy.fixture.ts";
// The fixture cannot vary the repository's manifests or policy, so each case
// there passes a whole policy to this marker call and the rule checks it.
const FIXTURE_CASE_CALLEE = "docSourcePolicyCase";
const NO_LLMS_TXT_REASON = "no-llms-txt";
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

// --- Fixture cases -----------------------------------------------------------
//
// A fixture case is a literal: objects with static keys, arrays, and strings.
// Anything else is reported as an unreadable case, never read as an empty
// policy.

type StaticValue = string | StaticValue[] | { [key: string]: StaticValue };

const staticValue = (node: unknown): StaticValue | null => {
  if (isStringLiteral(node)) {
    return node.value;
  }
  if (!isAstNode(node)) {
    return null;
  }
  if (node.type === "ArrayExpression" && Array.isArray(node.elements)) {
    const items: StaticValue[] = [];
    for (const element of node.elements) {
      const item = staticValue(element);
      if (item === null) {
        return null;
      }
      items.push(item);
    }
    return items;
  }
  if (node.type !== "ObjectExpression" || !Array.isArray(node.properties)) {
    return null;
  }
  const entries: Record<string, StaticValue> = {};
  for (const property of node.properties) {
    if (!isAstNode(property) || property.type !== "Property") {
      return null;
    }
    const key =
      property.computed === true ? null : getPropertyName(property.key);
    const value = staticValue(property.value);
    if (key === null || value === null) {
      return null;
    }
    entries[key] = value;
  }
  return entries;
};

const isStaticRecord = (
  value: StaticValue | null | undefined,
): value is Record<string, StaticValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const staticStrings = (value: StaticValue | undefined): string[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }
  const strings = value.filter((item) => typeof item === "string");
  return strings.length === value.length ? strings : null;
};

const fixtureSource = (value: StaticValue): DocSource | null => {
  if (!isStaticRecord(value)) {
    return null;
  }
  const { dependencies, url } = value;
  const [first, ...rest] = staticStrings(dependencies) ?? [];
  if (first === undefined || typeof url !== "string") {
    return null;
  }
  return { dependencies: [first, ...rest], url };
};

const fixtureExclusion = (value: StaticValue): NoLlmsTxtExclusion | null => {
  if (!isStaticRecord(value) || value["reason"] !== NO_LLMS_TXT_REASON) {
    return null;
  }
  const { checkedAt, dependency, explanation, expiresAt } = value;
  if (
    typeof checkedAt !== "string" ||
    typeof dependency !== "string" ||
    typeof explanation !== "string" ||
    typeof expiresAt !== "string"
  ) {
    return null;
  }
  return {
    checkedAt,
    dependency,
    explanation,
    expiresAt,
    reason: NO_LLMS_TXT_REASON,
  };
};

const fixturePolicy = (
  node: unknown,
): DocumentationSourcePolicyOptions | null => {
  const value = staticValue(node);
  if (!isStaticRecord(value)) {
    return null;
  }
  const dependencies = staticStrings(value["dependencies"]);
  const { exclusions: exclusionEntries, now, sources: sourceEntries } = value;
  if (
    dependencies === null ||
    typeof now !== "string" ||
    !isStaticRecord(sourceEntries) ||
    !Array.isArray(exclusionEntries)
  ) {
    return null;
  }
  const sources: Record<string, DocSource> = {};
  for (const [name, entry] of Object.entries(sourceEntries)) {
    const source = fixtureSource(entry);
    if (source === null) {
      return null;
    }
    sources[name] = source;
  }
  const exclusions: NoLlmsTxtExclusion[] = [];
  for (const entry of exclusionEntries) {
    const exclusion = fixtureExclusion(entry);
    if (exclusion === null) {
      return null;
    }
    exclusions.push(exclusion);
  }
  return {
    dependencies: new Set(dependencies),
    exclusions,
    now: new Date(now),
    sources,
  };
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
          fixtureCase:
            "A documentation-source policy fixture case must be one literal policy with dependencies, sources, exclusions and now.",
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
          CallExpression(node) {
            if (!isFixture || !isCallTo(node, FIXTURE_CASE_CALLEE)) {
              return;
            }
            const policy =
              node.arguments.length === 1
                ? fixturePolicy(node.arguments[0])
                : null;
            if (policy === null) {
              context.report({ node, messageId: "fixtureCase" });
              return;
            }
            for (const failure of checkDocumentationSourcePolicy(policy)) {
              context.report({
                data: { failure },
                node,
                messageId: "policyFailure",
              });
            }
          },
          Program(node) {
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
