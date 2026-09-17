/** Public route factories and the census of handlers they gate. */
import { Result } from "better-result";
import { status } from "elysia";

import type {
  PublicHandlerConfig,
  PublicHandlerContext,
  SafeHandlerGenerator,
} from "@/api/lib/api-handlers";
import { createSafePublicHandler } from "@/api/lib/api-handlers";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { withRedistributableSubject } from "@/api/lib/case-law/public-subject";
import type {
  DecisionSubjectLocator,
  RedistributableDecisionSubject,
} from "@/api/lib/case-law/public-subject";

export const DECISION_NOT_FOUND = { message: "Decision not found" } as const;

const notFound = () => status(404, DECISION_NOT_FOUND);
type NotFoundStatus = ReturnType<typeof notFound>;

/**
 * A request whose address cannot be read at all, as against one that names no
 * decision. A country spelling the reader cannot resolve is the caller's to
 * correct, so it carries the reader's ask instead of joining the one answer
 * missing and restricted subjects share.
 */
export type UnreadableSubjectAddress = { kind: "unreadable"; message: string };

const unreadableAddress = (message: string) => status(400, { message });
type UnreadableAddressStatus = ReturnType<typeof unreadableAddress>;

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
  /** Which decision the request names, or why its address is unreadable. */
  locate: (
    ctx: PublicHandlerContext<TConfig>,
  ) => DecisionSubjectLocator | UnreadableSubjectAddress;
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
    ): SafeHandlerGenerator<
      TResult | NotFoundStatus | UnreadableAddressStatus
    > {
      const located = locate(ctx);
      if (located.kind === "unreadable") {
        return Result.ok(unreadableAddress(located.message));
      }
      // `null` is the gate's answer, so a read that resolves to null of its
      // own accord would be indistinguishable; wrap it instead.
      const gated = yield* Result.await(
        Result.tryPromise(
          async () =>
            await withRedistributableSubject(
              caseLawDb,
              located,
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
