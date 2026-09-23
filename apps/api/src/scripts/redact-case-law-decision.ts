import { panic, Result } from "better-result";

/**
 * GDPR redaction / takedown for a single case-law decision: strips
 * personal text from corpus index, the pg-fts index, object storage, and the
 * Postgres columns. The decision row (citation-graph node) is kept.
 *
 *   bun run src/scripts/redact-case-law-decision.ts <decisionId>
 */
import { redactCaseLawDecisionWithSupplementHolders } from "@/api/handlers/case-law/ingestion/supplement-erasure";
// eslint-disable-next-line no-restricted-imports -- CLI boundary: brands the decision id parsed from argv
import { toSafeId } from "@/api/lib/branded-types";
import { enterCaseLawMaintenanceLane } from "@/api/lib/case-law/maintenance-lane";
import { refreshCorpusS3, refreshS3 } from "@/api/lib/s3";

// Hold the maintenance lane before the first statement: operator passes over
// the case-law tables serialize here instead of deadlocking on row locks.
const { ingestionDb } = await enterCaseLawMaintenanceLane();

const decisionIdArg = process.argv[2];
if (decisionIdArg === undefined || decisionIdArg.length === 0) {
  console.error(
    "Usage: bun run src/scripts/redact-case-law-decision.ts <decisionId>",
  );
  process.exit(1);
}

await refreshS3();
await refreshCorpusS3();

const redaction = await redactCaseLawDecisionWithSupplementHolders({
  decisionId: toSafeId<"caseLawDecision">(decisionIdArg),
  scopedDb: ingestionDb,
});

/**
 * The decisions that also held the erased text, as supplements composed
 * into them: rebuilt without it, or withheld until the repair lane or a
 * rerun rebuilds them.
 */
const holderReport = (): { exitCode: 0 | 1; lines: string[] } => {
  if (Result.isError(redaction)) {
    return { exitCode: 0, lines: [] };
  }
  const lines = redaction.value.holders.map((holder) => {
    switch (holder.type) {
      case "recomposed":
        return `Rebuilt decision ${holder.judgmentId} without the erased supplement.`;
      case "withheld":
        return `Withheld decision ${holder.judgmentId} until it is rebuilt without the erased supplement (${holder.reason}); the repair lane or a rerun rebuilds it.`;
      case "withhold-incomplete":
        return `Decision ${holder.judgmentId} still holds the erased supplement in a corpus object; run this again.`;
      default: {
        holder satisfies never;
        return panic(`Unhandled holder outcome: ${String(holder)}`);
      }
    }
  });
  return {
    exitCode: redaction.value.holders.some(
      (holder) => holder.type === "withhold-incomplete",
    )
      ? 1
      : 0,
    lines,
  };
};

const report = ((): { exitCode: 0 | 1; message: string } => {
  if (Result.isError(redaction)) {
    // The fence failed, so nothing was written and nothing was erased.
    return {
      exitCode: 1,
      message: `Decision ${decisionIdArg} was not redacted; run it again: ${redaction.error.message}`,
    };
  }
  const outcome = redaction.value.redaction;
  switch (outcome.type) {
    case "redacted": {
      const corpus =
        outcome.erasure === "tombstoned"
          ? `Redacted decision ${decisionIdArg} across all stores; its payloads were members of a shared pack, so their addresses are tombstoned and served to nobody until the pack is rewritten.`
          : `Redacted decision ${decisionIdArg} across all stores.`;
      return {
        exitCode: 0,
        message:
          outcome.legacyRaw === "pending"
            ? `${corpus} Its source still holds raw objects of the earlier source-wide layout, which may include this decision's; they are deleted by the source's legacy sweep (case-law-raw-layout sweep-legacy), and the raw sweep entry stays open until then.`
            : corpus,
      };
    }
    case "not-found":
      return { exitCode: 1, message: `Decision ${decisionIdArg} not found.` };
    case "corpus-objects-remain": {
      const cause =
        outcome.error instanceof Error
          ? outcome.error.message
          : String(outcome.error);
      return {
        exitCode: 1,
        message: `Redacted decision ${decisionIdArg}, but corpus objects remain; pointer columns are kept for a retry: ${cause}`,
      };
    }
    default: {
      outcome satisfies never;
      return panic(`Unhandled redaction outcome: ${String(outcome)}`);
    }
  }
})();

const holders = holderReport();
const exitCode = report.exitCode === 0 ? holders.exitCode : report.exitCode;
const message = [report.message, ...holders.lines].join("\n");
if (exitCode === 0) {
  console.log(message);
} else {
  console.error(message);
}
process.exit(exitCode);
