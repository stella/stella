import { describe, expect, test } from "bun:test";

import {
  assertOnlineMigrationsApplied,
  ONLINE_MIGRATION_INDEX_CUTOVERS,
  ONLINE_MIGRATION_INDEXES,
  runOnlineMigrations,
} from "./online-migrations";

const CREATE_INDEX_FRAGMENT = "CREATE INDEX CONCURRENTLY";
const DROP_INDEX_FRAGMENT = "DROP INDEX CONCURRENTLY";
const REINDEX_FRAGMENT = "REINDEX INDEX CONCURRENTLY";
const REPORT_EXPORT_INDEX = "report_exports_workspace_requester_created_idx";
const CREDENTIAL_INDEX = "account_credential_singleton_uidx";
const SOURCE_DOCUMENT_INDEX = "case_law_decisions_source_document_idx";
const SOURCE_CASE_INDEX = "case_law_decisions_source_case_lang_null_idx";
const LEGACY_SOURCE_CASE_INDEX = "case_law_decisions_source_case_lang_idx";
const FILTER_INDEX_CUTOVER = ONLINE_MIGRATION_INDEX_CUTOVERS.at(0);
if (!FILTER_INDEX_CUTOVER) {
  throw new TypeError("Expected the filter index cutover");
}
const FILTER_INDEX = FILTER_INDEX_CUTOVER.final.name;
const FILTER_INDEX_REPLACEMENT = FILTER_INDEX_CUTOVER.staged.name;
const DECISION_DATE_CONSTRAINT = "case_law_decisions_decision_date_bounds";
const VALIDATE_CONSTRAINT_FRAGMENT = `VALIDATE CONSTRAINT "${DECISION_DATE_CONSTRAINT}"`;

describe("online migrations", () => {
  test("accepts an already valid index without rebuilding it", async () => {
    const harness = createHarness();

    await runOnlineMigrations(harness.pool);

    expect(indexOfStatement(harness.statements, CREATE_INDEX_FRAGMENT)).toBe(
      -1,
    );
    expect(indexOfStatement(harness.statements, REINDEX_FRAGMENT)).toBe(-1);
    expect(harness.released()).toBe(true);
  });

  test("creates a missing index online and verifies completion", async () => {
    const harness = createHarness({
      indexStates: { [REPORT_EXPORT_INDEX]: [undefined, true] },
    });

    await runOnlineMigrations(harness.pool);

    expect(
      indexOfStatement(harness.statements, CREATE_INDEX_FRAGMENT),
    ).toBeGreaterThan(-1);
    expect(harness.released()).toBe(true);
  });

  test("concurrently repairs an interrupted invalid build", async () => {
    const harness = createHarness({
      indexStates: { [CREDENTIAL_INDEX]: [false, true] },
    });

    await runOnlineMigrations(harness.pool);

    expect(
      indexOfStatement(
        harness.statements,
        `${REINDEX_FRAGMENT} public."${CREDENTIAL_INDEX}"`,
      ),
    ).toBeGreaterThan(-1);
    expect(harness.released()).toBe(true);
  });

  test("drops an interrupted reindex artifact before retrying", async () => {
    const artifactName = `${CREDENTIAL_INDEX}_ccnew`;
    const harness = createHarness({
      artifacts: {
        [CREDENTIAL_INDEX]: [{ isValid: false, name: artifactName }],
      },
      indexStates: { [CREDENTIAL_INDEX]: [false, true] },
    });

    await runOnlineMigrations(harness.pool);

    expect(
      indexOfStatement(
        harness.statements,
        `${DROP_INDEX_FRAGMENT} public."${artifactName}"`,
      ),
    ).toBeGreaterThan(-1);
    expect(
      indexOfStatement(
        harness.statements,
        `${REINDEX_FRAGMENT} public."${CREDENTIAL_INDEX}"`,
      ),
    ).toBeGreaterThan(-1);
  });

  test("rejects a valid same-named index with the wrong definition", async () => {
    const harness = createHarness({
      indexStates: {
        [CREDENTIAL_INDEX]: [
          {
            definitionBody: "ON public.account USING btree (id)",
            isValid: true,
          },
        ],
      },
    });

    const rejection: unknown = await runOnlineMigrations(harness.pool).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toMatchObject({
      message: `Required migration index ${CREDENTIAL_INDEX} has an unexpected definition`,
    });
  });

  test("startup validation rejects an invalid required index", async () => {
    const harness = createHarness({
      indexStates: { [CREDENTIAL_INDEX]: [false] },
    });

    const rejection: unknown = await assertOnlineMigrationsApplied(
      harness.pool,
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toMatchObject({
      message: `Required migration index ${CREDENTIAL_INDEX} is not ready`,
    });
    expect(indexOfStatement(harness.statements, REINDEX_FRAGMENT)).toBe(-1);
  });

  test("retires a legacy index only after both replacements validate", async () => {
    const harness = createHarness();

    await runOnlineMigrations(harness.pool);

    const dropOffset = indexOfStatement(
      harness.statements,
      `DROP INDEX CONCURRENTLY IF EXISTS public."${LEGACY_SOURCE_CASE_INDEX}"`,
    );
    expect(dropOffset).toBeGreaterThan(
      indexOfStatement(harness.statements, SOURCE_DOCUMENT_INDEX),
    );
    expect(dropOffset).toBeGreaterThan(
      indexOfStatement(harness.statements, SOURCE_CASE_INDEX),
    );
  });

  test("preserves a legacy index when a replacement is not ready", async () => {
    const harness = createHarness({
      indexStates: { [SOURCE_CASE_INDEX]: [false, false] },
    });

    const rejection: unknown = await runOnlineMigrations(harness.pool).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toMatchObject({
      message: `Required migration index ${SOURCE_CASE_INDEX} is not ready`,
    });
    expect(indexOfStatement(harness.statements, LEGACY_SOURCE_CASE_INDEX)).toBe(
      -1,
    );
  });

  test("rejects a missing index required by a rewritten migration", async () => {
    const harness = createHarness({
      indexStates: { [CREDENTIAL_INDEX]: [undefined] },
    });

    const rejection: unknown = await runOnlineMigrations(harness.pool).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toMatchObject({
      message: `Required migration index ${CREDENTIAL_INDEX} is missing`,
    });
    expect(harness.released()).toBe(true);
  });

  test("reuses a valid staged index when retrying the cutover", async () => {
    const harness = createHarness({
      indexStates: {
        [FILTER_INDEX]: [undefined, true],
        [FILTER_INDEX_REPLACEMENT]: [true],
      },
    });

    await runOnlineMigrations(harness.pool);

    expect(
      indexOfStatement(
        harness.statements,
        `ALTER INDEX public."${FILTER_INDEX_REPLACEMENT}" RENAME TO "${FILTER_INDEX}"`,
      ),
    ).toBeGreaterThan(-1);
    expect(
      indexOfStatement(
        harness.statements,
        `${DROP_INDEX_FRAGMENT} public."${FILTER_INDEX_REPLACEMENT}"`,
      ),
    ).toBe(-1);
    expect(indexOfStatement(harness.statements, CREATE_INDEX_FRAGMENT)).toBe(
      -1,
    );
  });

  test("keeps a ready final index and removes a stale staged copy", async () => {
    const harness = createHarness({
      indexStates: {
        [FILTER_INDEX]: [true],
        [FILTER_INDEX_REPLACEMENT]: [true],
      },
    });

    await runOnlineMigrations(harness.pool);

    expect(
      indexOfStatement(
        harness.statements,
        `${DROP_INDEX_FRAGMENT} public."${FILTER_INDEX_REPLACEMENT}"`,
      ),
    ).toBeGreaterThan(-1);
    expect(
      indexOfStatement(
        harness.statements,
        `${DROP_INDEX_FRAGMENT} public."${FILTER_INDEX}"`,
      ),
    ).toBe(-1);
  });

  test("cleans interrupted final-index maintenance before completing", async () => {
    const artifactName = `${FILTER_INDEX}_ccnew`;
    const harness = createHarness({
      artifacts: {
        [FILTER_INDEX]: [{ isValid: false, name: artifactName }],
      },
      indexStates: {
        [FILTER_INDEX]: [true, true],
      },
    });

    await runOnlineMigrations(harness.pool);

    expect(
      indexOfStatement(
        harness.statements,
        `${DROP_INDEX_FRAGMENT} public."${artifactName}"`,
      ),
    ).toBeGreaterThan(-1);
  });

  test("repairs the staged index before replacing an older definition", async () => {
    const harness = createHarness({
      indexStates: {
        [FILTER_INDEX]: [
          {
            definitionBody:
              "ON public.case_law_decisions USING btree (updated_at, id)",
            isValid: true,
          },
          true,
        ],
        [FILTER_INDEX_REPLACEMENT]: [false, true],
      },
    });

    await runOnlineMigrations(harness.pool);

    const reindexOffset = indexOfStatement(
      harness.statements,
      `${REINDEX_FRAGMENT} public."${FILTER_INDEX_REPLACEMENT}"`,
    );
    const dropOffset = indexOfStatement(
      harness.statements,
      `${DROP_INDEX_FRAGMENT} public."${FILTER_INDEX}"`,
    );
    const renameOffset = indexOfStatement(
      harness.statements,
      `ALTER INDEX public."${FILTER_INDEX_REPLACEMENT}" RENAME TO "${FILTER_INDEX}"`,
    );
    expect(reindexOffset).toBeGreaterThan(-1);
    expect(dropOffset).toBeGreaterThan(reindexOffset);
    expect(renameOffset).toBeGreaterThan(dropOffset);
  });

  test("validates the decision-date constraint after the index steps, once the repair finds nothing", async () => {
    const harness = createHarness();

    await runOnlineMigrations(harness.pool);

    const validateOffset = indexOfStatement(
      harness.statements,
      VALIDATE_CONSTRAINT_FRAGMENT,
    );
    expect(validateOffset).toBeGreaterThan(
      indexOfStatement(
        harness.statements,
        `DROP INDEX CONCURRENTLY IF EXISTS public."${LEGACY_SOURCE_CASE_INDEX}"`,
      ),
    );
    expect(indexOfStatement(harness.statements, "UPDATE case_law_")).toBe(-1);
    // The repair's own lock wait does not leak past it.
    expect(
      harness.statements
        .slice(validateOffset + 1)
        .includes("SET lock_timeout = '1s'"),
    ).toBe(true);
    expect(harness.released()).toBe(true);
  });

  test("startup validation rejects an unvalidated decision-date constraint without repairing", async () => {
    const harness = createHarness({ constraintValidated: false });

    const rejection: unknown = await assertOnlineMigrationsApplied(
      harness.pool,
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toMatchObject({
      message: `Online repair decision-date-ceiling is not complete: constraint ${DECISION_DATE_CONSTRAINT} is not validated`,
    });
    expect(
      indexOfStatement(harness.statements, VALIDATE_CONSTRAINT_FRAGMENT),
    ).toBe(-1);
    expect(harness.released()).toBe(true);
  });
});

type IndexState =
  | boolean
  | undefined
  | { definitionBody: string; isValid: boolean };
type IndexStates = Readonly<Record<string, IndexState[]>>;
type Artifact = { isValid: boolean; name: string };
type Artifacts = Readonly<Record<string, Artifact[]>>;

type HarnessOptions = {
  artifacts?: Artifacts;
  /** What `pg_constraint` reports for the decision-date constraint. */
  constraintValidated?: boolean;
  indexStates?: IndexStates;
};

const POSTGRES_IDENTIFIER_MAX_LENGTH = 63;

const artifactPrefix = (name: string, suffix: "_ccnew" | "_ccold") =>
  `${name.slice(0, POSTGRES_IDENTIFIER_MAX_LENGTH - suffix.length)}${suffix}`;

const createHarness = ({
  artifacts = {},
  constraintValidated = true,
  indexStates = {},
}: HarnessOptions = {}) => {
  const statements: string[] = [];
  const indexOffsets = new Map<string, number>();
  const remainingArtifacts = new Map(
    Object.entries(artifacts).map(([name, values]) => [name, [...values]]),
  );
  let released = false;
  const managedIndexes = [
    ...ONLINE_MIGRATION_INDEXES,
    ...ONLINE_MIGRATION_INDEX_CUTOVERS.flatMap(({ final, staged }) => [
      final,
      staged,
    ]),
  ];

  return {
    pool: {
      reserve: async () => ({
        execute: async (query: string) => {
          statements.push(query);
          if (!query.includes(DROP_INDEX_FRAGMENT)) {
            return;
          }
          for (const [name, values] of remainingArtifacts) {
            remainingArtifacts.set(
              name,
              values.filter(
                ({ name: artifactName }) =>
                  !query.includes(`"${artifactName}"`),
              ),
            );
          }
        },
        query: async (query: string, params: readonly unknown[] = []) => {
          statements.push(`${query}\n-- params ${JSON.stringify(params)}`);
          if (query.includes("pg_constraint")) {
            return [{ isValidated: constraintValidated }];
          }
          // The decision-date repair's selection: nothing left to repair.
          if (query.includes("corrupt AS MATERIALIZED")) {
            return [];
          }
          if (query.includes("starts_with")) {
            const newPrefix = params.at(2);
            const oldPrefix = params.at(3);
            const index = managedIndexes.find(
              ({ name }) =>
                artifactPrefix(name, "_ccnew") === newPrefix &&
                artifactPrefix(name, "_ccold") === oldPrefix,
            );
            if (!index) {
              throw new TypeError("Expected managed index artifact prefixes");
            }
            return (remainingArtifacts.get(index.name) ?? []).map(
              ({ isValid, name }) => indexRow(index, isValid, name),
            );
          }

          const indexName = params.at(1);
          if (typeof indexName !== "string") {
            throw new TypeError("Expected index name query parameter");
          }
          const index = managedIndexes.find(({ name }) => name === indexName);
          if (!index) {
            throw new TypeError("Expected managed index name");
          }
          const offset = indexOffsets.get(indexName) ?? 0;
          const states = indexStates[indexName];
          let state: IndexState =
            indexName === FILTER_INDEX_REPLACEMENT ? undefined : true;
          if (states) {
            state = offset < states.length ? states.at(offset) : states.at(-1);
          }
          indexOffsets.set(indexName, offset + 1);
          if (state === undefined) {
            return [];
          }
          if (typeof state === "boolean") {
            return [indexRow(index, state)];
          }
          return [
            indexRow(index, state.isValid, index.name, state.definitionBody),
          ];
        },
        release: () => {
          released = true;
        },
      }),
    },
    released: () => released,
    statements,
  };
};

const indexRow = (
  index: (typeof ONLINE_MIGRATION_INDEXES)[number],
  isValid: boolean,
  name = index.name,
  body = index.definitionBody,
) => ({
  definition: `CREATE ${index.isUnique ? "UNIQUE " : ""}INDEX ${name} ${body}`,
  isReady: isValid,
  isUnique: index.isUnique,
  isValid,
  name,
});

const indexOfStatement = (statements: string[], fragment: string): number =>
  statements.findIndex((statement) => statement.includes(fragment));
