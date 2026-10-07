import { Result } from "better-result";

import { DEFAULT_CUTOFF } from "@stll/sanctions";

import {
  SANCTIONS_MATCHER_CONFIG,
  sharedSanctionsMatcherPool,
  isSanctionsMatcherCancelled,
} from "./matcher-pool";
import {
  loadEditionEntries,
  observeSanctionsIndexLoadFailure,
  SanctionsIndexLoadFailure,
} from "./screening-index";
import {
  screenSanctionsSubject,
  unavailableSanctionsScreening,
} from "./screening-service";

type PublicScreeningOptions = {
  pool?: typeof sharedSanctionsMatcherPool;
  loadEntries?: typeof loadEditionEntries;
};

export const createPublicSanctionsScreening = ({
  pool = sharedSanctionsMatcherPool,
  loadEntries = loadEditionEntries,
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
          matcher: async ({ db, source, edition, query, limit }) => {
            if (isSanctionsMatcherCancelled(session.signal)) {
              return null;
            }
            let entries = null;
            if (!session.hasEdition(source, edition.id)) {
              const key = `${source}:${edition.id}`;
              while (!isSanctionsMatcherCancelled(session.signal)) {
                let pending = coldLoads.get(key);
                if (pending === undefined) {
                  if (coldLoads.size >= SANCTIONS_MATCHER_CONFIG.poolSizeMax) {
                    return null;
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
                entries = await pending.entries;
                // Join canceled reads before replacing them, preserving the load cap.
                if (!isSanctionsMatcherCancelled(pending.signal)) {
                  break;
                }
              }
            }
            if (isSanctionsMatcherCancelled(session.signal)) {
              return null;
            }
            if (entries !== null && entries.length !== edition.entryCount) {
              observeSanctionsIndexLoadFailure(
                new SanctionsIndexLoadFailure({
                  stage: "short-read",
                  message: `Read ${entries.length} of ${edition.entryCount} entries`,
                }),
                { source, editionId: edition.id },
              );
              return null;
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
            return reply.status === "screened" ? reply.result : null;
          },
        }),
      options,
    );
    return result;
  };
  return async (props) => {
    const result = await execute(props);
    if (result === null && warming.pending === null) {
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
          onSettled: () => {
            warming.pending = null;
          },
        },
      );
    }
    return (
      result ??
      Result.ok(
        unavailableSanctionsScreening({
          reason: "load-failed",
          practiceJurisdictions: props.practiceJurisdictions,
          now: props.now,
        }),
      )
    );
  };
};

export const screenPublicSanctionsSubject = createPublicSanctionsScreening();
