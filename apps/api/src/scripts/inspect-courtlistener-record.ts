/**
 * Plan CourtListener records offline and report what each would become.
 *
 * Reads newline-delimited `CourtListenerRecordV1` JSON (optionally gzipped),
 * admits and plans each record, reads its stored raw back through the field
 * inventory and the decoder, and prints one JSON line per record followed by
 * a summary. It writes nothing: no database, no object store, no network.
 *
 * Each record's opinion rows also go through the text parsers, even where
 * another table's drift rejects the record: which column each opinion's text
 * came from, why the others were refused, what was held, and the order or
 * opinion class the parsed principal text gives. A parsed text is not a
 * write-ready decision; the complete mapper decides that.
 *
 *   bun run src/scripts/inspect-courtlistener-record.ts <records.ndjson[.gz]> \
 *     [--limit <n>] [--summary-only]
 */

import { Result } from "better-result";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";

import {
  COURTLISTENER_SOURCE_FIELD_INVENTORY,
  COURTLISTENER_SOURCE_SURFACES,
} from "@/api/handlers/case-law/ingestion/adapters/courtlistener/inventory";
import {
  type CourtListenerDecisionPlan,
  planCourtListenerRecord,
} from "@/api/handlers/case-law/ingestion/adapters/courtlistener/plan";
import {
  courtListenerRawHash,
  decodeCourtListenerRaw,
} from "@/api/handlers/case-law/ingestion/adapters/courtlistener/raw";
import { admitCourtListenerRecord } from "@/api/handlers/case-law/ingestion/adapters/courtlistener/record";
import {
  isCsvRow,
  OPINION_COLUMNS,
} from "@/api/handlers/case-law/ingestion/adapters/courtlistener/snapshot-columns";
import { isOpinionType } from "@/api/handlers/case-law/ingestion/adapters/courtlistener/vocabulary";
import {
  composeCourtListenerText,
  type CourtListenerTextOpinion,
} from "@/api/handlers/case-law/ingestion/parsers/courtlistener/compose";
import { decodeSourceRawEnvelope } from "@/api/lib/legal-search/ingestion-types";
import { isRecord } from "@/api/lib/type-guards";

const isOpinionRow = isCsvRow(OPINION_COLUMNS);

const USAGE =
  "Usage: bun run src/scripts/inspect-courtlistener-record.ts <records.ndjson[.gz]> [--limit <n>] [--summary-only]";

const args = Bun.argv.slice(2);
const path = args.find((arg) => !arg.startsWith("--"));
const limitIndex = args.indexOf("--limit");
const limit =
  limitIndex === -1 ? Number.POSITIVE_INFINITY : Number(args[limitIndex + 1]);
const summaryOnly = args.includes("--summary-only");

if (path === undefined || !(limit > 0)) {
  console.error(USAGE);
  process.exit(2);
}

/** Reading the stored raw back must reproduce the record it was written from. */
const rawReadBack = (plan: CourtListenerDecisionPlan) => {
  const parts = decodeSourceRawEnvelope(plan.sourceRaw) ?? {};
  const undeclaredFields =
    COURTLISTENER_SOURCE_FIELD_INVENTORY.listSourceFields(parts).filter(
      (field) =>
        COURTLISTENER_SOURCE_FIELD_INVENTORY.fields[field] === undefined,
    );
  const missingParts = Object.values(
    COURTLISTENER_SOURCE_SURFACES.surfaces,
  ).flatMap((surface) =>
    surface.disposition === "stored" && parts[surface.part] === undefined
      ? [surface.part]
      : [],
  );
  const decoded = decodeCourtListenerRaw({
    raw: plan.sourceRaw,
    contentType: plan.sourceRawContentType,
  });
  let rawHashStable = false;
  if (Result.isOk(decoded)) {
    const readmitted = admitCourtListenerRecord(decoded.value);
    rawHashStable =
      Result.isOk(readmitted) &&
      courtListenerRawHash(readmitted.value.record) === plan.rawHash;
  }
  return { undeclaredFields, missingParts, rawHashStable };
};

/**
 * The record's opinion rows, where every one has the pinned columns and a
 * declared type. Text is parsed from these alone, so a record the contract
 * rejects for another table's drift still reports what its text would be.
 */
const textOpinionsOf = (input: unknown): CourtListenerTextOpinion[] | null => {
  if (!isRecord(input) || !Array.isArray(input["opinions"])) {
    return null;
  }
  const opinions: CourtListenerTextOpinion[] = [];
  for (const row of input["opinions"]) {
    if (!isOpinionRow(row) || !isOpinionType(row.type)) {
      return null;
    }
    opinions.push({ row, type: row.type });
  }
  return opinions.length > 0 ? opinions : null;
};

/** What the text parsers make of the record, with no source text in it. */
const inspectText = (input: unknown) => {
  const opinions = textOpinionsOf(input);
  if (opinions === null) {
    return null;
  }
  const outcome = composeCourtListenerText(opinions);
  return {
    report: {
      status: outcome.status,
      reason: outcome.status === "held" ? outcome.reason : null,
      blocks: outcome.status === "parsed" ? outcome.blocks.length : null,
      scopes:
        outcome.status === "parsed" ? outcome.citationScopes.length : null,
      opinions: outcome.opinions.map(
        ({
          attempts,
          classConflicts,
          counts,
          coverage,
          format,
          opinionId,
          scopes,
          selection,
          structure,
          type,
        }) => ({
          opinionId,
          type,
          selection,
          format,
          structure,
          coverage,
          scopes,
          classConflicts,
          counts,
          attempts: attempts.map(
            (attempt) =>
              `${attempt.format}/${attempt.structure}:${attempt.reason}`,
          ),
        }),
      ),
      structure:
        outcome.status === "parsed"
          ? {
              principalLength: outcome.principal.length,
              bodyParagraphCount: outcome.principal.bodyParagraphCount,
              inBodyCitationCount: outcome.principal.inBodyCitationCount,
            }
          : null,
    },
  };
};

const inspect = (line: string) => {
  const parsed = Result.try({
    try: (): unknown => JSON.parse(line),
    catch: () => null,
  });
  if (Result.isError(parsed)) {
    return { outcome: "unreadable-line" as const };
  }
  const text = inspectText(parsed.value);
  const planned = planCourtListenerRecord(parsed.value);
  if (Result.isError(planned)) {
    const { clusterId, diagnostics, omittedDiagnostics, reason } =
      planned.error;
    return {
      outcome: "rejected" as const,
      clusterId,
      reason,
      diagnostics,
      omittedDiagnostics,
      text: text?.report ?? null,
    };
  }
  const plan = planned.value;
  return {
    text: text?.report ?? null,
    outcome: "planned" as const,
    clusterId: plan.sourceDocumentId,
    courtId: plan.courtId,
    caseNumber: plan.caseNumber,
    caseNumberType: plan.caseNumberType,
    identifiers: plan.identifiers.length,
    decisionDate: plan.decisionDate ?? null,
    judges: plan.judges?.length ?? null,
    opinions: plan.opinions.map(
      ({ opinionId, type }) => `${opinionId}:${type}`,
    ),
    decisionType: { status: "not-stated" },
    diagnostics: plan.diagnostics.map(({ code }) => code),
    ...rawReadBack(plan),
  };
};

const increment = (counts: Map<string, number>, key: string) => {
  counts.set(key, (counts.get(key) ?? 0) + 1);
};

const input = createReadStream(path);
const lines = createInterface({
  input: path.endsWith(".gz") ? input.pipe(createGunzip()) : input,
  crlfDelay: Number.POSITIVE_INFINITY,
});

const outcomes = new Map<string, number>();
const rejections = new Map<string, number>();
const diagnosticCodes = new Map<string, number>();
const undeclared = new Set<string>();
const textCounts = {
  clusters: new Map<string, number>(),
  heldReasons: new Map<string, number>(),
  chosenFormats: new Map<string, number>(),
  opinionOutcomes: new Map<string, number>(),
  unusable: new Map<string, number>(),
  requiresAssets: new Map<string, number>(),
  coverage: new Map<string, number>(),
  unknownConstructs: new Map<string, number>(),
};
let unstableRaw = 0;
let read = 0;

const countText = (
  report: NonNullable<ReturnType<typeof inspectText>>["report"],
) => {
  increment(textCounts.clusters, report.status);
  if (report.reason !== null) {
    increment(textCounts.heldReasons, report.reason);
  }
  for (const opinion of report.opinions) {
    increment(textCounts.opinionOutcomes, opinion.selection);
    for (const attempt of opinion.attempts) {
      increment(textCounts.unusable, attempt);
    }
    const chosen = `${opinion.format ?? "none"}/${opinion.structure ?? "-"}`;
    if (opinion.selection === "parsed") {
      increment(textCounts.chosenFormats, chosen);
      // A row parsed in a held cluster is scoped by nobody.
      increment(
        textCounts.coverage,
        opinion.coverage ?? `cluster-${report.status}`,
      );
    } else if (opinion.selection === "requires-assets") {
      increment(textCounts.requiresAssets, chosen);
    }
    for (const [name, count] of Object.entries(
      opinion.counts?.unknownConstructs ?? {},
    )) {
      textCounts.unknownConstructs.set(
        name,
        (textCounts.unknownConstructs.get(name) ?? 0) + count,
      );
    }
  }
};

for await (const line of lines) {
  if (line.trim() === "") {
    continue;
  }
  if (read >= limit) {
    break;
  }
  read += 1;
  const report = inspect(line);
  increment(outcomes, report.outcome);
  if (report.outcome !== "unreadable-line" && report.text !== null) {
    countText(report.text);
  }
  if (report.outcome === "rejected") {
    increment(rejections, report.reason);
  }
  if (report.outcome === "planned") {
    for (const code of report.diagnostics) {
      increment(diagnosticCodes, code);
    }
    for (const field of [...report.undeclaredFields, ...report.missingParts]) {
      undeclared.add(field);
    }
    unstableRaw += report.rawHashStable ? 0 : 1;
  }
  if (!summaryOnly) {
    console.log(JSON.stringify(report));
  }
}

console.log(
  JSON.stringify({
    summary: {
      records: read,
      outcomes: Object.fromEntries(outcomes),
      rejections: Object.fromEntries(rejections),
      diagnostics: Object.fromEntries(diagnosticCodes),
      undeclaredFields: [...undeclared],
      unstableRaw,
      text: Object.fromEntries(
        Object.entries(textCounts).map(([key, counts]) => [
          key,
          Object.fromEntries(counts),
        ]),
      ),
    },
  }),
);
if (undeclared.size > 0 || unstableRaw > 0) {
  process.exit(1);
}
