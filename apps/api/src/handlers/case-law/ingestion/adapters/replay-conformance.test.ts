/**
 * Replay-safety conformance for every registered crawling adapter.
 *
 * The fixture and adapter maps are both total over the registry. Adding an
 * adapter therefore enrolls it here without another hand-maintained list.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { TEXT_FIELD_TYPE } from "@stll/api-contract/case-law-text-field";
import { rejectionOf } from "@stll/property-testing/rejection";
import { sha256Hex } from "@stll/sha256/bun";

import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { listAdapters } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import parserFingerprints from "@/api/handlers/case-law/ingestion/adapters/replay-parser-fingerprints.json";
import { PARSER_VERSIONS } from "@/api/lib/legal-search/ingestion-constants";
import { commitReplaySafeIngestionBatch } from "@/api/lib/replay-safe-ingestion";
import type { IngestionTransactionRunner } from "@/api/lib/replay-safe-ingestion";
import { CASE_LAW_CONFORMANCE_FIXTURES } from "@/api/tests/helpers/case-law-enrolled-fixtures";

const originalFetch = globalThis.fetch;

const compareCodeUnits = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

type DurableRow = {
  readonly id: string;
  readonly output: string;
};

type State = {
  checkpoint: string | null;
  rows: Map<string, DurableRow>;
};

type Transaction = { state: State };

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .toSorted(([left], [right]) => compareCodeUnits(left, right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
};

const parsedOutput = ({
  sourceRaw: _sourceRaw,
  sourceRawBytes: _sourceRawBytes,
  sourceRawObjects: _sourceRawObjects,
  ...output
}: IngestionResult): string => JSON.stringify(stableValue(output));

const fingerprint = (decision: IngestionResult): string =>
  sha256Hex(parsedOutput(decision));

const identityOf = (decision: IngestionResult): string =>
  decision.sourceDocumentId ??
  `${decision.sourceUrl ?? "(no source URL)"}\u0000${decision.caseNumber}`;

const transactionRunner =
  (state: State): IngestionTransactionRunner<Transaction> =>
  async (work) => {
    const pending: State = {
      checkpoint: state.checkpoint,
      rows: new Map(state.rows),
    };
    const result = await work({ state: pending });
    state.checkpoint = pending.checkpoint;
    state.rows = pending.rows;
    return result;
  };

const persistItems = (
  transaction: Transaction,
  decisions: readonly IngestionResult[],
): void => {
  for (const decision of decisions) {
    const id = identityOf(decision);
    transaction.state.rows.set(id, { id, output: parsedOutput(decision) });
  }
};

const persistCheckpoint = (
  transaction: Transaction,
  checkpoint: string,
): void => {
  transaction.state.checkpoint = checkpoint;
};

const snapshotOf = (state: State) => ({
  checkpoint: state.checkpoint,
  rows: [...state.rows.values()].toSorted((left, right) =>
    compareCodeUnits(left.id, right.id),
  ),
});

const commit = async (
  state: State,
  checkpoint: string,
  items: readonly IngestionResult[],
  failCheckpoint = false,
) =>
  await commitReplaySafeIngestionBatch({
    checkpoint,
    items,
    persistCheckpoint: async (transaction, nextCheckpoint) => {
      if (failCheckpoint) {
        throw new Error("injected failure before checkpoint persistence");
      }
      persistCheckpoint(transaction, nextCheckpoint);
    },
    persistItems,
    runInTransaction: transactionRunner(state),
  });

const emptyState = (): State => ({ checkpoint: null, rows: new Map() });

describe("every case-law adapter is replay safe", () => {
  for (const adapter of listAdapters()) {
    test(`${adapter.key}: fixture output and transactional replay conform`, async () => {
      const fixture = CASE_LAW_CONFORMANCE_FIXTURES[adapter.key];
      const first = await fixture().buildDecision();
      const replay = await fixture().buildDecision();

      expect(identityOf(replay), "replay changed the durable identity").toBe(
        identityOf(first),
      );
      expect(parsedOutput(replay), "replay changed the parsed row").toBe(
        parsedOutput(first),
      );

      const replayed = emptyState();
      await commit(replayed, "fixture:1", [first]);
      const fixedPoint = snapshotOf(replayed);
      await commit(replayed, "fixture:1", [replay]);
      expect(snapshotOf(replayed)).toEqual(fixedPoint);

      const uninterrupted = emptyState();
      await commit(uninterrupted, "fixture:1", [first]);
      const interrupted = emptyState();
      expect(
        await rejectionOf(commit(interrupted, "fixture:1", [first], true)),
      ).toMatchObject({
        message: "injected failure before checkpoint persistence",
      });
      expect(snapshotOf(interrupted)).toEqual({ checkpoint: null, rows: [] });
      await commit(interrupted, "fixture:1", [replay]);
      expect(snapshotOf(interrupted)).toEqual(snapshotOf(uninterrupted));

      const second = {
        ...first,
        sourceDocumentId: `${identityOf(first)}:next-batch`,
      };
      expect(
        await rejectionOf(commit(interrupted, "fixture:2", [second], true)),
      ).toMatchObject({
        message: "injected failure before checkpoint persistence",
      });
      expect(snapshotOf(interrupted)).toEqual(snapshotOf(uninterrupted));

      const parserSnapshot = parserFingerprints[adapter.key];
      expect(parserSnapshot.version).toBe(PARSER_VERSIONS[adapter.key]);
      expect(fingerprint(first)).toBe(parserSnapshot.fingerprint);

      for (const [field, value] of Object.entries(first.textFields)) {
        switch (value.type) {
          case TEXT_FIELD_TYPE.ABSENT:
            expect(
              value.reason.length,
              `${field} has an empty absence reason`,
            ).toBeGreaterThan(0);
            break;
          case TEXT_FIELD_TYPE.PRESENT:
            expect(
              value.text.trim().length,
              `${field} uses an empty string for absence`,
            ).toBeGreaterThan(0);
            break;
          default:
            value satisfies never;
        }
      }
    });
  }
});
