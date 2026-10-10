/**
 * A source's record id is not the decision's identity: a publisher can reissue
 * a decision's document under a new id and withdraw the old one. Where the
 * source's manifest says its stated ECLI names one decision, the stored row is
 * re-keyed to the new id rather than joined by a second row.
 *
 * Every case runs the shared pipeline against real Postgres. The re-key
 * scenario is generated for every registered source whose manifest declares
 * ECLI identity, so a source switched to it is covered without a new test.
 */
import { describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisionSourceIdentities,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { EMPTY_AST } from "@/api/handlers/case-law/ingestion/adapter";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import {
  listSourceRegistrations,
  type SourceRegistration,
} from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import {
  observeDecision,
  resolveDecisionIdentityTx,
} from "@/api/handlers/case-law/ingestion/pipeline/decision-identity";
import {
  sourceContractForAdapter,
  type SourceContract,
} from "@/api/handlers/case-law/ingestion/pipeline/source-contract";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { legacyTrustedUsaCourts } from "@/api/lib/case-law/decision-court-identity";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
} from "@/api/lib/case-law/decision-text";
import { STATED_ECLI_IDENTITY } from "@/api/lib/legal-search/adapter-manifest";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const DECISION_DATE = "2024-03-15";
const CASE_NUMBER = "5Cdo/12/2024";

type ObservationOptions = {
  registration: SourceRegistration;
  sourceDocumentId: string;
  ecli: string;
  caseNumber?: string;
  decisionDate?: string;
  language?: string;
};

/**
 * One observation of a decision as the registered source would state it:
 * its country and language, a court its jurisdiction admits, and only the
 * identity fields under test varying.
 */
const observation = ({
  registration: { key, source },
  sourceDocumentId,
  ecli,
  caseNumber = CASE_NUMBER,
  decisionDate = DECISION_DATE,
  language = source.language,
}: ObservationOptions): IngestionResult => {
  // Only a directory jurisdiction names its court by id; the rest by name.
  const directoryCourt =
    source.country === "USA" ? legacyTrustedUsaCourts().at(0) : undefined;
  return plainTextIngestionResult({
    caseNumber,
    sourceDocumentId,
    ecli,
    court: directoryCourt?.name ?? `${key} court`,
    ...(directoryCourt === undefined
      ? {}
      : { courtId: directoryCourt.courtId }),
    country: source.country,
    language,
    decisionDate,
    decisionType: "judgment",
    fulltext: `Decision ${ecli}`,
    metadata: { ecli },
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    rawHash: `hash-${ecli}`,
    documentAst: EMPTY_AST,
  });
};

const registrationWith = (
  identity: SourceContract["statedEcliIdentity"],
): SourceRegistration[] =>
  listSourceRegistrations().filter(
    ({ key }) => sourceContractForAdapter(key).statedEcliIdentity === identity,
  );

if (!databaseUrl || !runPostgresTests) {
  describe.skip("decision re-keyed by its publisher", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("decision re-keyed by its publisher", () => {
    const { db, cleanUp } = openGatedTestDatabase(databaseUrl);
    const scopedDb: ScopedDb = async (callback) =>
      await db.transaction(async (tx) => await callback(tx));
    const createdSourceIds: SafeId<"caseLawSource">[] = [];

    cleanUp(async () => {
      for (const sourceId of createdSourceIds) {
        await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
      }
    });

    /** A source row of its own; the contract under test is passed explicitly. */
    const createSource = async (
      label: string,
    ): Promise<SafeId<"caseLawSource">> => {
      const [source] = await db
        .insert(caseLawSources)
        .values({
          adapterKey: `rekey-${label}-${Bun.randomUUIDv7()}`,
          name: `Re-key ${label}`,
          enabled: false,
        })
        .returning({ id: caseLawSources.id });
      if (!source) {
        throw new Error("expected source row");
      }
      createdSourceIds.push(source.id);
      return source.id;
    };

    let observedSecond = 0;
    const store = async (
      sourceId: SafeId<"caseLawSource">,
      input: IngestionResult,
      contract: SourceContract,
    ): Promise<void> => {
      observedSecond += 1;
      await processDecision(
        {
          input,
          observationOrder: BigInt(observedSecond),
          sourceId,
          scopedDb,
          observedAt: new Date(
            Date.UTC(2026, 9, 5, 12, 0, 0) + observedSecond * 1000,
          ),
        },
        async () => await Promise.resolve(contract),
      );
    };

    const storedRows = async (sourceId: SafeId<"caseLawSource">) =>
      await db
        .select({
          id: caseLawDecisions.id,
          sourceDocumentId: caseLawDecisions.sourceDocumentId,
          sourceHash: caseLawDecisions.sourceHash,
          updatedAt: caseLawDecisions.updatedAt,
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.sourceId, sourceId))
        .orderBy(asc(caseLawDecisions.sourceDocumentId));

    /** The source's one stored row: a second one is the twin under test. */
    const onlyRow = async (sourceId: SafeId<"caseLawSource">) => {
      const rows = await storedRows(sourceId);
      expect(rows).toHaveLength(1);
      const [row] = rows;
      if (row === undefined) {
        throw new Error("expected one stored decision");
      }
      return row;
    };

    const reservations = async (sourceId: SafeId<"caseLawSource">) =>
      await db
        .select({
          sourceDocumentId: caseLawDecisionSourceIdentities.sourceDocumentId,
          decisionId: caseLawDecisionSourceIdentities.decisionId,
        })
        .from(caseLawDecisionSourceIdentities)
        .where(eq(caseLawDecisionSourceIdentities.sourceId, sourceId))
        .orderBy(asc(caseLawDecisionSourceIdentities.sourceDocumentId));

    const decisionSources = registrationWith(STATED_ECLI_IDENTITY.DECISION);
    const noneSource = registrationWith(STATED_ECLI_IDENTITY.NONE).at(0);

    test("at least one registered source declares each ECLI identity", () => {
      // Without both, the generated cases below would cover nothing.
      expect(decisionSources.length).toBeGreaterThan(0);
      expect(noneSource).toBeDefined();
    });

    for (const registration of decisionSources) {
      const contract = sourceContractForAdapter(registration.key);
      const ecli = `ECLI:XX:${registration.key.toUpperCase()}:2024:1`;

      test(`${registration.key}: a reissued decision re-keys its row and keeps the old id`, async () => {
        const sourceId = await createSource(registration.key);
        const first = observation({
          registration,
          sourceDocumentId: "doc-a",
          ecli,
        });
        const reissued = observation({
          registration,
          sourceDocumentId: "doc-b",
          ecli,
        });

        await store(sourceId, first, contract);
        const stored = await onlyRow(sourceId);
        expect(stored.sourceDocumentId).toBe("doc-a");

        await store(sourceId, reissued, contract);
        const rekeyed = await onlyRow(sourceId);
        expect(rekeyed.id).toBe(stored.id);
        expect(rekeyed.sourceDocumentId).toBe("doc-b");
        // Both ids stay reserved for the one decision: the record of the
        // re-key, and how the withdrawn id still resolves.
        const reserved = await reservations(sourceId);
        expect(reserved).toEqual([
          { sourceDocumentId: "doc-a", decisionId: stored.id },
          { sourceDocumentId: "doc-b", decisionId: stored.id },
        ]);

        // Fixed point: the same observation again changes neither the row's
        // identity and payload nor the reservations.
        await store(sourceId, reissued, contract);
        const replayed = await onlyRow(sourceId);
        expect({
          id: replayed.id,
          sourceDocumentId: replayed.sourceDocumentId,
          sourceHash: replayed.sourceHash,
        }).toEqual({
          id: rekeyed.id,
          sourceDocumentId: rekeyed.sourceDocumentId,
          sourceHash: rekeyed.sourceHash,
        });
        expect(await reservations(sourceId)).toEqual(reserved);

        // A stale listing still naming the withdrawn id neither flips the row
        // back nor inserts it again.
        await store(sourceId, first, contract);
        const afterStale = await onlyRow(sourceId);
        expect(afterStale.id).toBe(stored.id);
        expect(afterStale.sourceDocumentId).toBe("doc-b");
        expect(await reservations(sourceId)).toEqual(reserved);
      }, 60_000);

      test(`${registration.key}: two keyed rows with the ECLI are a conflict, not an adoption`, async () => {
        const sourceId = await createSource(`${registration.key}-ambiguous`);
        // Twins stored before this source declared ECLI identity.
        const twinContract = {
          ...contract,
          statedEcliIdentity: STATED_ECLI_IDENTITY.NONE,
        } satisfies SourceContract;
        await store(
          sourceId,
          observation({ registration, sourceDocumentId: "doc-a", ecli }),
          twinContract,
        );
        await store(
          sourceId,
          observation({ registration, sourceDocumentId: "doc-b", ecli }),
          twinContract,
        );
        const twins = await storedRows(sourceId);
        expect(twins).toHaveLength(2);

        const third = observeDecision({
          input: observation({ registration, sourceDocumentId: "doc-c", ecli }),
          sourceId,
          metadataUrlSchema: contract.metadataUrlSchema,
        });
        const identity = await scopedDb(
          async (tx) =>
            await resolveDecisionIdentityTx(tx, {
              ...third,
              sourceId,
              statedEcliIdentity: contract.statedEcliIdentity,
              proposedDecisionId: createSafeId<"caseLawDecision">(),
            }),
        );
        expect(identity.existing).toBeUndefined();
        expect(identity.ecliIdentity).toEqual({
          type: "ambiguous",
          sourceDocumentId: "doc-c",
        });

        await store(
          sourceId,
          observation({ registration, sourceDocumentId: "doc-c", ecli }),
          contract,
        );
        const after = await storedRows(sourceId);
        expect(after).toHaveLength(3);
        // Neither twin is written to.
        expect(
          after.filter(({ sourceDocumentId }) => sourceDocumentId !== "doc-c"),
        ).toEqual(twins);
      }, 60_000);

      test(`${registration.key}: an ECLI under another docket, date or language is a decision of its own`, async () => {
        const sourceId = await createSource(`${registration.key}-distinct`);
        await store(
          sourceId,
          observation({ registration, sourceDocumentId: "doc-a", ecli }),
          contract,
        );
        const variants = [
          { sourceDocumentId: "doc-docket", caseNumber: "7Cdo/99/2024" },
          { sourceDocumentId: "doc-date", decisionDate: "2024-03-16" },
          { sourceDocumentId: "doc-language", language: "xx" },
        ] as const;
        for (const variant of variants) {
          // db-await-in-loop: each observation must see the rows before it
          await store(
            sourceId,
            observation({ registration, ecli, ...variant }),
            contract,
          );
        }
        expect(
          (await storedRows(sourceId)).map(
            ({ sourceDocumentId }) => sourceDocumentId,
          ),
        ).toEqual(
          [
            "doc-a",
            ...variants.map(({ sourceDocumentId }) => sourceDocumentId),
          ].toSorted(),
        );
      }, 60_000);

      test(`${registration.key}: concurrent observations of a reissue converge on one row`, async () => {
        const sourceId = await createSource(`${registration.key}-concurrent`);
        await store(
          sourceId,
          observation({ registration, sourceDocumentId: "doc-a", ecli }),
          contract,
        );
        const stored = await onlyRow(sourceId);

        // The same new id twice, and a second new id beside it: every
        // worker reaches the one stored decision.
        await Promise.all([
          store(
            sourceId,
            observation({ registration, sourceDocumentId: "doc-b", ecli }),
            contract,
          ),
          store(
            sourceId,
            observation({ registration, sourceDocumentId: "doc-b", ecli }),
            contract,
          ),
          store(
            sourceId,
            observation({ registration, sourceDocumentId: "doc-c", ecli }),
            contract,
          ),
        ]);
        const after = await onlyRow(sourceId);
        expect(after.id).toBe(stored.id);
        expect(["doc-b", "doc-c"]).toContain(after.sourceDocumentId ?? "");
        expect(await reservations(sourceId)).toEqual([
          { sourceDocumentId: "doc-a", decisionId: stored.id },
          { sourceDocumentId: "doc-b", decisionId: stored.id },
          { sourceDocumentId: "doc-c", decisionId: stored.id },
        ]);
      }, 60_000);
    }

    test("a source without ECLI identity stores a reissue as a decision of its own", async () => {
      if (noneSource === undefined) {
        throw new Error("expected a source without ECLI identity");
      }
      const sourceId = await createSource("none");
      const ecli = "ECLI:XX:NONE:2024:1";
      // The default resolver reads the persisted source, whose key no
      // manifest declares: the path a seeded source takes.
      await processDecision({
        input: observation({
          registration: noneSource,
          sourceDocumentId: "doc-a",
          ecli,
        }),
        observationOrder: 1n,
        sourceId,
        scopedDb,
        observedAt: new Date(Date.UTC(2026, 9, 5, 12, 0, 0)),
      });
      await store(
        sourceId,
        observation({
          registration: noneSource,
          sourceDocumentId: "doc-b",
          ecli,
        }),
        sourceContractForAdapter(noneSource.key),
      );
      expect(
        (await storedRows(sourceId)).map(
          ({ sourceDocumentId }) => sourceDocumentId,
        ),
      ).toEqual(["doc-a", "doc-b"]);
    }, 60_000);
  });
}
