import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { propertyConfig } from "@stll/property-testing";

import type { PropertyContent } from "@/api/db/schema-validators";
import { dehydrateRefs } from "@/api/handlers/chat/tools/registry-adapter/ref-mediation";
import { projectForChat } from "@/api/lib/chat/projection-schema";
import { LIST_PLAYBOOKS_DETAIL_PROJECTION } from "@/api/lib/chat/projections";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import {
  POSITION_SEVERITIES,
  positionSchema,
} from "@/api/lib/workflow/playbook-positions";
import type { Position } from "@/api/lib/workflow/playbook-positions";
import {
  mergePlaybookPositions,
  PLAYBOOK_ANSWER_TYPES,
  playbookPositionInputSchema,
} from "@/api/mcp/playbook-position-input";
import type { PlaybookPositionInput } from "@/api/mcp/playbook-position-input";

const PLAYBOOK_ID = "5b1f0a2e-8c5d-4e57-9a3b-0d2f6c1e7a90";
const CLAUSE_ID = "0c7a3f52-1b6e-4d8a-b2c4-9e5f7a1d3b68";

/** Deterministic ids, so a merge is a pure function of its arguments. */
const counterMintId = () => {
  let next = 0;
  return () => {
    next += 1;
    return `00000000-0000-4000-8000-${next.toString(16).padStart(12, "0")}`;
  };
};

const merge = (
  args: Omit<
    Parameters<typeof mergePlaybookPositions>[0],
    "mintId" | "removeSourceIds"
  > & { removeSourceIds?: readonly string[] },
) =>
  mergePlaybookPositions({
    removeSourceIds: [],
    ...args,
    mintId: counterMintId(),
  });

const text = (maxLength: number) =>
  fc
    .string({ minLength: 1, maxLength })
    .filter((value) => value.trim().length > 0);

const tierRuleArbitrary = fc.record({ id: fc.uuid(), text: text(60) });

const gradedArbitrary = fc.record(
  {
    mode: fc.constant("graded" as const),
    sourceId: fc.uuid(),
    issue: text(40),
    severity: fc.constantFrom(...POSITION_SEVERITIES),
    standard: fc.record({
      source: fc.constant("tiers" as const),
      tiers: fc.record({
        acceptable: fc.record(
          {
            rules: fc.array(tierRuleArbitrary, { minLength: 1, maxLength: 3 }),
            ideal: fc.oneof(
              fc.record({
                source: fc.constant("inline" as const),
                text: text(80),
              }),
              fc.record({
                source: fc.constant("clause" as const),
                clauseId: fc.constant(CLAUSE_ID),
              }),
            ),
          },
          { requiredKeys: ["rules"] },
        ),
        fallback: fc.record({
          entries: fc.array(
            fc.record(
              { id: fc.uuid(), text: text(60), label: text(20) },
              { requiredKeys: ["id", "text"] },
            ),
            { maxLength: 2 },
          ),
        }),
        notAcceptable: fc.record({
          rules: fc.array(tierRuleArbitrary, { maxLength: 3 }),
        }),
      }),
    }),
    check: fc.constant({
      kind: "presence" as const,
      expectation: "required" as const,
    }),
    ask: fc.oneof(
      fc.constant({ mode: "auto" as const }),
      fc.record({
        mode: fc.constant("auto" as const),
        derived: fc.record({
          question: text(40),
          content: fc.constant({ version: 1 as const, type: "text" as const }),
          rulesHash: text(16),
        }),
      }),
      fc.record({
        mode: fc.constant("manual" as const),
        question: text(40),
        content: fc.constant({ version: 1 as const, type: "int" as const }),
      }),
    ),
    purpose: text(60),
    guidance: text(60),
    negotiation: fc.record(
      {
        rationale: text(60),
        talkingPoints: fc.array(text(40), { maxLength: 3 }),
        escalation: text(40),
      },
      { requiredKeys: [] },
    ),
    enabled: fc.boolean(),
  },
  {
    requiredKeys: [
      "mode",
      "sourceId",
      "issue",
      "severity",
      "standard",
      "ask",
      "enabled",
    ],
  },
);

const SELECT_CONTENT: PropertyContent = {
  version: 1,
  type: "single-select",
  options: [{ color: "blue", value: "Yes" }],
  fallback: null,
};

const extractArbitrary = fc.record(
  {
    mode: fc.constant("extract" as const),
    sourceId: fc.uuid(),
    issue: text(40),
    ask: fc.record({
      question: text(60),
      content: fc.oneof(
        fc.constantFrom(
          { version: 1 as const, type: "text" as const },
          { version: 1 as const, type: "date" as const },
          { version: 1 as const, type: "int" as const },
        ),
        // Not expressible as an `answer_type`: the merge must carry it over.
        fc.constant(SELECT_CONTENT),
      ),
    }),
    guidance: text(60),
    enabled: fc.boolean(),
  },
  { requiredKeys: ["mode", "sourceId", "issue", "ask", "enabled"] },
);

/** Stored positions as the editor leaves them: distinct ids, distinct issues. */
const storedArbitrary: fc.Arbitrary<Position[]> = fc
  .uniqueArray(fc.oneof(gradedArbitrary, extractArbitrary), {
    minLength: 1,
    maxLength: 5,
    selector: (position) => position.sourceId,
  })
  .map((positions) =>
    positions.map((position, index) => ({
      ...position,
      issue: `${index} ${position.issue}`,
    })),
  );

const isExpressibleAnswerType = (
  type: string,
): type is (typeof PLAYBOOK_ANSWER_TYPES)[number] =>
  PLAYBOOK_ANSWER_TYPES.some((candidate) => candidate === type);

const snakeCaseKey = (key: string): string =>
  key.replaceAll(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);

const toSnakeCase = (value: unknown): unknown => {
  if (isUnknownArray(value)) {
    return value.map(toSnakeCase);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      snakeCaseKey(key),
      toSnakeCase(entry),
    ]),
  );
};

/**
 * What a model does with a position it read: respell the keys in snake_case
 * flatten the ladder (rules and ideal wording as plain strings, `tiers` lifted
 * out of `standard`), and drop what `save_playbook` does not take
 * (the server-owned `ask` of a graded position and `check`, an extract
 * position's `content`, a clause-linked `ideal`). Anything else it left behind would fail the strict input parse, so
 * the parse below is what proves the read shape is a save shape.
 */
const readBackToInput = (projected: unknown): PlaybookPositionInput => {
  const snake = toSnakeCase(projected);
  if (!isRecord(snake)) {
    throw new TypeError("A projected position is an object");
  }
  const { ask, check: _check, ...rest } = snake;
  if (snake["mode"] === "extract" && isRecord(ask)) {
    const content = ask["content"];
    const type = isRecord(content) ? content["type"] : undefined;
    return v.parse(playbookPositionInputSchema, {
      ...rest,
      ask: {
        question: ask["question"],
        ...(typeof type === "string" && isExpressibleAnswerType(type)
          ? { answer_type: type }
          : {}),
      },
    });
  }
  const { standard, ...graded } = rest;
  const read = v.parse(
    v.object({
      tiers: v.object({
        acceptable: v.object({
          rules: v.array(v.object({ text: v.string() })),
          ideal: v.optional(
            v.object({ source: v.string(), text: v.optional(v.string()) }),
          ),
        }),
        fallback: v.object({
          entries: v.array(
            v.object({ text: v.string(), label: v.optional(v.string()) }),
          ),
        }),
        not_acceptable: v.object({
          rules: v.array(v.object({ text: v.string() })),
        }),
      }),
    }),
    standard,
  ).tiers;
  const { ideal } = read.acceptable;
  return v.parse(playbookPositionInputSchema, {
    ...graded,
    tiers: {
      acceptable: read.acceptable.rules.map(({ text: rule }) => rule),
      ...(ideal?.source === "inline" ? { ideal: ideal.text } : {}),
      fallback: read.fallback.entries,
      not_acceptable: read.not_acceptable.rules.map(({ text: rule }) => rule),
    },
  });
};

const readThroughChatProjection = (positions: readonly Position[]) => {
  const refRegistry = createChatRefRegistry();
  const projected = projectForChat({
    dehydration: dehydrateRefs({
      args: {},
      inputRefs: [],
      refRegistry,
    }).unwrap(),
    payload: {
      playbook: {
        id: PLAYBOOK_ID,
        name: "NDA",
        description: null,
        scope: null,
        positions: { version: 3, items: positions },
        status: "draft",
        approvedAt: null,
        createdAt: "2026-09-20T10:00:00.000Z",
        updatedAt: "2026-09-20T10:00:00.000Z",
      },
    },
    refRegistry,
    schema: LIST_PLAYBOOKS_DETAIL_PROJECTION,
    source: "run-registry-tool",
    toolName: "list_playbooks",
  }).unwrap();
  const parsed = v.parse(
    v.object({
      playbook: v.object({
        positions: v.object({ items: v.array(v.unknown()) }),
      }),
    }),
    projected,
  );
  return parsed.playbook.positions.items;
};

const gradedInput = (
  overrides: Partial<Extract<PlaybookPositionInput, { mode: "graded" }>> = {},
): PlaybookPositionInput => ({
  mode: "graded",
  issue: "Liability cap",
  severity: "high",
  tiers: {
    acceptable: ["Cap at 12 months of fees"],
    fallback: [],
    not_acceptable: ["Uncapped liability"],
  },
  ...overrides,
});

type GradedPosition = Extract<Position, { mode: "graded" }>;

const storedGraded = (
  overrides: Partial<GradedPosition> = {},
): GradedPosition => ({
  mode: "graded",
  sourceId: "11111111-1111-4111-8111-111111111111",
  issue: "Liability cap",
  severity: "high",
  standard: {
    source: "tiers",
    tiers: {
      acceptable: {
        rules: [
          {
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            text: "Cap at 12 months of fees",
          },
        ],
      },
      fallback: { entries: [] },
      notAcceptable: {
        rules: [
          {
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            text: "Uncapped liability",
          },
        ],
      },
    },
  },
  ask: {
    mode: "auto",
    derived: {
      question: "What is the liability cap?",
      content: { version: 1, type: "text" },
      rulesHash: "hash",
    },
  },
  enabled: true,
  ...overrides,
});

describe("save_playbook position merge", () => {
  test("an entry without source_id is added under a minted id", () => {
    const stored = [storedGraded()];
    const result = merge({
      stored,
      positions: [gradedInput({ issue: "Governing law" })],
    });

    expect(result.issues).toEqual([]);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toBe(stored[0]);
    const [written] = result.written;
    expect(written?.change).toBe("added");
    expect(result.items[1]?.sourceId).toBe(written?.sourceId);
    expect(written?.sourceId).not.toBe(stored[0]?.sourceId);
    expect(Value.Check(positionSchema, result.items[1])).toBe(true);
  });

  test("a replaced position keeps the ids of unchanged lines, its derived ask, and its check", () => {
    const stored = storedGraded({
      check: { kind: "presence", expectation: "required" },
    });
    const result = merge({
      stored: [stored],
      positions: [
        gradedInput({
          source_id: stored.sourceId,
          tiers: {
            acceptable: ["Cap at 12 months of fees"],
            fallback: [],
            not_acceptable: ["Liability above 24 months of fees"],
          },
        }),
      ],
    });

    const [replaced] = result.items;
    if (replaced?.mode !== "graded" || replaced.standard.source !== "tiers") {
      throw new TypeError("expected a graded tiers position");
    }
    expect(result.written).toEqual([
      { sourceId: stored.sourceId, issue: "Liability cap", change: "changed" },
    ]);
    expect(replaced.standard.tiers.acceptable.rules[0]?.id).toBe(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    expect(replaced.standard.tiers.notAcceptable.rules[0]?.id).not.toBe(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    );
    expect(replaced.ask).toEqual({
      mode: "auto",
      derived: {
        question: "What is the liability cap?",
        content: { version: 1, type: "text" },
        rulesHash: "hash",
      },
    });
    expect(replaced.check).toEqual({
      kind: "presence",
      expectation: "required",
    });
  });

  test("an omitted ideal keeps a stored clause link and drops a stored inline ideal", () => {
    const withIdeal = (ideal: unknown): Position => {
      const position = structuredClone(storedGraded());
      if (position.standard.source === "tiers") {
        Object.assign(position.standard.tiers.acceptable, { ideal });
      }
      return position;
    };
    const idealAfterReplace = (stored: Position) => {
      const [replaced] = merge({
        stored: [stored],
        positions: [gradedInput({ source_id: stored.sourceId })],
      }).items;
      return replaced?.mode === "graded" && replaced.standard.source === "tiers"
        ? replaced.standard.tiers.acceptable.ideal
        : undefined;
    };

    const clauseLink = { source: "clause", clauseId: CLAUSE_ID } as const;
    expect(idealAfterReplace(withIdeal(clauseLink))).toEqual(clauseLink);
    expect(
      idealAfterReplace(withIdeal({ source: "inline", text: "Old wording" })),
    ).toBeUndefined();
  });

  test("remove_source_ids deletes and reports the position", () => {
    const stored = [storedGraded()];
    const result = merge({
      stored,
      positions: [],
      removeSourceIds: [stored[0]?.sourceId ?? ""],
    });

    expect(result.items).toEqual([]);
    expect(result.removedSourceIds).toEqual([stored[0]?.sourceId ?? ""]);
  });

  test("an unknown source_id is refused, never appended", () => {
    const stored = [storedGraded()];
    const result = merge({
      stored,
      positions: [
        gradedInput({
          issue: "Governing law",
          source_id: "99999999-9999-4999-8999-999999999999",
        }),
      ],
      removeSourceIds: ["88888888-8888-4888-8888-888888888888"],
    });

    expect(result.items).toEqual(stored);
    expect(result.issues.map(({ code, path }) => ({ code, path }))).toEqual([
      { code: "unknown_source_id", path: "remove_source_ids.0" },
      { code: "unknown_source_id", path: "positions.0.source_id" },
    ]);
  });

  test("a new position whose issue matches a stored one is refused and names that position's sourceId", () => {
    const stored = [storedGraded()];
    const result = merge({
      stored,
      positions: [gradedInput({ issue: "  liability CAP " })],
    });

    expect(result.items).toEqual(stored);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.code).toBe("duplicate_issue");
    expect(result.issues[0]?.message).toContain(stored[0]?.sourceId ?? "");
  });

  test("a refused entry does not sink the entries beside it", () => {
    const stored = [storedGraded()];
    const result = merge({
      stored,
      positions: [
        gradedInput({ issue: "Liability cap" }),
        gradedInput({ issue: "Governing law" }),
      ],
    });

    expect(result.issues.map(({ path }) => path)).toEqual([
      "positions.0.issue",
    ]);
    expect(result.written.map(({ issue }) => issue)).toEqual(["Governing law"]);
    expect(result.items).toHaveLength(2);
  });

  test("a stored reference standard cannot be replaced but can be removed", () => {
    const reference = storedGraded({
      standard: { source: "reference", termKind: "parameter", passages: [] },
    });

    const replaced = merge({
      stored: [reference],
      positions: [gradedInput({ source_id: reference.sourceId })],
    });
    expect(replaced.items).toEqual([reference]);
    expect(replaced.issues[0]?.code).toBe("reference_standard");

    const removed = merge({
      stored: [reference],
      positions: [],
      removeSourceIds: [reference.sourceId],
    });
    expect(removed.items).toEqual([]);
    expect(removed.issues).toEqual([]);
  });

  test("the input has no way to express a reference standard", () => {
    const parsed = v.safeParse(playbookPositionInputSchema, {
      ...gradedInput(),
      standard: { source: "reference", term_kind: "parameter", passages: [] },
    });

    expect(parsed.success).toBe(false);
    expect(parsed.issues?.map((issue) => v.getDotPath(issue))).toEqual([
      "standard",
    ]);
  });

  test("a stored position keeps its mode", () => {
    const stored = [storedGraded()];
    const result = merge({
      stored,
      positions: [
        {
          mode: "extract",
          source_id: stored[0]?.sourceId,
          issue: "Liability cap",
          ask: { question: "What is the cap?" },
        },
      ],
    });

    expect(result.items).toEqual(stored);
    expect(result.issues[0]?.code).toBe("mode_change");
  });
});

/**
 * The conversion returns `Position`, so a renamed or newly required stored
 * field already breaks compilation. A new OPTIONAL field compiles and would
 * simply never be writable: this census makes it fail here until the input
 * either takes it or lists it as server-owned.
 */
describe("save_playbook position input mirrors positionSchema", () => {
  const SERVER_OWNED_KEYS = {
    extract: [],
    // Neither is in the input: the ask is derived from the tier rules, and a
    // deterministic check is an editor-only override. Both are carried over.
    graded: ["ask", "check"],
  } as const satisfies Record<Position["mode"], readonly string[]>;

  const camelCaseKey = (key: string): string =>
    key.replaceAll(/_([a-z])/gu, (_match, letter: string) =>
      letter.toUpperCase(),
    );

  // The input lifts the ladder out of the stored `standard` wrapper, whose
  // other branch (`reference`) the tool cannot write.
  const storedKeyOf = (inputKey: string): string =>
    inputKey === "tiers" ? "standard" : camelCaseKey(inputKey);

  const storedBranch = (mode: Position["mode"]) => {
    const branch = positionSchema.anyOf.find(
      (candidate) => candidate.properties.mode.const === mode,
    );
    if (branch === undefined) {
      throw new TypeError(`positionSchema has no ${mode} branch`);
    }
    return branch;
  };

  const inputBranch = (mode: Position["mode"]) => {
    const branch = playbookPositionInputSchema.options.find(
      (candidate) => candidate.entries.mode.pipe[0].literal === mode,
    );
    if (branch === undefined) {
      throw new TypeError(`The input schema has no ${mode} branch`);
    }
    return branch;
  };

  test.each(["extract", "graded"] as const)(
    "every %s field is writable or declared server-owned",
    (mode) => {
      const inputKeys = Object.keys(inputBranch(mode).entries).map(storedKeyOf);
      expect([...inputKeys, ...SERVER_OWNED_KEYS[mode]].toSorted()).toEqual(
        Object.keys(storedBranch(mode).properties).toSorted(),
      );
    },
  );

  test("the negotiation fields match", () => {
    const stored = storedBranch("graded").properties;
    const input = inputBranch("graded").entries;
    if (!("negotiation" in stored) || !("negotiation" in input)) {
      throw new TypeError("expected negotiation on both graded branches");
    }
    expect(
      Object.keys(input.negotiation.wrapped.entries)
        .map(camelCaseKey)
        .toSorted(),
    ).toEqual(Object.keys(stored.negotiation.properties).toSorted());
  });
});

describe("save_playbook position merge, over the input class", () => {
  test("positions a call does not name come back as the same objects", () => {
    fc.assert(
      fc.property(
        storedArbitrary,
        fc.nat(),
        fc.boolean(),
        (stored, pick, remove) => {
          const target = stored[pick % stored.length];
          if (target === undefined) {
            return;
          }
          const result = merge({
            stored,
            positions: [gradedInput({ issue: "A position no fixture holds" })],
            removeSourceIds: remove ? [target.sourceId] : [],
          });

          const untouched = stored.filter(
            (position) => !remove || position !== target,
          );
          expect(result.items.slice(0, untouched.length)).toEqual(untouched);
          for (const [index, position] of untouched.entries()) {
            expect(result.items[index]).toBe(position);
          }
        },
      ),
      propertyConfig({ numRuns: 200 }),
    );
  });

  test("the merged playbook never holds two positions with one issue or one sourceId", () => {
    fc.assert(
      fc.property(
        storedArbitrary,
        fc.array(fc.tuple(fc.nat(), fc.boolean(), fc.boolean()), {
          maxLength: 6,
        }),
        (stored, picks) => {
          const positions = picks.map(([pick, replace, reuseIssue]) => {
            const target = stored[pick % stored.length];
            return gradedInput({
              issue: reuseIssue ? (target?.issue ?? "x") : `new ${pick}`,
              ...(replace && target !== undefined
                ? { source_id: target.sourceId }
                : {}),
            });
          });
          const { items } = merge({ stored, positions });

          const issueKeys = items.map(({ issue }) =>
            issue.trim().toLowerCase(),
          );
          expect(new Set(issueKeys).size).toBe(items.length);
          expect(new Set(items.map(({ sourceId }) => sourceId)).size).toBe(
            items.length,
          );
        },
      ),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("reading a position through the chat projection and saving it unchanged is a fixed point", () => {
    fc.assert(
      fc.property(storedArbitrary, fc.nat(), (stored, pick) => {
        const index = pick % stored.length;
        const projected = readThroughChatProjection(stored)[index];
        const result = merge({
          stored,
          positions: [readBackToInput(projected)],
        });

        expect(result.issues).toEqual([]);
        expect(result.items).toEqual(stored);
      }),
      propertyConfig({ numRuns: 300 }),
    );
  });
});
