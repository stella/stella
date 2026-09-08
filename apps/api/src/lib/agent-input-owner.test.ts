/**
 * Census: the surfaces that read a value an agent wrote go through the owner
 * for that kind.
 *
 * A second reader is the bug class `@stll/agent-input` exists to kill. It never
 * looks like a bug — it is one `Number(value)` in a handler, one
 * `new Date(value)` in a fill step — and it silently answers differently from
 * every other surface for `4 000`, `1. 10. 2026`, `ano`, `cs_CZ`. So the
 * spellings are enumerated here rather than left to review.
 *
 * `Intl.getCanonicalLocales` also carries a `confine-owner` ownership row, so
 * it fails the lint before it reaches this test; the row cannot carry a second
 * member chain, which is why `supportedLocalesOf` is counted here.
 *
 * The allowlist only shrinks: every entry has to still match, so a path cannot
 * stay on it after its reader moves to the owner.
 */

import { describe, expect, test } from "bun:test";
import path from "node:path";

// Repo root, four levels up from apps/api/src/lib.
const REPO_ROOT = path.resolve(import.meta.dir, "../../../..");

/** The package that owns every kind. The census scans api call sites, so this
 *  only keeps the owner's own readers out of the count. */
const OWNER_DIR = "packages/agent-input/src";

/** Where a value an agent wrote is read: the template engine, the template
 *  handlers, and the template half of the MCP surface. */
const AGENT_VALUE_SURFACES = [
  "apps/api/src/lib/docx/**/*.ts",
  "apps/api/src/lib/templates/**/*.ts",
  "apps/api/src/handlers/templates/**/*.ts",
  "apps/api/src/mcp/template-*.ts",
] as const;

type AllowedSite = {
  path: string;
  reason: string;
};

type BypassRule = {
  /** What the owner reads, and the module that owns it. */
  owner: string;
  /** File globs the spelling is counted in. */
  include: readonly string[];
  /** The spelling of a second reader. */
  pattern: RegExp;
  allowed: readonly AllowedSite[];
};

const BYPASS_RULES = {
  locale: {
    owner: "normalizeLocale / isPlausibleLocale in @stll/agent-input",
    // Locale plausibility is asked about all over the api, not only on the
    // template surface, so this one is counted app-wide.
    include: ["apps/api/src/**/*.ts"],
    pattern: /Intl\.DateTimeFormat\.supportedLocalesOf\(/u,
    allowed: [],
  },
  date: {
    owner: "normalizeDateValue in @stll/agent-input",
    include: AGENT_VALUE_SURFACES,
    // `new Date()` with no argument is a clock read, not a parse.
    pattern: /new Date\((?![\s)])|Date\.parse\(/u,
    allowed: [
      {
        path: "apps/api/src/mcp/template-persistence.ts",
        reason:
          "A staleness cutoff computed from the clock and a duration, not a date anyone wrote.",
      },
    ],
  },
  number: {
    owner: "normalizeNumber in @stll/agent-input",
    include: AGENT_VALUE_SURFACES,
    pattern:
      /(?:^|[^\w.])(?:Number|parseFloat|parseInt)\(|Number\.parse(?:Float|Int)\(/u,
    allowed: [
      {
        path: "apps/api/src/lib/docx/ooxml.ts",
        reason: "OOXML numbering ids, written by Word and by us.",
      },
      {
        path: "apps/api/src/lib/docx/resolve-clause-slots.ts",
        reason: "A clause version suffix from our own slot marker.",
      },
      {
        path: "apps/api/src/lib/docx/strip-custom-xml-manifest.ts",
        reason:
          "A custom XML slot index out of a zip entry name, which Word and we wrote; nobody spells it.",
      },
    ],
  },
  boolean: {
    owner: "normalizeBoolean in @stll/agent-input",
    include: AGENT_VALUE_SURFACES,
    pattern: /[=]==\s*"(?:true|false|yes|no)"/u,
    allowed: [
      {
        path: "apps/api/src/handlers/templates/check-template.ts",
        reason:
          "A condition grammar keyword, not a value: `true` there is a literal in the expression an author wrote.",
      },
    ],
  },
} as const satisfies Record<string, BypassRule>;

const isSource = (file: string): boolean =>
  !file.includes(".test.") && !file.startsWith(OWNER_DIR);

const filesMatching = async (rule: BypassRule): Promise<string[]> => {
  const matched = new Set<string>();
  for (const include of rule.include) {
    for await (const file of new Bun.Glob(include).scan({ cwd: REPO_ROOT })) {
      if (!isSource(file) || matched.has(file)) {
        continue;
      }
      const text = await Bun.file(path.join(REPO_ROOT, file)).text();
      if (text.split("\n").some((line) => rule.pattern.test(line))) {
        matched.add(file);
      }
    }
  }
  return [...matched].sort();
};

describe("every agent-written value kind has one reader", () => {
  for (const [kind, rule] of Object.entries(BYPASS_RULES)) {
    test(`${kind} values are read by ${rule.owner}`, async () => {
      const matched = await filesMatching(rule);
      expect(
        matched.filter(
          (file) =>
            !rule.allowed.some(({ path: allowedPath }) => allowedPath === file),
        ),
      ).toEqual([]);
    });

    test(`the ${kind} allowlist carries nothing stale`, async () => {
      // Both directions: an entry whose reader moved to the owner has to leave
      // the list, or the list stops meaning what it says.
      const matched = await filesMatching(rule);
      expect(
        rule.allowed
          .map(({ path: allowedPath }) => allowedPath)
          .filter((file) => !matched.includes(file)),
      ).toEqual([]);
    });
  }
});
