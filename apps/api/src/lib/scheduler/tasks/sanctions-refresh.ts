import { panic, Result } from "better-result";

import type { SanctionsSource } from "@stll/sanctions";

import { envBase } from "@/api/env-base";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { getCaseLawIngestionDb } from "@/api/lib/case-law-ingestion-db";
import { readSanctionsFreshness } from "@/api/lib/lists/sanctions/freshness";
import {
  recordUnexpectedSanctionsFailure,
  refreshSanctionsSource,
} from "@/api/lib/lists/sanctions/refresh";
import { sharedSanctionsIndexCache } from "@/api/lib/lists/sanctions/screening-index";
import { sanctionsSourceIds } from "@/api/lib/lists/sanctions/source-config";
import type { SchedulerTask } from "@/api/lib/scheduler/types";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

export const REFRESH_SANCTIONS_SOURCES_TASK =
  "sanctions.refreshSources" as const;

export const refreshSanctionsSourcesTask: SchedulerTask = async ({
  db: schedulerDb,
  logger,
  runId,
  signal,
}) => {
  const db = getCaseLawIngestionDb();
  const sources = sanctionsSourceIds();
  const activated = new Set<SanctionsSource>();
  const counts = {
    activated: 0,
    activatedEntries: 0,
    unchanged: 0,
    held: 0,
    failed: 0,
  };
  const permit = grantThirdPartyOutboundPermit();
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
          permit,
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
      } else {
        counts.failed += 1;
      }
      await refreshNextSource(index + 1);
      return;
    }
    const outcome = attempt.value;
    switch (outcome.status) {
      case "activated":
        activated.add(source);
        counts.activated += 1;
        counts.activatedEntries += outcome.entryCount;
        break;
      case "unchanged":
        counts.unchanged += 1;
        break;
      case "held":
        counts.held += 1;
        break;
      case "failed":
        counts.failed += 1;
        break;
      case "lost-race":
      case "aborted":
        break;
      default:
        outcome satisfies never;
        panic(`Unhandled sanctions outcome: ${String(outcome)}`);
    }
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
  await recordSystemAudit(schedulerDb, "system:sanctions-refresh", {
    subject: runId,
    counts,
  });

  signal.throwIfAborted();
  const freshness = await readSanctionsFreshness({ db });
  // Scheduled jobs run inside the API process, so a list this process already
  // screens against gets the new edition's index here rather than on the next
  // check's request path. Other replicas build theirs on their next check.
  // One index at a time bounds the memory held while building.
  const prepareNextIndex = async (index: number): Promise<void> => {
    const source = freshness.at(index);
    if (source === undefined) {
      return;
    }
    if (activated.has(source.source) && source.edition !== null) {
      signal.throwIfAborted();
      await sharedSanctionsIndexCache.refresh({
        db,
        source: source.source,
        edition: source.edition,
      });
    }
    await prepareNextIndex(index + 1);
  };
  await prepareNextIndex(0);
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
