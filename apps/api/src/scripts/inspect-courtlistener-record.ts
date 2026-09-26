/**
 * Plan CourtListener records offline and report what each would become.
 *
 * Reads newline-delimited `CourtListenerRecordV1` JSON (optionally gzipped),
 * admits and plans each record, reads its stored raw back through the field
 * inventory and the decoder, and prints one JSON line per record followed by
 * a summary. It writes nothing: no database, no object store, no network.
 * Text is not parsed here, so every classification that needs the principal
 * text reports it as unavailable.
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
import { classifyCourtListenerDecision } from "@/api/handlers/case-law/ingestion/adapters/courtlistener/order-classification";
import {
  type CourtListenerDecisionPlan,
  planCourtListenerRecord,
} from "@/api/handlers/case-law/ingestion/adapters/courtlistener/plan";
import {
  courtListenerRawHash,
  decodeCourtListenerRaw,
} from "@/api/handlers/case-law/ingestion/adapters/courtlistener/raw";
import { admitCourtListenerRecord } from "@/api/handlers/case-law/ingestion/adapters/courtlistener/record";
import { decodeSourceRawEnvelope } from "@/api/lib/legal-search/ingestion-types";

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
  const readmitted = Result.isError(decoded)
    ? decoded
    : admitCourtListenerRecord(decoded.value);
  const rawHashStable =
    Result.isOk(readmitted) &&
    courtListenerRawHash(readmitted.value.record) === plan.rawHash;
  return { undeclaredFields, missingParts, rawHashStable };
};

const inspect = (line: string) => {
  const parsed = Result.try({
    try: (): unknown => JSON.parse(line),
    catch: () => null,
  });
  if (Result.isError(parsed)) {
    return { outcome: "unreadable-line" as const };
  }
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
    };
  }
  const plan = planned.value;
  const classification = classifyCourtListenerDecision({
    opinionTypes: plan.opinions.map(({ type }) => type),
    scdbPresent: plan.scdbPresent,
    principal: { status: "unavailable" },
  });
  return {
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
    classification: classification.kind,
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
const classifications = new Map<string, number>();
const diagnosticCodes = new Map<string, number>();
const undeclared = new Set<string>();
let unstableRaw = 0;
let read = 0;

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
  if (report.outcome === "rejected") {
    increment(rejections, report.reason);
  }
  if (report.outcome === "planned") {
    increment(classifications, report.classification);
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
      classifications: Object.fromEntries(classifications),
      diagnostics: Object.fromEntries(diagnosticCodes),
      undeclaredFields: [...undeclared],
      unstableRaw,
    },
  }),
);
if (undeclared.size > 0 || unstableRaw > 0) {
  process.exit(1);
}
