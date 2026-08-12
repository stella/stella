import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  entities,
  searchProjectionRepairQueue,
  workspaces,
} from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  SEARCH_INDEX_OWNER,
  searchIndexOwnerForFields,
} from "@/api/lib/search/process-extraction";
import type { SearchIndexOwner } from "@/api/lib/search/process-extraction";
import {
  drainSearchProjectionRepairQueue,
  enqueueEntitySearchRepairs,
} from "@/api/lib/search/projection-repair-queue";
import type { SearchProjectionRepairDeps } from "@/api/lib/search/projection-repair-queue";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

setDefaultTimeout(120_000);

// Copying entities into a new matter has to leave every copy reachable by
// search without indexing any of them twice. Ownership decides that split:
// a copy whose file a durable extraction run will read is indexed when that
// run completes, and every other copy carries a dirty mark committed with
// the copy itself. What is asserted here is the part no type can hold --
// that the split covers each copy exactly once, that the mark shares the
// fate of the transaction that wrote it, and that a drain then rebuilds
// each marked projection once and never the extracted one.

const ORGANIZATION_ID = "org-search-index-ownership";
const SEED_AT = new Date("2026-01-01T00:00:00.000Z");
const SHA256_HEX = "a".repeat(64);

const uuid = (suffix: number): string =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;

const workspaceId = toSafeId<"workspace">(uuid(1));
const entityId = (suffix: number): SafeId<"entity"> =>
  toSafeId<"entity">(uuid(suffix));

const fileContent = ({
  mimeType,
  pdfFileId = null,
}: {
  mimeType: string;
  pdfFileId?: string | null;
}): FieldContent => ({
  version: 1,
  type: "file",
  id: uuid(900),
  fileName: `source.${mimeType.split("/").at(-1) ?? "bin"}`,
  mimeType,
  sizeBytes: 1024,
  encrypted: false,
  sha256Hex: SHA256_HEX,
  pdfFileId,
});

const textContent = (value: string): FieldContent => ({
  version: 1,
  type: "text",
  value,
});

/**
 * The copies one matter duplication writes: the field arrays are the ones
 * the handler inserts, in the order it inserts them.
 */
const duplicatedCopies = [
  {
    entityId: entityId(10),
    fields: [{ content: fileContent({ mimeType: DOCX_MIME_TYPE }) }],
    label: "a copied document a run will extract",
  },
  {
    entityId: entityId(11),
    // Awaiting a PDF derivative that the copy has no run for yet: nothing
    // else will index it, so the mark has to.
    fields: [{ content: fileContent({ mimeType: "image/png" }) }],
    label: "a copied image with no text layer yet",
  },
  {
    entityId: entityId(12),
    fields: [{ content: textContent("Kickoff call with the client") }],
    label: "a copied task",
  },
  {
    entityId: entityId(13),
    fields: [],
    label: "a copied folder",
  },
] as const;

const copiesOwnedBy = (owner: SearchIndexOwner): SafeId<"entity">[] =>
  duplicatedCopies
    .filter((copy) => searchIndexOwnerForFields(copy.fields) === owner)
    .map((copy) => copy.entityId);

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const asTx = () => asTestRaw<Transaction>(db);

const queuedSourceIds = async () =>
  (
    await db
      .select({ sourceId: searchProjectionRepairQueue.sourceId })
      .from(searchProjectionRepairQueue)
      .orderBy(searchProjectionRepairQueue.sourceId)
  ).map(({ sourceId }) => sourceId);

const recordingRepairDeps = (
  repaired: string[],
): SearchProjectionRepairDeps => {
  const record = async (sourceId: string): Promise<void> => {
    repaired.push(sourceId);
  };
  return {
    db: asTestRaw<SearchProjectionRepairDeps["db"]>(db),
    repair: { contact: record, entity: record, workspace: record },
  };
};

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
}, 300_000);

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await db.execute(
    sql.raw(
      'TRUNCATE TABLE "organization", "search_projection_repair_queue" CASCADE',
    ),
  );
  await db.insert(organization).values({
    createdAt: SEED_AT,
    id: ORGANIZATION_ID,
    name: "Search index ownership",
    slug: ORGANIZATION_ID,
  });
  await db.insert(workspaces).values({
    createdAt: SEED_AT,
    id: workspaceId,
    lastActivityAt: SEED_AT,
    name: "Duplicated matter",
    organizationId: toSafeId<"organization">(ORGANIZATION_ID),
    reference: "2026-0001",
  });
  await db.insert(entities).values(
    duplicatedCopies.map((copy) => ({
      createdAt: SEED_AT,
      id: copy.entityId,
      name: copy.label,
      updatedAt: SEED_AT,
      workspaceId,
    })),
  );
});

test("every copy is owned exactly once, by extraction or by a mark", () => {
  const owned = {
    [SEARCH_INDEX_OWNER.durableExtraction]: copiesOwnedBy(
      SEARCH_INDEX_OWNER.durableExtraction,
    ),
    [SEARCH_INDEX_OWNER.searchMark]: copiesOwnedBy(
      SEARCH_INDEX_OWNER.searchMark,
    ),
  };

  // Both directions: no copy is left unowned, none is claimed twice, and
  // neither owner is exercised by an empty fixture.
  expect(
    [
      ...owned[SEARCH_INDEX_OWNER.durableExtraction],
      ...owned[SEARCH_INDEX_OWNER.searchMark],
    ].sort(),
  ).toEqual(duplicatedCopies.map((copy) => copy.entityId).sort());
  expect(owned[SEARCH_INDEX_OWNER.durableExtraction]).toEqual([entityId(10)]);
  expect(owned[SEARCH_INDEX_OWNER.searchMark]).toEqual([
    entityId(11),
    entityId(12),
    entityId(13),
  ]);
});

test("the copies' marks share the fate of the duplicate transaction", async () => {
  const marked = copiesOwnedBy(SEARCH_INDEX_OWNER.searchMark);

  // bun-types declares `.rejects.toThrow` as void, so awaiting it trips
  // type-aware lint; capture the rejection explicitly instead.
  const rejection: unknown = await db
    .transaction(async (tx) => {
      await enqueueEntitySearchRepairs(asTestRaw<Transaction>(tx), marked);
      throw new Error("duplicate failed after the copies were written");
    })
    .then(
      () => null,
      (error: unknown) => error,
    );

  expect(rejection).toBeInstanceOf(Error);
  expect(await queuedSourceIds()).toEqual([]);

  await db.transaction(async (tx) => {
    await enqueueEntitySearchRepairs(asTestRaw<Transaction>(tx), marked);
  });

  expect(await queuedSourceIds()).toEqual([...marked].sort());
});

test("a drain rebuilds each marked copy once and never the extracted one", async () => {
  const marked = copiesOwnedBy(SEARCH_INDEX_OWNER.searchMark);
  await enqueueEntitySearchRepairs(asTx(), marked);

  const repaired: string[] = [];
  const outcome = await drainSearchProjectionRepairQueue({
    deps: recordingRepairDeps(repaired),
  });

  expect(outcome).toEqual({ failed: 0, repaired: marked.length });
  expect([...repaired].sort()).toEqual([...marked].sort());
  for (const extracted of copiesOwnedBy(SEARCH_INDEX_OWNER.durableExtraction)) {
    expect(repaired).not.toContain(extracted);
  }

  // A second drain finds nothing: one repair per copy, not one per pass.
  expect(await queuedSourceIds()).toEqual([]);
  expect(
    await drainSearchProjectionRepairQueue({
      deps: recordingRepairDeps(repaired),
    }),
  ).toEqual({ failed: 0, repaired: 0 });
  expect(repaired).toHaveLength(marked.length);
});
