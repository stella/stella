import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type {
  PlaybookPositions,
  Position,
} from "@/api/handlers/playbooks/positions";
import { assertPositionsValid } from "@/api/handlers/playbooks/positions-validation";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const ORGANIZATION_ID = toSafeId<"organization">("org_1");

const textContent = { version: 1, type: "text" } as const;

// A tx whose clause existence query resolves to `rows` (select→from→where).
const clauseTx = (rows: { id: string }[]): Transaction =>
  asTestRaw<Transaction>({
    select: () => clauseTx(rows),
    from: () => clauseTx(rows),
    where: async () => rows,
  });

// A tx that fails if any DB call is made; the pure invariants must short-circuit
// before touching the database.
const noDbTx: Transaction = asTestRaw<Transaction>({
  select: () => {
    throw new Error("unexpected DB access");
  },
});

type GradedPosition = Extract<Position, { mode: "graded" }>;

const gradedPosition = (
  overrides: Partial<GradedPosition> = {},
): GradedPosition => ({
  mode: "graded",
  sourceId: "11111111-1111-4111-8111-111111111111",
  issue: "Governing law",
  severity: "medium",
  ask: { mode: "manual", question: "Q", content: textContent },
  tiers: {
    acceptable: {
      rules: [{ id: "aaaaaaaa-0000-4000-8000-000000000001", text: "Rule" }],
    },
    fallback: { entries: [] },
    notAcceptable: { rules: [] },
  },
  enabled: true,
  ...overrides,
});

const container = (items: Position[]): PlaybookPositions => ({
  version: 2,
  items,
});

const validate = async (tx: Transaction, positions: PlaybookPositions) =>
  await assertPositionsValid({
    safeDb: createScopedDbMock(tx).safeDb,
    organizationId: ORGANIZATION_ID,
    positions,
  });

describe("assertPositionsValid", () => {
  test("rejects duplicate sourceIds", async () => {
    const result = await validate(
      noDbTx,
      container([gradedPosition(), gradedPosition()]),
    );
    expect(Result.isError(result)).toBe(true);
  });

  test("rejects a graded position with empty tiers, no ideal, and no check", async () => {
    const result = await validate(
      noDbTx,
      container([
        gradedPosition({
          tiers: {
            acceptable: { rules: [] },
            fallback: { entries: [] },
            notAcceptable: { rules: [] },
          },
        }),
      ]),
    );
    expect(Result.isError(result)).toBe(true);
  });

  test("accepts a check-only graded position with empty tiers", async () => {
    const result = await validate(
      noDbTx,
      container([
        gradedPosition({
          tiers: {
            acceptable: { rules: [] },
            fallback: { entries: [] },
            notAcceptable: { rules: [] },
          },
          check: { kind: "presence", expectation: "required" },
        }),
      ]),
    );
    expect(Result.isOk(result)).toBe(true);
  });

  test("accepts a graded position whose only signal is ideal language", async () => {
    const result = await validate(
      noDbTx,
      container([
        gradedPosition({
          tiers: {
            acceptable: { rules: [], ideal: { source: "inline", text: "X" } },
            fallback: { entries: [] },
            notAcceptable: { rules: [] },
          },
        }),
      ]),
    );
    expect(Result.isOk(result)).toBe(true);
  });

  test("rejects duplicate rule/entry ids within a position", async () => {
    const duplicateId = "aaaaaaaa-0000-4000-8000-000000000009";
    const result = await validate(
      noDbTx,
      container([
        gradedPosition({
          tiers: {
            acceptable: { rules: [{ id: duplicateId, text: "A" }] },
            fallback: { entries: [{ id: duplicateId, text: "B" }] },
            notAcceptable: { rules: [] },
          },
        }),
      ]),
    );
    expect(Result.isError(result)).toBe(true);
  });

  test("rejects a clause ideal that does not resolve in the organization", async () => {
    const result = await validate(
      clauseTx([]),
      container([
        gradedPosition({
          tiers: {
            acceptable: {
              rules: [],
              ideal: {
                source: "clause",
                clauseId: "cccccccc-0000-4000-8000-000000000001",
              },
            },
            fallback: { entries: [] },
            notAcceptable: { rules: [] },
          },
        }),
      ]),
    );
    expect(Result.isError(result)).toBe(true);
  });

  test("accepts a clause ideal that resolves in the organization", async () => {
    const clauseId = "cccccccc-0000-4000-8000-000000000001";
    const result = await validate(
      clauseTx([{ id: clauseId }]),
      container([
        gradedPosition({
          tiers: {
            acceptable: {
              rules: [],
              ideal: { source: "clause", clauseId },
            },
            fallback: { entries: [] },
            notAcceptable: { rules: [] },
          },
        }),
      ]),
    );
    expect(Result.isOk(result)).toBe(true);
  });
});
