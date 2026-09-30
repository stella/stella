import { Result } from "better-result";

import { DEFAULT_CUTOFF } from "@stll/sanctions";

import {
  SANCTIONS_MATCHER_CONFIG,
  sharedSanctionsMatcherPool,
} from "./matcher-pool";
import { loadEditionEntries } from "./screening-index";
import {
  SANCTIONS_MATCH_LIMIT,
  screenSanctionsSubject,
  unavailableSanctionsScreening,
} from "./screening-service";
import type { ScreenSanctionsSubjectProps } from "./screening-service";

type PublicScreeningOptions = {
  pool?: typeof sharedSanctionsMatcherPool;
  loadEntries?: typeof loadEditionEntries;
};

export const createPublicSanctionsScreening = ({
  pool = sharedSanctionsMatcherPool,
  loadEntries = loadEditionEntries,
}: PublicScreeningOptions = {}): typeof screenSanctionsSubject => {
  let warming: Promise<unknown> | null = null;
  const execute = async (
    props: ScreenSanctionsSubjectProps,
    deadlineMs?: number,
  ) => {
    const result = await pool.run(
      async (session) =>
        await screenSanctionsSubject({
          ...props,
          matcher: async ({ db, source, edition, query }) => {
            if (session.signal.aborted) {
              return null;
            }
            const entries = session.hasEdition(source, edition.id)
              ? null
              : await loadEntries(db, edition);
            if (
              session.signal.aborted ||
              (entries !== null && entries.length !== edition.entryCount)
            ) {
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
              limit: SANCTIONS_MATCH_LIMIT,
            });
            return reply.status === "screened" ? reply.result : null;
          },
        }),
      deadlineMs === undefined ? undefined : { deadlineMs },
    );
    return result;
  };
  return async (props) => {
    const result = await execute(props);
    if (result === null && warming === null) {
      // A large cold edition can exceed the request deadline. Rebuild without
      // identity input in one bounded background lease so it can become usable.
      warming = execute(
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
        SANCTIONS_MATCHER_CONFIG.warmupDeadlineMs,
      ).finally(() => {
        warming = null;
      });
    }
    return result === null
      ? Result.ok(
          unavailableSanctionsScreening({
            reason: "load-failed",
            practiceJurisdictions: props.practiceJurisdictions,
            now: props.now,
          }),
        )
      : result;
  };
};

export const screenPublicSanctionsSubject = createPublicSanctionsScreening();
