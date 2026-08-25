/**
 * What "the playbook's latest approved version" means, exercised against a real
 * schema because the schema is what makes it true:
 *
 *  - the single run reads one playbook's pin and the auto-run reads a batch of
 *    them; both must land on the same pin for the same playbook, or one matter
 *    would measure its documents against two standards depending on which
 *    button opened the review,
 *  - a snapshot names why it exists, and only an approval can be stored, so
 *    "the newest row" and "the newest approved row" cannot come apart behind
 *    the pin's back.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { inArray, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  playbookDefinitions,
  playbookDefinitionVersions,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  loadLatestApprovedVersion,
  loadLatestApprovedVersions,
} from "@/api/lib/document-review/approved-playbook-versions";
import { resolvePlaybookPin } from "@/api/lib/document-review/resolve-playbook-pin";
import type { PlaybookDefinitionForPin } from "@/api/lib/document-review/resolve-playbook-pin";
import { PLAYBOOK_VERSION_SOURCE } from "@/api/lib/workflow/playbook-positions";
import type { PlaybookPositions } from "@/api/lib/workflow/playbook-positions";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;

const seededDefinitionIds: SafeId<"playbookDefinition">[] = [];

/** The constraint under test, named exactly as `db/schema/properties.ts`
 *  declares it: a rename fails this assertion rather than quietly leaving the
 *  rule untested. */
const SOURCE_VALUES_CHECK = "playbook_def_versions_source_values_check";

const POSITION_ID = "11111111-1111-4111-8111-111111111111";

const positionsSaying = (issue: string): PlaybookPositions => ({
  version: 3,
  items: [
    {
      mode: "extract",
      sourceId: POSITION_ID,
      issue,
      ask: {
        question: "What is the notice period?",
        content: { version: 1, type: "text" },
      },
      enabled: true,
    },
  ],
});

/** bun-types declares `.rejects.toThrow` as void, so awaiting it trips
 *  type-aware lint; capture the rejection explicitly instead. */
const rejectionOf = async (operation: Promise<unknown>): Promise<unknown> =>
  await operation.then(
    () => null,
    (error: unknown) => error,
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const VIOLATION_FIELDS = ["message", "constraint", "detail"] as const;

/** Everything a failure says about which rule it broke, walked through
 *  `cause`, so "some error was thrown" cannot pass as proof. */
const violationText = (error: unknown): string => {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (isRecord(current) && !seen.has(current)) {
    seen.add(current);
    for (const field of VIOLATION_FIELDS) {
      const value = current[field];
      if (typeof value === "string") {
        parts.push(value);
      }
    }
    current = current["cause"];
  }
  return parts.join(" | ");
};

const seedDefinition = async (
  name: string,
  positions: PlaybookPositions,
): Promise<PlaybookDefinitionForPin> => {
  const id = toSafeId<"playbookDefinition">(Bun.randomUUIDv7());
  seededDefinitionIds.push(id);
  await testDb.insert(playbookDefinitions).values({
    id,
    organizationId: ids.orgA,
    name,
    positions,
  });
  return { id, name, positions };
};

/** An approval snapshot, written exactly as `approve.ts` writes one. */
const insertApproval = async ({
  definitionId,
  version,
  name,
  positions,
}: {
  definitionId: SafeId<"playbookDefinition">;
  version: number;
  name: string;
  positions: PlaybookPositions;
}): Promise<SafeId<"playbookDefinitionVersion">> => {
  const id = toSafeId<"playbookDefinitionVersion">(Bun.randomUUIDv7());
  await testDb.insert(playbookDefinitionVersions).values({
    id,
    organizationId: ids.orgA,
    playbookDefinitionId: definitionId,
    version,
    source: PLAYBOOK_VERSION_SOURCE.APPROVAL,
    name,
    positions,
    createdBy: ids.userA1,
  });
  return id;
};

/**
 * A snapshot written past the drizzle schema, either claiming a source the
 * pin does not recognize or naming none at all.
 *
 * Raw SQL on purpose: the column exists to constrain every writer, including
 * a migration or a script that never sees the TypeScript type.
 */
const insertUntypedVersion = async ({
  definitionId,
  name,
  source,
}: {
  definitionId: SafeId<"playbookDefinition">;
  name: string;
  source: string | null;
}): Promise<void> => {
  const id = toSafeId<"playbookDefinitionVersion">(Bun.randomUUIDv7());
  const positions = sql`'{"version": 2, "items": []}'::jsonb`;
  const statement =
    source === null
      ? sql`
          INSERT INTO playbook_definition_versions
            (id, organization_id, playbook_definition_id, version, name,
             positions, created_by)
          VALUES (${id}, ${ids.orgA}, ${definitionId}, 1, ${name},
                  ${positions}, ${ids.userA1})
        `
      : sql`
          INSERT INTO playbook_definition_versions
            (id, organization_id, playbook_definition_id, version, source,
             name, positions, created_by)
          VALUES (${id}, ${ids.orgA}, ${definitionId}, 1, ${source}, ${name},
                  ${positions}, ${ids.userA1})
        `;
  await testDb.execute(statement);
};

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  try {
    if (seededDefinitionIds.length > 0) {
      // The versions cascade with their definition.
      await testDb
        .delete(playbookDefinitions)
        .where(inArray(playbookDefinitions.id, seededDefinitionIds));
    }
  } finally {
    await releaseRlsFixture();
  }
});

describe("resolving the pin a run is measured against", () => {
  test("one playbook and a batch of them resolve the same pin", async () => {
    const edited = await seedDefinition(
      "Live draft name",
      positionsSaying("Edited after approval"),
    );
    const other = await seedDefinition(
      "Other playbook",
      positionsSaying("Unrelated"),
    );
    await insertApproval({
      definitionId: edited.id,
      version: 1,
      name: "Superseded name",
      positions: positionsSaying("As first approved"),
    });
    const latestId = await insertApproval({
      definitionId: edited.id,
      version: 2,
      name: "Approved name",
      positions: positionsSaying("As approved"),
    });
    await insertApproval({
      definitionId: other.id,
      version: 1,
      name: "Other approved name",
      positions: positionsSaying("Someone else's standard"),
    });

    const tx = asTestRaw<Transaction>(testDb);
    // What the single run reads.
    const single = await loadLatestApprovedVersion({
      tx,
      organizationId: ids.orgA,
      playbookDefinitionId: edited.id,
    });
    // What the auto-run and the classification trigger read, for the whole
    // applicable set at once.
    const batch = await loadLatestApprovedVersions({
      tx,
      organizationId: ids.orgA,
      playbookDefinitionIds: [edited.id, other.id],
    });

    if (single === null) {
      throw new Error("The edited playbook must resolve an approved version");
    }
    expect(single.id).toBe(latestId);
    expect(batch.get(edited.id)).toEqual(single);

    const singlePin = resolvePlaybookPin({
      definition: edited,
      latestApprovedVersion: single,
    });
    const batchPin = resolvePlaybookPin({
      definition: edited,
      latestApprovedVersion: batch.get(edited.id) ?? null,
    });

    expect(batchPin).toEqual(singlePin);
    // The pin both surfaces produce is the approved snapshot, not the live
    // definition an author kept editing after approval.
    expect(singlePin).toEqual({
      definitionId: edited.id,
      versionId: latestId,
      provenance: "approved",
      definitionSnapshot: {
        name: "Approved name",
        positions: positionsSaying("As approved"),
      },
    });
    // And a batch resolves each playbook's own pin, never a neighbour's.
    expect(batch.get(other.id)?.name).toBe("Other approved name");
  });

  test("a never-approved playbook pins its live draft on both paths", async () => {
    const draft = await seedDefinition(
      "Never approved",
      positionsSaying("Still being written"),
    );

    const tx = asTestRaw<Transaction>(testDb);
    const single = await loadLatestApprovedVersion({
      tx,
      organizationId: ids.orgA,
      playbookDefinitionId: draft.id,
    });
    const batch = await loadLatestApprovedVersions({
      tx,
      organizationId: ids.orgA,
      playbookDefinitionIds: [draft.id],
    });

    expect(single).toBeNull();
    expect(batch.get(draft.id)).toBeUndefined();
    expect(
      resolvePlaybookPin({ definition: draft, latestApprovedVersion: single }),
    ).toEqual({
      definitionId: draft.id,
      versionId: null,
      provenance: "draft",
      definitionSnapshot: {
        name: "Never approved",
        positions: positionsSaying("Still being written"),
      },
    });
  });
});

describe("what a version snapshot may claim to be", () => {
  test("refuses a snapshot taken for an unrecognized reason", async () => {
    const definition = await seedDefinition(
      "Guarded playbook",
      positionsSaying("Guarded"),
    );

    // The failure mode the column exists for: a snapshot written for some
    // other reason, which the pin would otherwise read as the approved
    // standard because it happens to be the newest row.
    expect(
      violationText(
        await rejectionOf(
          insertUntypedVersion({
            definitionId: definition.id,
            name: "Restored from history",
            source: "restore",
          }),
        ),
      ),
    ).toContain(SOURCE_VALUES_CHECK);
  });

  test("refuses a snapshot that names no reason at all", async () => {
    const definition = await seedDefinition(
      "Unnamed source",
      positionsSaying("Unnamed"),
    );

    // No column default, so a future writer cannot inherit "approval" by
    // saying nothing.
    const violation = violationText(
      await rejectionOf(
        insertUntypedVersion({
          definitionId: definition.id,
          name: "Sourceless",
          source: null,
        }),
      ),
    );
    expect(violation).toContain("source");
    expect(violation).toContain("not-null");
  });
});
