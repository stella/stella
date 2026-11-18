/**
 * A source that declares `HeldDecisionAttachment` enriches a decision another
 * source already holds instead of writing a second row of it. Every case runs
 * the shared pipeline against real Postgres: the host source writes its
 * decision as usual, and the declaring source's record either attaches to it,
 * becomes a decision of its own, or is parked.
 */
import { describe, expect, test } from "bun:test";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import * as v from "valibot";

import { directoryCourtIdentities } from "@stll/api-contract/court-identity";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import type { DecisionIdentifiers } from "@stll/legal-ast/decision-identifier";
import { createSha256 } from "@stll/sha256/node";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawHeldDecisionAttachments,
  caseLawSources,
} from "@/api/db/schema";
import { decisionIdsNamedBy } from "@/api/handlers/case-law/decisions/lookup-by-identity";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import {
  type SourceContract,
  sourceContractForAdapter,
} from "@/api/handlers/case-law/ingestion/pipeline/source-contract";
import type { SafeId } from "@/api/lib/branded-types";
import {
  absentDecisionTextFields,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import { selectAttachmentDocumentIds } from "@/api/lib/case-law/held-attachment-reads";
import { readHeldDecisionAttachmentCensus } from "@/api/lib/case-law/held-decision-attachment-census";
import { readStoredListingIdentities } from "@/api/lib/case-law/stored-listing-identities";
import type { HeldDecisionAttachment } from "@/api/lib/legal-search/held-decision-attachment";
import {
  HELD_DECISION_MATCH_BASIS,
  HELD_DECISION_REVIEW,
} from "@/api/lib/legal-search/held-decision-attachment-values";
import { EMPTY_AST } from "@/api/lib/legal-search/ingestion-types";
import type { IngestionResult } from "@/api/lib/legal-search/ingestion-types";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const COURT =
  directoryCourtIdentities("CZE").find(({ name }) => name === "Nejvyšší soud")
    ?.name ??
  directoryCourtIdentities("CZE").at(0)?.name ??
  "Nejvyšší soud";
const DECISION_DATE = "1999-05-20";
const DOCKET = "2 Cdon 1548/97";
/** As the court's decision database spells it: a two-digit docket year. */
const HELD_ECLI = "ECLI:CZ:NS:1999:2.CDON.1548.97.1";
/** As the official collection spells the same decision: four digits. */
const COLLECTION_ECLI = "ECLI:CZ:NS:1999:2.CDON.1548.1997.1";
const REPORTER = "R 9/1971";

const COLLECTION_METADATA_KEY = "collectionEntry";

/** What a takedown leaves of a decision row, as the erasure fence writes it. */
const REDACTED = {
  redactedAt: new Date("2026-11-18T10:00:00.000Z"),
  corpusMirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED,
  fulltext: null,
  sections: null,
  documentAst: null,
  contentHash: null,
  sourceRaw: null,
};

const declarationFor = (
  hostKey: string,
  docketHeldUnderOtherDate: HeldDecisionAttachment["docketHeldUnderOtherDate"] = "park-for-review",
): HeldDecisionAttachment<string> => ({
  docketHeldUnderOtherDate,
  hostAdapterKeys: [hostKey],
  metadataKey: COLLECTION_METADATA_KEY,
  metadataSchema: v.object({
    number: v.number(),
    year: v.number(),
    legalSentence: v.string(),
  }),
  declaredIdentifierTypes: [DECISION_IDENTIFIER_TYPES.REPORTER_CITATION],
});

type ObservationOptions = {
  sourceDocumentId: string;
  ecli?: string | undefined;
  caseNumber?: string;
  decisionDate?: string;
  text?: string;
  metadata?: Record<string, unknown>;
  identifiers?: DecisionIdentifiers;
};

const observation = ({
  sourceDocumentId,
  ecli,
  caseNumber = DOCKET,
  decisionDate = DECISION_DATE,
  text = `Decision ${sourceDocumentId}`,
  metadata = {},
  identifiers,
}: ObservationOptions): IngestionResult =>
  plainTextIngestionResult({
    caseNumber,
    sourceDocumentId,
    ...(ecli === undefined ? {} : { ecli }),
    court: COURT,
    country: "CZE",
    language: "cs",
    decisionDate,
    decisionType: "judgment",
    fulltext: text,
    metadata,
    ...(identifiers === undefined ? {} : { identifiers }),
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    rawHash: createSha256()
      .update(
        `${sourceDocumentId}\u0000${text}\u0000${JSON.stringify(metadata)}`,
      )
      .digest("hex"),
    documentAst: EMPTY_AST,
  });

const collectionEntry = ({
  sourceDocumentId = "9586",
  ecli = COLLECTION_ECLI,
  caseNumber = DOCKET,
  legalSentence = "Právní věta.",
  reporter = REPORTER,
}: {
  sourceDocumentId?: string;
  /** Null for a record that states no ECLI. */
  ecli?: string | null;
  caseNumber?: string;
  legalSentence?: string;
  reporter?: string;
} = {}): IngestionResult =>
  observation({
    sourceDocumentId,
    ecli: ecli ?? undefined,
    caseNumber,
    text: `Sbírkový text ${legalSentence}`,
    metadata: {
      [COLLECTION_METADATA_KEY]: { number: 9, year: 1971, legalSentence },
    },
    identifiers: [
      { type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER, value: caseNumber },
      { type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION, value: reporter },
    ],
  });

if (!databaseUrl || !runPostgresTests) {
  describe.skip("a record enriches a decision another source holds", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("a record enriches a decision another source holds", () => {
    const { db, cleanUp } = openGatedTestDatabase(databaseUrl);
    const scopedDb: ScopedDb = async (callback) =>
      await db.transaction(async (tx) => await callback(tx));
    const createdSourceIds: SafeId<"caseLawSource">[] = [];

    cleanUp(async () => {
      for (const sourceId of createdSourceIds) {
        await db
          .delete(caseLawDecisions)
          .where(eq(caseLawDecisions.sourceId, sourceId));
        await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
      }
    });

    const createSource = async (label: string) => {
      const adapterKey = `held-${label}-${Bun.randomUUIDv7()}`;
      const [source] = await db
        .insert(caseLawSources)
        .values({ adapterKey, name: `Held ${label}`, enabled: false })
        .returning({ id: caseLawSources.id });
      if (!source) {
        throw new Error("expected source row");
      }
      createdSourceIds.push(source.id);
      return { id: source.id, adapterKey };
    };

    const baseContract = sourceContractForAdapter("cz-ns");
    const hostContract: SourceContract = {
      ...baseContract,
      heldDecisionAttachment: null,
    };

    /** A host source and a collection source declaring it as its host. */
    const sources = async () => {
      const host = await createSource("host");
      const collection = await createSource("collection");
      const declaration = declarationFor(host.adapterKey);
      return {
        host: host.id,
        collection: collection.id,
        collectionKey: collection.adapterKey,
        declaration,
        collectionContract: {
          ...baseContract,
          heldDecisionAttachment: declaration,
        } satisfies SourceContract,
      };
    };

    let order = 0;
    const store = async (
      sourceId: SafeId<"caseLawSource">,
      input: IngestionResult,
      contract: SourceContract,
      observationOrder?: number,
    ) => {
      order += 1;
      return (
        await processDecision(
          {
            input,
            observationOrder: BigInt(observationOrder ?? order),
            sourceId,
            scopedDb,
            observedAt: new Date(
              Date.UTC(2026, 10, 18, 9, 0, 0) + order * 1000,
            ),
          },
          async () => await Promise.resolve(contract),
        )
      ).unwrap();
    };

    const rowsOf = async (sourceId: SafeId<"caseLawSource">) =>
      await db
        .select()
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.sourceId, sourceId))
        .orderBy(asc(caseLawDecisions.id));

    const onlyRow = async (sourceId: SafeId<"caseLawSource">) => {
      const rows = await rowsOf(sourceId);
      expect(rows).toHaveLength(1);
      const [row] = rows;
      if (row === undefined) {
        throw new Error("expected one decision");
      }
      return row;
    };

    const attachmentsOf = async (sourceId: SafeId<"caseLawSource">) =>
      await db
        .select()
        .from(caseLawHeldDecisionAttachments)
        .where(eq(caseLawHeldDecisionAttachments.sourceId, sourceId))
        .orderBy(asc(caseLawHeldDecisionAttachments.sourceDocumentId));

    const onlyAttachment = async (sourceId: SafeId<"caseLawSource">) => {
      const rows = await attachmentsOf(sourceId);
      expect(rows).toHaveLength(1);
      const [row] = rows;
      if (row === undefined) {
        throw new Error("expected one attachment");
      }
      return row;
    };

    const identifiersOf = async (decisionId: SafeId<"caseLawDecision">) =>
      await db
        .select({
          type: caseLawDecisionIdentifiers.type,
          value: caseLawDecisionIdentifiers.value,
          declared: sql<boolean>`${caseLawDecisionIdentifiers.declaredAt} IS NOT NULL`,
        })
        .from(caseLawDecisionIdentifiers)
        .where(eq(caseLawDecisionIdentifiers.decisionId, decisionId))
        .orderBy(
          asc(caseLawDecisionIdentifiers.type),
          asc(caseLawDecisionIdentifiers.value),
        );

    const heldDecision = (sourceDocumentId = "ns-1", ecli = HELD_ECLI) =>
      observation({ sourceDocumentId, ecli });

    test("attaches by a differently spelled ECLI and leaves the host row as it was", async () => {
      const { host, collection, collectionContract } = await sources();
      await store(host, heldDecision(), hostContract);
      const before = await onlyRow(host);

      const outcome = await store(
        collection,
        collectionEntry(),
        collectionContract,
      );
      expect(outcome).toEqual({
        status: "complete",
        inserted: false,
        searchVectorFailed: false,
      });

      // No second row: the collection source holds none of its own.
      expect(await rowsOf(collection)).toEqual([]);
      const attachment = await onlyAttachment(collection);
      expect(attachment).toMatchObject({
        sourceDocumentId: "9586",
        hostWithdrawnAt: null,
        matchBasis: HELD_DECISION_MATCH_BASIS.ECLI,
        hostDecisionId: before.id,
        metadata: { number: 9, year: 1971, legalSentence: "Právní věta." },
        sourceRawS3Key: null,
      });
      expect(attachment.observationOrder).toBeGreaterThan(0n);

      // The host decision's own row is byte for byte what its source wrote.
      expect(await onlyRow(host)).toEqual(before);
      // The reporter citation is the host's declared identifier now.
      expect(await identifiersOf(before.id)).toContainEqual({
        type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
        value: REPORTER,
        declared: true,
      });
      // An identity lookup by that citation names the host.
      const named = await db.transaction(
        async (tx) =>
          await decisionIdsNamedBy({
            country: "CZE",
            familyKey: null,
            locator: { kind: "reporter", value: REPORTER },
            tx,
          }),
      );
      expect(named.map(({ id }) => id)).toContain(before.id);
    });

    test("attaches across a register spelled with and without its diacritic", async () => {
      const { host, collection, collectionContract } = await sources();
      await store(
        host,
        observation({
          sourceDocumentId: "ns-nscr",
          ecli: "ECLI:CZ:NS:2019:29.NSCR.106.2018.1",
          caseNumber: "29 NSČR 106/2018",
          decisionDate: "2019-02-27",
        }),
        hostContract,
      );
      const held = await onlyRow(host);
      await store(
        collection,
        {
          ...collectionEntry({
            sourceDocumentId: "4320",
            ecli: "ECLI:CZ:NS:2019:29.NSČR.106.2018.1",
            caseNumber: "29 NSČR 106/2018",
          }),
          // The collection states another date than the decision database.
          decisionDate: "2019-02-28",
        },
        collectionContract,
      );
      expect(await rowsOf(collection)).toEqual([]);
      expect(await onlyAttachment(collection)).toMatchObject({
        hostDecisionId: held.id,
        matchBasis: HELD_DECISION_MATCH_BASIS.ECLI,
      });
    });

    test("attaches by court, docket and date when the record states no ECLI", async () => {
      const { host, collection, collectionContract } = await sources();
      await store(host, heldDecision(), hostContract);
      const held = await onlyRow(host);
      await store(
        collection,
        collectionEntry({ ecli: null }),
        collectionContract,
      );
      expect(await rowsOf(collection)).toEqual([]);
      expect(await onlyAttachment(collection)).toMatchObject({
        hostWithdrawnAt: null,
        matchBasis: HELD_DECISION_MATCH_BASIS.COURT_DOCKET_DATE,
        hostDecisionId: held.id,
      });
    });

    test("a record no host holds is written as a decision of its own", async () => {
      const { collection, collectionContract } = await sources();
      const outcome = await store(
        collection,
        collectionEntry(),
        collectionContract,
      );
      expect(outcome.inserted).toBe(true);
      const own = await onlyRow(collection);
      expect(own.sourceDocumentId).toBe("9586");
      expect(await attachmentsOf(collection)).toEqual([]);
    });

    test("several held matches park the record and write no row", async () => {
      const { host, collection, collectionContract } = await sources();
      await store(host, heldDecision("ns-1"), hostContract);
      await store(host, heldDecision("ns-2"), hostContract);
      const held = await rowsOf(host);
      expect(held).toHaveLength(2);

      const outcome = await store(
        collection,
        collectionEntry(),
        collectionContract,
      );
      expect(outcome).toMatchObject({ status: "complete", inserted: false });
      expect(await rowsOf(collection)).toEqual([]);
      const parked = await onlyAttachment(collection);
      expect(parked).toMatchObject({
        hostWithdrawnAt: null,
        hostDecisionId: null,
        matchBasis: HELD_DECISION_MATCH_BASIS.ECLI,
      });
      expect([...parked.candidateDecisionIds].toSorted()).toEqual(
        held.map(({ id }) => id).toSorted(),
      );
      // No host gained the record's citation.
      for (const { id } of held) {
        expect(
          (await identifiersOf(id)).some(
            ({ type }) => type === DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
          ),
        ).toBe(false);
      }
    });

    test("a docket held only under another date parks the record for review, typed and listed", async () => {
      const {
        host,
        collection,
        collectionKey,
        declaration,
        collectionContract,
      } = await sources();
      // The held decision of the same court and docket, dated otherwise and
      // stating no ECLI the record's could reach.
      await store(
        host,
        observation({
          sourceDocumentId: "ns-other-date",
          decisionDate: "1999-06-30",
        }),
        hostContract,
      );
      const held = await onlyRow(host);
      const before = await onlyRow(host);

      const outcome = await store(
        collection,
        collectionEntry({ ecli: null }),
        collectionContract,
      );
      expect(outcome).toMatchObject({ status: "complete", inserted: false });
      expect(await rowsOf(collection)).toEqual([]);
      expect(await attachmentsOf(collection)).toMatchObject([
        {
          hostDecisionId: null,
          hostWithdrawnAt: null,
          matchBasis: HELD_DECISION_MATCH_BASIS.COURT_DOCKET_OTHER_DATE,
          candidateDecisionIds: [held.id],
        },
      ]);
      // Nothing of the held decision moved, and it declares no citation.
      expect(await onlyRow(host)).toEqual(before);
      expect(
        (await identifiersOf(held.id)).some(
          ({ type }) => type === DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
        ),
      ).toBe(false);

      const census = await db.transaction(
        async (tx) =>
          await readHeldDecisionAttachmentCensus(tx, [
            [collectionKey, declaration],
          ]),
      );
      expect(census.at(0)?.review).toEqual({
        [HELD_DECISION_REVIEW.SEVERAL_HELD]: { count: 0, sample: [] },
        [HELD_DECISION_REVIEW.DOCKET_HELD_OTHER_DATE]: {
          count: 1,
          sample: [
            {
              sourceDocumentId: "9586",
              matchBasis: HELD_DECISION_MATCH_BASIS.COURT_DOCKET_OTHER_DATE,
              candidateDecisionIds: [held.id],
            },
          ],
        },
      });
    });

    test("a source that writes such a record as its own does so", async () => {
      const { host, collection, declaration } = await sources();
      const [hostKey] = declaration.hostAdapterKeys;
      await store(
        host,
        observation({
          sourceDocumentId: "ns-other-date",
          decisionDate: "1999-06-30",
        }),
        hostContract,
      );
      const outcome = await store(collection, collectionEntry({ ecli: null }), {
        ...baseContract,
        heldDecisionAttachment: declarationFor(hostKey, "own-row"),
      });
      expect(outcome.inserted).toBe(true);
      expect((await onlyRow(collection)).sourceDocumentId).toBe("9586");
      expect(await attachmentsOf(collection)).toEqual([]);
    });

    test("the census types a several-held park apart from a docket under another date", async () => {
      const {
        host,
        collection,
        collectionKey,
        declaration,
        collectionContract,
      } = await sources();
      await store(host, heldDecision("ns-1"), hostContract);
      await store(host, heldDecision("ns-2"), hostContract);
      await store(collection, collectionEntry(), collectionContract);
      const census = await db.transaction(
        async (tx) =>
          await readHeldDecisionAttachmentCensus(tx, [
            [collectionKey, declaration],
          ]),
      );
      expect(
        census.at(0)?.review[HELD_DECISION_REVIEW.SEVERAL_HELD].count,
      ).toBe(1);
      expect(
        census.at(0)?.review[HELD_DECISION_REVIEW.DOCKET_HELD_OTHER_DATE].count,
      ).toBe(0);
    });

    test("replay is a fixed point and a stale observation cannot overwrite", async () => {
      const { host, collection, collectionContract } = await sources();
      await store(host, heldDecision(), hostContract);
      const held = await onlyRow(host);

      await store(collection, collectionEntry(), collectionContract, 10);
      const first = await onlyAttachment(collection);
      // The same record again, later: nothing changes.
      await store(collection, collectionEntry(), collectionContract, 11);
      expect(await onlyAttachment(collection)).toEqual(first);

      // A changed record with a later order updates the attachment and moves
      // the declared citation.
      await store(
        collection,
        collectionEntry({ legalSentence: "Nová věta.", reporter: "R 10/1971" }),
        collectionContract,
        20,
      );
      const changed = await onlyAttachment(collection);
      expect(changed.metadata).toEqual({
        number: 9,
        year: 1971,
        legalSentence: "Nová věta.",
      });
      expect(changed.observationOrder).toBe(20n);
      const reporters = (await identifiersOf(held.id)).filter(
        ({ type }) => type === DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
      );
      expect(reporters).toEqual([
        {
          type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
          value: "R 10/1971",
          declared: true,
        },
      ]);

      // An older observation finishing late leaves the newer state.
      await store(collection, collectionEntry(), collectionContract, 15);
      expect(await onlyAttachment(collection)).toEqual(changed);
      expect(
        (await identifiersOf(held.id)).filter(
          ({ type }) => type === DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
        ),
      ).toEqual(reporters);
      expect(await onlyRow(host)).toEqual(held);
    });

    test("a host refresh keeps the declared citation", async () => {
      const { host, collection, collectionContract } = await sources();
      await store(host, heldDecision(), hostContract);
      const held = await onlyRow(host);
      await store(collection, collectionEntry(), collectionContract);

      await store(
        host,
        observation({
          sourceDocumentId: "ns-1",
          ecli: HELD_ECLI,
          text: "Decision ns-1, corrected",
        }),
        hostContract,
      );
      const refreshed = await onlyRow(host);
      expect(refreshed.id).toBe(held.id);
      expect(refreshed.sourceHash).not.toBe(held.sourceHash);
      expect(await identifiersOf(held.id)).toContainEqual({
        type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
        value: REPORTER,
        declared: true,
      });
    });

    test("an attached record counts as held by its source", async () => {
      const { host, collection, collectionContract } = await sources();
      await store(host, heldDecision(), hostContract);
      const held = await onlyRow(host);
      await store(collection, collectionEntry(), collectionContract);

      // What the reconciler's listing walk reads as held.
      const heldIds = await db.transaction(
        async (tx) =>
          await selectAttachmentDocumentIds(tx, {
            sourceId: collection,
            documentIds: ["9586", "unlisted"],
          }),
      );
      expect([...heldIds]).toEqual(["9586"]);

      // What the completeness census counts as stored, with its text.
      const stored = await db.transaction(
        async (tx) =>
          await readStoredListingIdentities({
            tx,
            sourceId: collection,
            identities: [{ type: "document", sourceDocumentId: "9586" }],
          }),
      );
      expect(stored.flatMap(({ decisions }) => decisions)).toEqual([
        { id: held.id, withText: true },
      ]);
    });

    test("an erased host parks the record instead of writing it again", async () => {
      const { host, collection, collectionContract } = await sources();
      await store(host, heldDecision(), hostContract);
      const held = await onlyRow(host);
      await store(collection, collectionEntry(), collectionContract);
      await db
        .update(caseLawDecisions)
        .set(REDACTED)
        .where(eq(caseLawDecisions.id, held.id));

      await store(
        collection,
        collectionEntry({ legalSentence: "Po výmazu." }),
        collectionContract,
      );
      expect(await rowsOf(collection)).toEqual([]);
      expect(await onlyAttachment(collection)).toMatchObject({
        hostWithdrawnAt: expect.any(Date),
        hostDecisionId: held.id,
        metadata: null,
        sourceRawS3Key: null,
      });
      // Parked for good: a later observation does not re-create it.
      await store(
        collection,
        collectionEntry({ legalSentence: "Znovu." }),
        collectionContract,
      );
      expect(await rowsOf(collection)).toEqual([]);
    });

    test("a record first matched to a redacted host is parked, never written", async () => {
      const { host, collection, collectionContract } = await sources();
      await store(host, heldDecision(), hostContract);
      const held = await onlyRow(host);
      await db
        .update(caseLawDecisions)
        .set(REDACTED)
        .where(eq(caseLawDecisions.id, held.id));
      await store(collection, collectionEntry(), collectionContract);
      expect(await rowsOf(collection)).toEqual([]);
      expect(await onlyAttachment(collection)).toMatchObject({
        hostDecisionId: held.id,
        hostWithdrawnAt: expect.any(Date),
        metadata: null,
      });
    });

    test("a record with a row of its own stays one when its host arrives", async () => {
      const {
        host,
        collection,
        collectionKey,
        declaration,
        collectionContract,
      } = await sources();
      await store(collection, collectionEntry(), collectionContract);
      const own = await onlyRow(collection);
      await store(host, heldDecision("ns-1", COLLECTION_ECLI), hostContract);

      await store(
        collection,
        collectionEntry({ legalSentence: "Změna." }),
        collectionContract,
      );
      expect((await onlyRow(collection)).id).toBe(own.id);
      expect(await attachmentsOf(collection)).toEqual([]);

      // The census names the duplicate the attach step could not prevent.
      const census = await db.transaction(
        async (tx) =>
          await readHeldDecisionAttachmentCensus(tx, [
            [collectionKey, declaration],
          ]),
      );
      expect(census).toEqual([
        {
          adapterKey: collectionKey,
          hostVanished: { count: 0, sample: [] },
          ownRowsMatchingHost: {
            count: 1,
            sample: [
              {
                decisionId: own.id,
                hostDecisionId: (await onlyRow(host)).id,
              },
            ],
          },
          review: {
            [HELD_DECISION_REVIEW.SEVERAL_HELD]: { count: 0, sample: [] },
            [HELD_DECISION_REVIEW.DOCKET_HELD_OTHER_DATE]: {
              count: 0,
              sample: [],
            },
          },
        },
      ]);
    });

    test("the census names an attached record whose host vanished", async () => {
      const {
        host,
        collection,
        collectionKey,
        declaration,
        collectionContract,
      } = await sources();
      await store(host, heldDecision(), hostContract);
      const held = await onlyRow(host);
      await store(collection, collectionEntry(), collectionContract);
      // A host deleted outside the erasure path, which would have parked it.
      await db.delete(caseLawDecisions).where(eq(caseLawDecisions.id, held.id));
      const census = await db.transaction(
        async (tx) =>
          await readHeldDecisionAttachmentCensus(tx, [
            [collectionKey, declaration],
          ]),
      );
      expect(census.at(0)?.hostVanished).toEqual({
        count: 1,
        sample: [{ sourceDocumentId: "9586", hostDecisionId: held.id }],
      });
    });

    test("two workers attaching the same record converge on one attachment", async () => {
      const { host, collection, collectionContract } = await sources();
      await store(host, heldDecision(), hostContract);
      const held = await onlyRow(host);
      order += 1;
      const at = order;
      await Promise.all(
        [0, 1].map(
          async () =>
            await store(collection, collectionEntry(), collectionContract, at),
        ),
      );
      expect(await rowsOf(collection)).toEqual([]);
      expect(await onlyAttachment(collection)).toMatchObject({
        hostDecisionId: held.id,
        hostWithdrawnAt: null,
      });
      const reporters = await db
        .select({ value: caseLawDecisionIdentifiers.value })
        .from(caseLawDecisionIdentifiers)
        .where(
          and(
            eq(caseLawDecisionIdentifiers.decisionId, held.id),
            inArray(caseLawDecisionIdentifiers.type, [
              DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
            ]),
          ),
        );
      expect(reporters).toEqual([{ value: REPORTER }]);
    });
  });
}
