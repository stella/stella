import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import path from "node:path";

import { assertProperty } from "@stll/property-testing";

import { toSafeId } from "@/api/lib/branded-types";
import {
  basisForReader,
  findingForReader,
  referencesForReader,
  referenceWorkspacesByPosition,
} from "@/api/lib/document-review/reference-visibility";
import type { ReviewFinding } from "@/api/lib/document-review/review-grade";
import type {
  DocumentReviewRunBasis,
  PinnedReference,
} from "@/api/lib/document-review/run-contract";

const REFERENCE_WORKSPACE = "11111111-1111-4111-8111-111111111111";
const OTHER_REFERENCE_WORKSPACE = "22222222-2222-4222-8222-222222222222";
const REFERENCE_POSITION = "33333333-3333-4333-8333-333333333333";
const TIERS_POSITION = "44444444-4444-4444-8444-444444444444";

const passage = (workspaceId: string) => ({
  id: Bun.randomUUIDv7(),
  workspaceId,
  entityId: Bun.randomUUIDv7(),
  fileFieldId: Bun.randomUUIDv7(),
  entityVersionId: Bun.randomUUIDv7(),
  blockId: "b-1",
});

const reference: PinnedReference = {
  workspaceId: toSafeId<"workspace">(REFERENCE_WORKSPACE),
  workspaceName: "Precedent matter",
  entityId: toSafeId<"entity">(Bun.randomUUIDv7()),
  fileFieldId: toSafeId<"field">(Bun.randomUUIDv7()),
  entityVersionId: toSafeId<"entityVersion">(Bun.randomUUIDv7()),
  contentSha256: "a".repeat(64),
  name: "Precedent SPA",
};

const basis: DocumentReviewRunBasis = {
  playbook: {
    definitionId: null,
    versionId: null,
    provenance: "ephemeral",
    definitionSnapshot: {
      name: "Positions confirmed for this review",
      positions: {
        version: 3,
        items: [
          {
            mode: "graded",
            sourceId: REFERENCE_POSITION,
            issue: "Claims time bar",
            severity: "high",
            standard: {
              source: "reference",
              termKind: "parameter",
              passages: [
                passage(REFERENCE_WORKSPACE),
                passage(OTHER_REFERENCE_WORKSPACE),
              ],
            },
            ask: { mode: "auto" },
            enabled: true,
          },
        ],
      },
    },
  },
  references: [reference],
  perspective: { type: "neutral" },
};

const referenceFinding: ReviewFinding = {
  positionId: REFERENCE_POSITION,
  issue: "Claims time bar",
  severity: "high",
  standardSource: "reference",
  verdict: "deviation",
  delta: {
    kind: "parameter",
    target: {
      text: "12 months",
      value: 12,
      unit: "months",
      citation: { blockId: "t-1", text: "Claims within 12 months." },
    },
    standard: {
      text: "24 months",
      value: 24,
      unit: "months",
      citation: { blockId: "b-1", text: "Claims within 24 months." },
    },
  },
  extracted: null,
  rationale: null,
  consensus: "single",
  impact: "unfavourable",
  explanation: { type: "comparison", text: "The standard allows 24 months." },
  recommendation: "Extend the period to 24 months.",
  citations: [{ blockId: "t-1", text: "Claims within 12 months." }],
  referenceCitations: [
    {
      fileFieldId: toSafeId<"field">(Bun.randomUUIDv7()),
      passages: [{ id: Bun.randomUUIDv7(), blockId: "b-1" }],
    },
  ],
  fix: {
    kind: "replaceBlock",
    blockId: "t-1",
    text: "Claims within 24 months.",
  },
};

const positionWorkspaces = referenceWorkspacesByPosition(basis);

describe("findingForReader", () => {
  test("returns the finding unchanged when every reference matter is readable", () => {
    const readable = new Set([REFERENCE_WORKSPACE, OTHER_REFERENCE_WORKSPACE]);

    expect(
      findingForReader(referenceFinding, { positionWorkspaces, readable }),
    ).toBe(referenceFinding);
  });

  test("keeps the target-side verdict and drops fields written from the reference", () => {
    const readable = new Set([REFERENCE_WORKSPACE]);

    const shown = findingForReader(referenceFinding, {
      positionWorkspaces,
      readable,
    });

    expect(shown).toMatchObject({
      positionId: REFERENCE_POSITION,
      verdict: "deviation",
      citations: referenceFinding.citations,
      delta: { kind: "language" },
      rationale: null,
      recommendation: null,
      referenceCitations: referenceFinding.referenceCitations,
      fix: null,
      referenceDetail: "withheld",
    });
    expect(shown.explanation).toBeUndefined();
    expect(shown.impact).toBeUndefined();
    expect(JSON.stringify(shown)).not.toContain("24 months");
  });

  test("leaves findings for positions without reference passages alone", () => {
    const tiersFinding: ReviewFinding = {
      ...referenceFinding,
      positionId: TIERS_POSITION,
      standardSource: "tiers",
    };

    expect(
      findingForReader(tiersFinding, {
        positionWorkspaces,
        readable: new Set(),
      }),
    ).toBe(tiersFinding);
  });
});

describe("referencesForReader", () => {
  test("keeps ids and drops names and digests of references outside the readable set", () => {
    expect(referencesForReader([reference], new Set())).toEqual([
      { ...reference, workspaceName: null, name: null, contentSha256: null },
    ]);
    expect(
      referencesForReader([reference], new Set([REFERENCE_WORKSPACE])),
    ).toEqual([reference]);
  });
});

describe("basisForReader", () => {
  const prose = {
    purpose: "Caps the claim window",
    guidance: "Compare with the 24-month limit",
    negotiation: { rationale: "Market standard is 24 months" },
  };
  const pinned = basis.playbook.definitionSnapshot.positions.items.at(0);
  if (pinned?.mode !== "graded") {
    throw new TypeError("fixture has no graded position");
  }
  const withProse: DocumentReviewRunBasis = {
    playbook: {
      definitionId: basis.playbook.definitionId,
      versionId: basis.playbook.versionId,
      provenance: basis.playbook.provenance,
      definitionSnapshot: {
        name: basis.playbook.definitionSnapshot.name,
        positions: { version: 3, items: [{ ...pinned, ...prose }] },
      },
    },
    references: basis.references,
    perspective: basis.perspective,
  };
  const positionsFor = (readable: readonly string[]) =>
    basisForReader(withProse, new Set(readable)).playbook.definitionSnapshot
      .positions.items;

  test("keeps a reference position whole when every source matter is readable", () => {
    expect(
      positionsFor([REFERENCE_WORKSPACE, OTHER_REFERENCE_WORKSPACE]),
    ).toEqual(withProse.playbook.definitionSnapshot.positions.items);
  });

  test("drops reference prose when any source matter is unreadable", () => {
    const [position] = positionsFor([REFERENCE_WORKSPACE]);

    expect(position).toEqual({
      mode: "graded",
      sourceId: REFERENCE_POSITION,
      issue: "Claims time bar",
      severity: "high",
      standard: pinned.standard,
      ask: { mode: "auto" },
      enabled: true,
      referenceDetail: "withheld",
    });
    expect(JSON.stringify(position)).not.toContain("month");
    expect(JSON.stringify(position)).not.toContain("claim window");
  });

  test("projects the reference list with the positions", () => {
    expect(basisForReader(withProse, new Set()).references).toEqual(
      referencesForReader(withProse.references, new Set()),
    );
  });
});

/** Every prose string in a value: the string leaves that contain whitespace,
 *  so ids, block ids and enum values never count as text. */
const proseLeaves = (value: unknown): string[] => {
  if (typeof value === "string") {
    return /\s/u.test(value) ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(proseLeaves);
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap(proseLeaves);
  }
  return [];
};

describe("basis and finding projections agree", () => {
  // The reference-derived prose, as the finding projection itself decides it:
  // whatever it drops for a reader who can open none of the source matters.
  const withheldProse = (() => {
    const shown = new Set(
      proseLeaves(
        findingForReader(referenceFinding, {
          positionWorkspaces,
          readable: new Set(),
        }),
      ),
    );
    return proseLeaves(referenceFinding).filter((text) => !shown.has(text));
  })();
  const pool = [REFERENCE_WORKSPACE, OTHER_REFERENCE_WORKSPACE, TIERS_POSITION];

  test("the basis projection shows reference prose exactly when the finding projection does", () => {
    expect(withheldProse.length).toBeGreaterThan(0);
    const prose = withheldProse.join(" | ");

    assertProperty(
      "the basis projection shows reference prose exactly when the finding projection does",
      fc.property(
        fc.record({
          source: fc.constantFrom("reference", "tiers"),
          passageWorkspaces: fc.subarray(pool, { minLength: 1 }),
          readable: fc.subarray(pool),
        }),
        ({ source, passageWorkspaces, readable }) => {
          const sourceId = Bun.randomUUIDv7();
          const position = {
            mode: "graded" as const,
            sourceId,
            issue: referenceFinding.issue,
            severity: "high" as const,
            standard:
              source === "reference"
                ? {
                    source: "reference" as const,
                    termKind: "parameter" as const,
                    passages: passageWorkspaces.map(passage),
                  }
                : {
                    source: "tiers" as const,
                    tiers: {
                      acceptable: { rules: [] },
                      fallback: { entries: [] },
                      notAcceptable: { rules: [] },
                    },
                  },
            ask: { mode: "auto" as const },
            purpose: prose,
            guidance: prose,
            negotiation: {
              rationale: prose,
              talkingPoints: [prose],
              escalation: prose,
            },
            enabled: true,
          };
          const runBasis: DocumentReviewRunBasis = {
            playbook: {
              definitionId: null,
              versionId: null,
              provenance: "ephemeral",
              definitionSnapshot: {
                name: "Positions confirmed for this review",
                positions: { version: 3, items: [position] },
              },
            },
            references: [],
            perspective: { type: "neutral" },
          };
          const readableSet = new Set(readable);
          // Exact leaves: a withheld fragment can recur inside a kept
          // target-side quotation, which is not the reference speaking.
          const findingShown = new Set(
            proseLeaves(
              findingForReader(
                {
                  ...referenceFinding,
                  positionId: sourceId,
                  standardSource: source,
                },
                {
                  positionWorkspaces: referenceWorkspacesByPosition(runBasis),
                  readable: readableSet,
                },
              ),
            ),
          );
          const basisShown = JSON.stringify(
            basisForReader(runBasis, readableSet),
          );

          for (const text of [...withheldProse, referenceFinding.issue]) {
            expect({ text, shown: basisShown.includes(text) }).toEqual({
              text,
              shown: findingShown.has(text),
            });
          }
        },
      ),
    );
  });
});

// Every module that reads a run's stored basis, and what its response carries
// of it. A new reader fails the first test until it is listed, and a reader
// listed as `projects` must answer through `basisForReader`.
const STORED_BASIS_READERS = {
  "lib/document-review/read-run-detail.ts": "projects",
  "handlers/document-reviews/export-run.ts": "projects",
  // Answers with the playbook name, provenance, reference count and role only.
  "handlers/document-reviews/list-runs.ts": "summary",
  // Refuses unless every reference matter is readable.
  "handlers/playbooks/from-run/create.ts": "gated",
  "lib/document-review/run-queue.ts": "internal",
  "lib/document-review/table-run-findings.ts": "internal",
  "lib/document-review/review-suggestion-staging.ts": "internal",
} as const satisfies Record<
  string,
  "projects" | "summary" | "gated" | "internal"
>;

describe("stored run basis readers", () => {
  const apiSource = path.resolve(import.meta.dir, "../..");
  const source = (file: string) =>
    readFileSync(path.join(apiSource, file), "utf-8");

  test("every reader of the stored basis is classified", () => {
    const readers = [...new Bun.Glob("**/*.ts").scanSync(apiSource)]
      .filter((file) => !file.endsWith(".test.ts"))
      .filter((file) => source(file).includes("documentReviewRuns.basis"));

    expect(readers.toSorted()).toEqual(
      Object.keys(STORED_BASIS_READERS).toSorted(),
    );
  });

  test("every responding reader projects the basis for its reader", () => {
    const projecting = Object.entries(STORED_BASIS_READERS).flatMap(
      ([file, kind]) => (kind === "projects" ? [file] : []),
    );
    expect(
      projecting.filter((file) => !source(file).includes("basisForReader(")),
    ).toEqual([]);
  });
});
