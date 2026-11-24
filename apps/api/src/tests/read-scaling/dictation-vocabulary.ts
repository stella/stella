import { panic, Result } from "better-result";
import { eq, inArray } from "drizzle-orm";
import * as v from "valibot";

import type { SafeDb } from "@/api/db/safe-db";
import { dictationVocabularyTerms } from "@/api/db/schema";
import addDictationVocabulary from "@/api/handlers/organization-settings/dictation-vocabulary/add";
import checkDictationVocabulary from "@/api/handlers/organization-settings/dictation-vocabulary/check";
import deleteDictationVocabulary from "@/api/handlers/organization-settings/dictation-vocabulary/delete";
import exportDictationVocabulary from "@/api/handlers/organization-settings/dictation-vocabulary/export";
import listDictationVocabulary from "@/api/handlers/organization-settings/dictation-vocabulary/list";
import { HttpStatusResponse } from "@/api/http/status";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

/** The target organization's own words; other organizations grow around it. */
const TARGET_WORDS = 20;
const PEER_WORDS = 5;
const ROUTE = "/v1/organization-settings/dictation-vocabulary";

const recordAuditEvent: AuditRecorder = async () => {
  await Promise.resolve();
};

const word = (prefix: string, index: number) =>
  `${prefix} word ${String(index).padStart(3, "0")}`;

/** `size` organizations each hold a few words; the first is the target. */
export const seedDictationVocabularyScaling = async (
  db: GatedTestDb,
  size: number,
) => {
  const organizationIds = Array.from({ length: size }, () =>
    mintAuthProviderId<"organization">(),
  );
  const target = organizationIds.at(0) ?? panic("Scaling needs a target");
  const rows = organizationIds.flatMap((organizationId, organization) =>
    Array.from(
      { length: organization === 0 ? TARGET_WORDS : PEER_WORDS },
      (_, index) => {
        const term = word(organization === 0 ? "target" : "peer", index);
        return { organizationId, term, termKey: term.toLowerCase() };
      },
    ),
  );
  await db.insert(dictationVocabularyTerms).values(rows);
  const targetWords = rows
    .filter(({ organizationId }) => organizationId === target)
    .map(({ term }) => term);
  const safeDb: SafeDb = async (work) =>
    await Result.tryPromise(async () => await db.transaction(work));
  const targetIds = async (): Promise<SafeId<"dictationVocabularyTerm">[]> =>
    (
      await db
        .select({ id: dictationVocabularyTerms.id })
        .from(dictationVocabularyTerms)
        .where(eq(dictationVocabularyTerms.organizationId, target))
    ).map(({ id }) => id);
  return {
    organizationId: target,
    userId: mintAuthProviderId<"user">(),
    targetWords,
    targetIds,
    safeDb,
    /** Back to the seeded words, whatever a scenario added or deleted. */
    reset: async () => {
      await db
        .delete(dictationVocabularyTerms)
        .where(eq(dictationVocabularyTerms.organizationId, target));
      await db.insert(dictationVocabularyTerms).values(
        targetWords.map((term) => ({
          organizationId: target,
          term,
          termKey: term.toLowerCase(),
        })),
      );
    },
    cleanup: async () => {
      await db
        .delete(dictationVocabularyTerms)
        .where(
          inArray(dictationVocabularyTerms.organizationId, organizationIds),
        );
    },
  };
};

type DictationVocabularyFixture = Awaited<
  ReturnType<typeof seedDictationVocabularyScaling>
>;

const context = (
  fixture: DictationVocabularyFixture,
  method: string,
  path = ROUTE,
) => ({
  session: { activeOrganizationId: fixture.organizationId },
  user: {
    id: fixture.userId,
    email: `${fixture.userId}@example.test`,
    emailVerified: true,
  },
  memberRole: sessionMemberRole("owner"),
  safeDb: fixture.safeDb,
  recordAuditEvent,
  request: new Request(`https://example.test${path}`, { method }),
  route: path,
});

const measured = (response: unknown, rows: number) => ({
  responseBytes: Buffer.byteLength(JSON.stringify(response)),
  rows,
});

export const dictationVocabularyScalingScenarios = [
  {
    name: "organization dictation words page",
    definition: listDictationVocabulary,
    measure: async (fixture: DictationVocabularyFixture) => {
      await fixture.reset();
      return await runWithMeasuredQueryCounter(async (counter) => {
        const response = await listDictationVocabulary.handler(
          asTestRaw<Parameters<typeof listDictationVocabulary.handler>[0]>({
            ...context(fixture, "GET"),
            query: v.parse(listDictationVocabulary.config.query, {}),
          }),
        );
        if (
          response instanceof HttpStatusResponse ||
          response.items.length !== TARGET_WORDS
        ) {
          panic("The page must hold only the target organization's words");
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          ...measured(response, response.items.length),
        };
      });
    },
  },
  {
    name: "organization dictation words export",
    definition: exportDictationVocabulary,
    measure: async (fixture: DictationVocabularyFixture) => {
      await fixture.reset();
      return await runWithMeasuredQueryCounter(async (counter) => {
        const response = await exportDictationVocabulary.handler(
          asTestRaw<Parameters<typeof exportDictationVocabulary.handler>[0]>(
            context(fixture, "GET", `${ROUTE}/export`),
          ),
        );
        if (
          response instanceof HttpStatusResponse ||
          response.terms.length !== TARGET_WORDS
        ) {
          panic("The export must hold only the target organization's words");
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          ...measured(response, response.terms.length),
        };
      });
    },
  },
  {
    name: "check organization dictation words",
    definition: checkDictationVocabulary,
    measure: async (fixture: DictationVocabularyFixture) => {
      await fixture.reset();
      return await runWithMeasuredQueryCounter(async (counter) => {
        const response = await checkDictationVocabulary.handler(
          asTestRaw<Parameters<typeof checkDictationVocabulary.handler>[0]>({
            ...context(fixture, "POST", `${ROUTE}/check`),
            body: { terms: [...fixture.targetWords.slice(0, 5), "new word"] },
          }),
        );
        if (response instanceof HttpStatusResponse || response.listed !== 5) {
          panic("The check must find only the target organization's words");
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          ...measured(response, response.listed),
        };
      });
    },
  },
  {
    name: "add organization dictation words",
    definition: addDictationVocabulary,
    measure: async (fixture: DictationVocabularyFixture) => {
      await fixture.reset();
      return await runWithMeasuredQueryCounter(async (counter) => {
        const response = await addDictationVocabulary.handler(
          asTestRaw<Parameters<typeof addDictationVocabulary.handler>[0]>({
            ...context(fixture, "POST"),
            body: {
              terms: [
                "new word",
                fixture.targetWords.at(0) ?? panic("Scaling needs words"),
              ],
            },
          }),
        );
        if (
          response instanceof HttpStatusResponse ||
          response.added !== 1 ||
          response.total !== TARGET_WORDS + 1
        ) {
          panic("The add must count only the target organization's words");
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          ...measured(response, response.added),
        };
      });
    },
  },
  {
    name: "delete organization dictation words",
    definition: deleteDictationVocabulary,
    measure: async (fixture: DictationVocabularyFixture) => {
      await fixture.reset();
      const ids = (await fixture.targetIds()).slice(0, 2);
      return await runWithMeasuredQueryCounter(async (counter) => {
        const response = await deleteDictationVocabulary.handler(
          asTestRaw<Parameters<typeof deleteDictationVocabulary.handler>[0]>({
            ...context(fixture, "DELETE"),
            body: { ids },
          }),
        );
        if (
          response instanceof HttpStatusResponse ||
          response.deleted !== 2 ||
          response.total !== TARGET_WORDS - 2
        ) {
          panic("The delete must remove only the named target words");
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          ...measured(response, response.deleted),
        };
      });
    },
  },
];
