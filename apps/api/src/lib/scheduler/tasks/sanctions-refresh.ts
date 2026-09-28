import { Result } from "better-result";

import { envBase } from "@/api/env-base";
import { readSanctionsFreshness } from "@/api/lib/sanctions/freshness";
import { getSanctionsIngestionDb } from "@/api/lib/sanctions/ingestion-db";
import {
  recordUnexpectedSanctionsFailure,
  refreshSanctionsSource,
} from "@/api/lib/sanctions/refresh";
import { sanctionsSourceIds } from "@/api/lib/sanctions/source-config";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const REFRESH_SANCTIONS_SOURCES_TASK =
  "sanctions.refreshSources" as const;

export const refreshSanctionsSourcesTask: SchedulerTask = async ({
  logger,
  signal,
}) => {
  const db = getSanctionsIngestionDb();
  for (const source of sanctionsSourceIds()) {
    if (signal.aborted) {
      break;
    }
    const startedAt = new Date();
    // db-await-in-loop: publisher-aware sequential fetches bound memory and network use; every source records its own terminal refresh outcome.
    const attempt = await Result.tryPromise(
      async () =>
        await refreshSanctionsSource({
          db,
          source,
          signal,
          euXmlUrlOverride: envBase.SANCTIONS_EU_XML_URL,
          userAgent: envBase.INGESTION_USER_AGENT,
        }),
    );
    if (attempt.isErr()) {
      logger.warn("scheduler.sanctions_source_refresh_failed", {
        "sanctions.source": source,
        "sanctions.failure_code": "unexpected-error",
      });
      // db-await-in-loop: each source records its own crash after the failed attempt; the next source must still run.
      const recorded = await Result.tryPromise(
        async () =>
          await recordUnexpectedSanctionsFailure({ db, source, startedAt }),
      );
      if (recorded.isErr()) {
        logger.warn("scheduler.sanctions_source_failure_record_failed", {
          "sanctions.source": source,
        });
      }
      continue;
    }
    const outcome = attempt.value;
    logger.info("scheduler.sanctions_source_refreshed", {
      "sanctions.source": source,
      "sanctions.status": outcome.status,
      ...(outcome.status === "activated" && {
        "sanctions.entry_count": outcome.entryCount,
      }),
      ...((outcome.status === "failed" || outcome.status === "held") && {
        "sanctions.failure_code": outcome.code,
      }),
    });
  }

  const freshness = await readSanctionsFreshness({ db });
  for (const source of freshness) {
    if (source.status === "unavailable" || source.annotation !== null) {
      logger.warn("scheduler.sanctions_source_status", {
        "sanctions.source": source.source,
        "sanctions.reason": source.reason,
        "sanctions.annotation": source.annotation?.type ?? null,
        "sanctions.held_code": source.heldUpdate?.code ?? null,
      });
    }
  }
};
