/**
 * The redistribution gate for public decision reads, by construction.
 *
 * A public endpoint that names a decision must answer "not found" when the
 * decision's source may not be redistributed: its citation texts, graph
 * counts and provision references are as much its content as its full text.
 * The gate used to be a check each handler remembered to make, and two
 * handlers shipped without it. Here it is the only way to obtain a
 * `RedistributableDecisionSubject`, and every read handler takes one instead
 * of a bare id, so a handler that skips the gate does not typecheck.
 *
 * The subject carries the transaction that gated it, and that transaction is
 * the only database handle a gated handler receives. Resolving in one
 * transaction and reading in another would leave a window where a source
 * turned restricted in between and the content still went out under a brand
 * that says "gated"; carrying the handle closes it, because the content a
 * handler reads can only come from the state the gate approved. The gated
 * transaction is a repeatable-read snapshot, so every statement under it —
 * the gate's and the handler's — sees that one state.
 */
import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { status } from "elysia";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import type {
  PublicHandlerConfig,
  PublicHandlerContext,
  SafeHandlerGenerator,
} from "@/api/lib/api-handlers";
import { createSafePublicHandler } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { normalizePublicDecisionLanguage } from "@/api/lib/case-law/decision-language";
import { isRedistributable } from "@/api/lib/legal-search/corpus-source";

/** Module-private, so the subject type is constructible only below. */
const REDISTRIBUTABLE: unique symbol = Symbol("redistributableDecisionSubject");

/**
 * A decision the public may read: resolved and gated in one place.
 *
 * `tx` is the transaction the gate ran in. A handler reads through it and
 * receives no other handle, so its rows and the gate's verdict come from one
 * snapshot; see the module comment.
 */
export type RedistributableDecisionSubject = {
  readonly id: SafeId<"caseLawDecision">;
  readonly tx: CaseLawPublicReadTransaction;
  readonly [REDISTRIBUTABLE]: true;
};

const subjectOf = (
  id: SafeId<"caseLawDecision">,
  tx: CaseLawPublicReadTransaction,
): RedistributableDecisionSubject => ({ id, tx, [REDISTRIBUTABLE]: true });

/** How a request names its subject. */
export type DecisionSubjectLocator =
  | { kind: "id"; id: SafeId<"caseLawDecision"> }
  | { kind: "slug"; slug: string; language: string | undefined };

const locatorCondition = (locator: DecisionSubjectLocator) => {
  switch (locator.kind) {
    case "id":
      return eq(caseLawDecisions.id, locator.id);
    case "slug": {
      const language = normalizePublicDecisionLanguage(locator.language);
      if (locator.language !== undefined && language === null) {
        return null;
      }
      return language === null
        ? eq(caseLawDecisions.slug, locator.slug)
        : and(
            eq(caseLawDecisions.slug, locator.slug),
            sql`replace(lower(${caseLawDecisions.language}), '_', '-') = ${language}`,
          );
    }
    default: {
      const exhaustive: never = locator;
      return exhaustive;
    }
  }
};

/**
 * The subject a locator names within `tx`, or null when it does not exist or
 * its source may not be redistributed. The two cases are deliberately one
 * answer: a restricted decision does not exist for the public.
 */
const resolveSubjectIn = async (
  tx: CaseLawPublicReadTransaction,
  locator: DecisionSubjectLocator,
): Promise<RedistributableDecisionSubject | null> => {
  const condition = locatorCondition(locator);
  if (condition === null) {
    return null;
  }
  const rows = await tx
    .select({
      id: caseLawDecisions.id,
      descriptor: caseLawSources.descriptor,
    })
    .from(caseLawDecisions)
    .innerJoin(caseLawSources, eq(caseLawSources.id, caseLawDecisions.sourceId))
    .where(condition)
    .limit(1);
  const row = rows.at(0);
  if (row === undefined || !isRedistributable(row.descriptor)) {
    return null;
  }
  return subjectOf(row.id, tx);
};

/**
 * Gate a decision and read it in one transaction.
 *
 * `read` runs with the subject inside the transaction that approved it, so
 * every row it returns belongs to the snapshot the gate judged. Returns null
 * when the decision does not exist or its source may not be redistributed;
 * every caller turns that into the same "not found" its surface uses.
 *
 * Work that must not hold a database transaction — fetching a document from
 * the publisher, writing through the ingestion path — belongs after this
 * resolves, never inside `read`.
 */
export const withRedistributableSubject = async <T>(
  caseLawDb: CaseLawPublicReadDb,
  locator: DecisionSubjectLocator,
  read: (subject: RedistributableDecisionSubject) => Promise<T>,
): Promise<T | null> =>
  await caseLawDb(
    async (tx) => {
      const subject = await resolveSubjectIn(tx, locator);
      return subject === null ? null : await read(subject);
    },
    { isolation: "repeatable-read" },
  );

export const DECISION_NOT_FOUND = { message: "Decision not found" } as const;

const notFound = () => status(404, DECISION_NOT_FOUND);
type NotFoundStatus = ReturnType<typeof notFound>;

/** Handlers the factory produced; the route census checks both directions. */
const gatedHandlers = new Set<unknown>();

/**
 * The subject travels beside the context rather than merged into it: an
 * intersection over Elysia's context type is instantiated afresh at every
 * call site, and the route tree is a hot enough generic path to feel it.
 */
type SubjectHandlerOptions<TConfig extends PublicHandlerConfig, TRead> = {
  config: TConfig;
  caseLawDb: CaseLawPublicReadDb;
  /** Which decision the request names. */
  locate: (ctx: PublicHandlerContext<TConfig>) => DecisionSubjectLocator;
  /** Runs inside the gated transaction; reads through `subject.tx` only. */
  read: (
    subject: RedistributableDecisionSubject,
    ctx: PublicHandlerContext<TConfig>,
  ) => Promise<TRead>;
};

type FollowUpOptions<TConfig extends PublicHandlerConfig, TRead, TResult> = {
  followUp: (
    read: TRead,
    ctx: PublicHandlerContext<TConfig>,
  ) => Promise<TResult>;
};

/**
 * The one implementation behind both entry points below: gate, read inside
 * the gated transaction, then run the follow-up once it has closed. Private,
 * so the gate cannot be reached except through a factory that registers its
 * handler for the route census.
 */
const buildGatedSubjectHandler = <
  TConfig extends PublicHandlerConfig,
  TRead,
  TResult extends NonNullable<unknown>,
>({
  config,
  caseLawDb,
  locate,
  read,
  followUp,
}: SubjectHandlerOptions<TConfig, TRead> &
  FollowUpOptions<TConfig, TRead, TResult>) => {
  const definition = createSafePublicHandler(
    config,
    async function* (
      ctx: PublicHandlerContext<TConfig>,
    ): SafeHandlerGenerator<TResult | NotFoundStatus> {
      // `null` is the gate's answer, so a read that resolves to null of its
      // own accord would be indistinguishable; wrap it instead.
      const gated = yield* Result.await(
        Result.tryPromise(
          async () =>
            await withRedistributableSubject(
              caseLawDb,
              locate(ctx),
              async (subject) => ({ value: await read(subject, ctx) }),
            ),
        ),
      );
      if (gated === null) {
        return Result.ok(notFound());
      }
      const response = yield* Result.await(
        Result.tryPromise(async () => await followUp(gated.value, ctx)),
      );

      return Result.ok(response);
    },
  );
  gatedHandlers.add(definition.handler);
  return definition;
};

/**
 * A gated read followed by work that must not hold a database transaction
 * open: a publisher fetch, an ingestion write. `followUp` runs on the value
 * the gated read produced, after the gated transaction closes.
 *
 * The factory resolves the locator, answers 404 for a missing or restricted
 * decision, and only then runs `read` with the branded subject, whose
 * transaction is the only database handle the read receives.
 */
export const createSafePublicSubjectFollowUpHandler = <
  TConfig extends PublicHandlerConfig,
  TRead,
  TResult extends NonNullable<unknown>,
>(
  options: SubjectHandlerOptions<TConfig, TRead> &
    FollowUpOptions<TConfig, TRead, TResult>,
) => buildGatedSubjectHandler(options);

/** The follow-up of a handler whose gated read is already the response. */
const readIsTheResponse = async <T>(read: T): Promise<T> =>
  await Promise.resolve(read);

/**
 * The same gate, for a read that is the whole answer.
 *
 * The follow-up is the identity, so the response type is the read's own. The
 * two shapes are separate entry points rather than one optional phase
 * because a type parameter defaulted to "whatever the read returned" is a
 * fact the compiler cannot check, and only an assertion could state it.
 */
export const createSafePublicSubjectHandler = <
  TConfig extends PublicHandlerConfig,
  TRead extends NonNullable<unknown>,
>(
  options: SubjectHandlerOptions<TConfig, TRead>,
) =>
  buildGatedSubjectHandler({
    ...options,
    followUp: readIsTheResponse,
  });

/** Whether a mounted route handler came out of the factory. */
export const isSubjectGatedHandler = (handler: unknown): boolean =>
  typeof handler === "function" && gatedHandlers.has(handler);

/** Every handler the factory produced, for the census's other direction. */
export const subjectGatedHandlers = (): ReadonlySet<unknown> => gatedHandlers;
