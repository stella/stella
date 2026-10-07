import { panic, Result } from "better-result";

import { DEFAULT_CUTOFF } from "@stll/sanctions";

import {
  SANCTIONS_MATCHER_CONFIG,
  sharedSanctionsMatcherPool,
  isSanctionsMatcherCancelled,
} from "./matcher-pool";
import { reportSanctionsScreeningFailure } from "./screening-failure";
import { loadEditionEntries } from "./screening-index";
import {
  screenSanctionsSubject,
  unavailableSanctionsScreening,
} from "./screening-service";

type PublicScreeningOptions = {
  pool?: typeof sharedSanctionsMatcherPool;
  loadEntries?: typeof loadEditionEntries;
  reportFailure?: typeof reportSanctionsScreeningFailure;
};

export const createPublicSanctionsScreening = ({
  pool = sharedSanctionsMatcherPool,
  loadEntries = loadEditionEntries,
  reportFailure = reportSanctionsScreeningFailure,
}: PublicScreeningOptions = {}): typeof screenSanctionsSubject => {
  const warming: { pending: Promise<unknown> | null } = { pending: null };
  const coldLoads = new Map<
    string,
    { signal: AbortSignal; entries: ReturnType<typeof loadEditionEntries> }
  >();
  const execute = async (
    props: Parameters<typeof screenSanctionsSubject>[0],
    options?: { deadlineMs: number; onSettled: () => void },
  ) => {
    const result = await pool.run(
      async (session) =>
        await screenSanctionsSubject({
          ...props,
          reportFailure,
          matcher: async ({ db, source, edition, query, limit }) => {
            if (isSanctionsMatcherCancelled(session.signal)) {
              return Result.err({
                code: "load-failed",
                stage: "list-screening",
                reason: "matcher-unavailable",
              } as const);
            }
            let entries = null;
            if (!session.hasEdition(source, edition.id)) {
              const key = `${source}:${edition.id}`;
              while (!isSanctionsMatcherCancelled(session.signal)) {
                let pending = coldLoads.get(key);
                if (pending === undefined) {
                  if (coldLoads.size >= SANCTIONS_MATCHER_CONFIG.poolSizeMax) {
                    return Result.err({
                      code: "load-failed",
                      stage: "public-matcher",
                      reason: "admission",
                    } as const);
                  }
                  pending = {
                    signal: session.signal,
                    entries: loadEntries({
                      db,
                      edition,
                      signal: session.signal,
                    }).finally(() => {
                      coldLoads.delete(key);
                    }),
                  };
                  coldLoads.set(key, pending);
                }
                const pendingEntries = pending.entries;
                const loaded = await Result.tryPromise(
                  async () => await pendingEntries,
                );
                if (loaded.isErr()) {
                  return Result.err({
                    code: "load-failed",
                    stage: "public-matcher",
                    reason: "entries-read",
                    cause: loaded.error,
                  } as const);
                }
                entries = loaded.value;
                // Join canceled reads before replacing them, preserving the load cap.
                if (!isSanctionsMatcherCancelled(pending.signal)) {
                  break;
                }
              }
            }
            if (
              isSanctionsMatcherCancelled(session.signal) ||
              (entries !== null && entries.length !== edition.entryCount)
            ) {
              return Result.err({
                code: "load-failed",
                stage: "public-matcher",
                reason: isSanctionsMatcherCancelled(session.signal)
                  ? "matcher-unavailable"
                  : "short-read",
              } as const);
            }
            const reply = await session.match({
              source,
              editionId: edition.id,
              list:
                entries === null
                  ? null
                  : {
                      version: {
                        source,
                        publishedAt: edition.publishedAt,
                        fileId: edition.fileId,
                      },
                      entries,
                    },
              query,
              cutoff: DEFAULT_CUTOFF,
              limit,
            });
            switch (reply.status) {
              case "screened":
                return Result.ok(reply.result);
              case "work-limit":
                return Result.err({
                  code: "load-failed",
                  stage: "public-matcher",
                  reason: "work-limit",
                } as const);
              case "unavailable":
              case "entries-loaded":
                return Result.err({
                  code: "load-failed",
                  stage: "public-matcher",
                  reason: "matcher-unavailable",
                } as const);
              default:
                reply satisfies never;
                return panic("Unhandled sanctions matcher reply");
            }
          },
        }),
      options,
    );
    return result;
  };
  return async (props) => {
    const result = await execute(props);
    if (result.status === "unavailable" && warming.pending === null) {
      // A large cold edition can exceed the request deadline. Rebuild without
      // identity input in one bounded background lease so it can become usable.
      warming.pending = execute(
        {
          db: props.db,
          subject: {
            type: "organization",
            name: "Sanctions Cache Warmup",
            identifiers: [],
          },
          practiceJurisdictions: [],
          now: props.now,
        },
        {
          deadlineMs: SANCTIONS_MATCHER_CONFIG.warmupDeadlineMs,
          // A deadline answers early; only finished reads release this warmup.
          onSettled: () => {
            warming.pending = null;
          },
        },
      );
    }
    if (result.status === "completed") {
      return result.value;
    }
    reportFailure({ stage: "whole-screening", reason: result.cause });
    return Result.ok(
      unavailableSanctionsScreening({
        reason: "load-failed",
        practiceJurisdictions: props.practiceJurisdictions,
        now: props.now,
      }),
    );
  };
};

export const screenPublicSanctionsSubject = createPublicSanctionsScreening();
