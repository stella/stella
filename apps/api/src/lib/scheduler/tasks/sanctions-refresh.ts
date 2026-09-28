import { Result } from "better-result";

import { envBase } from "@/api/env-base";
import { readSanctionsFreshness } from "@/api/lib/lists/sanctions/freshness";
import { getSanctionsIngestionDb } from "@/api/lib/lists/sanctions/ingestion-db";
import {
  recordUnexpectedSanctionsFailure,
  refreshSanctionsSource,
} from "@/api/lib/lists/sanctions/refresh";
import { sanctionsSourceIds } from "@/api/lib/lists/sanctions/source-config";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const REFRESH_SANCTIONS_SOURCES_TASK =
  "sanctions.refreshSources" as const;

export const refreshSanctionsSourcesTask: SchedulerTask = async ({
  logger,
  signal,
}) => {
  const db = getSanctionsIngestionDb();
  const sources = sanctionsSourceIds();
  const refreshNextSource = async (index: number): Promise<void> => {
    const source = sources.at(index);
    if (source === undefined) {
      return;
    }
    signal.throwIfAborted();
    const startedAt = new Date();
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
      signal.throwIfAborted();
      logger.warn("scheduler.sanctions_source_refresh_failed", {
        "sanctions.source": source,
        "sanctions.failure_code": "unexpected-error",
      });
      const recorded = await Result.tryPromise(
        async () =>
          await recordUnexpectedSanctionsFailure({ db, source, startedAt }),
      );
      if (recorded.isErr()) {
        logger.warn("scheduler.sanctions_source_failure_record_failed", {
          "sanctions.source": source,
        });
      }
      await refreshNextSource(index + 1);
      return;
    }
    const outcome = attempt.value;
    signal.throwIfAborted();
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
    await refreshNextSource(index + 1);
  };
  await refreshNextSource(0);

  signal.throwIfAborted();
  const freshness = await readSanctionsFreshness({ db });
  for (const source of freshness) {
    if (source.status === "unavailable" || source.annotation !== null) {
      logger.warn("scheduler.sanctions_source_status", {
        "sanctions.source": source.source,
        ...(source.reason !== null && { "sanctions.reason": source.reason }),
        ...(source.annotation !== null && {
          "sanctions.annotation": source.annotation.type,
        }),
        ...(source.heldUpdate !== null && {
          "sanctions.held_code": source.heldUpdate.code,
        }),
      });
    }
  }
};
