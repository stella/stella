import { panic } from "better-result";
import path from "node:path";

const REPORTER_OUTFILE = "--reporter-outfile";
const ROOT_TOTALS = ["tests", "failures", "errors", "skipped", "time"] as const;

type BatchReporterPlan =
  | { type: "stdout"; argumentsByBatch: string[][] }
  | {
      type: "file";
      argumentsByBatch: string[][];
      batchOutfiles: string[];
      requestedOutfile: string;
    };

const reporterOutfileIndex = (arguments_: readonly string[]): number =>
  arguments_.findIndex(
    (argument) =>
      argument === REPORTER_OUTFILE ||
      argument.startsWith(`${REPORTER_OUTFILE}=`),
  );

export const planBatchReporterArguments = (
  arguments_: readonly string[],
  batchCount: number,
  temporaryDirectory: string,
): BatchReporterPlan => {
  const outfileIndex = reporterOutfileIndex(arguments_);
  if (outfileIndex === -1) {
    return {
      type: "stdout",
      argumentsByBatch: Array.from({ length: batchCount }, () => [
        ...arguments_,
      ]),
    };
  }

  const outfileArgument = arguments_.at(outfileIndex);
  if (outfileArgument === undefined) {
    panic("Reporter outfile argument index is invalid.");
  }
  const usesSeparateValue = outfileArgument === REPORTER_OUTFILE;
  const requestedOutfile = usesSeparateValue
    ? arguments_.at(outfileIndex + 1)
    : outfileArgument.slice(REPORTER_OUTFILE.length + 1);
  if (!requestedOutfile) {
    panic("--reporter-outfile requires a path.");
  }

  const batchOutfiles = Array.from({ length: batchCount }, (_, index) =>
    path.join(temporaryDirectory, `batch-${String(index)}.xml`),
  );
  const argumentsByBatch = batchOutfiles.map((batchOutfile) => {
    const rewritten = [...arguments_];
    if (usesSeparateValue) {
      rewritten[outfileIndex + 1] = batchOutfile;
    } else {
      rewritten[outfileIndex] = `${REPORTER_OUTFILE}=${batchOutfile}`;
    }
    return rewritten;
  });
  return {
    type: "file",
    argumentsByBatch,
    batchOutfiles,
    requestedOutfile,
  };
};

const attribute = (tag: string, name: string): string | undefined => {
  const match = new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)')`, "u").exec(tag);
  return match?.at(1) ?? match?.at(2);
};

type ParsedReport = {
  body: string;
  totals: Map<(typeof ROOT_TOTALS)[number], number>;
};

const ROOT_OPENING = /^\s*(?:<\?xml[^>]*\?>\s*)?(<testsuites\b[^>]*>)/u;
const ROOT_CLOSING = "</testsuites>";

// Only the root is read: suite bodies (including CDATA failure output, which
// may contain markup) are copied verbatim, never tokenized.
const parseReport = (xml: string, source: string): ParsedReport => {
  const opening = ROOT_OPENING.exec(xml);
  const tag = opening?.at(1);
  if (opening === null || tag === undefined) {
    panic(`Unparseable JUnit report ${source}: expected a <testsuites> root.`);
  }
  const totals = new Map<(typeof ROOT_TOTALS)[number], number>();
  for (const total of ROOT_TOTALS) {
    const value = attribute(tag, total);
    if (value === undefined) {
      continue;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      panic(`Unparseable JUnit report ${source}: invalid ${total} total.`);
    }
    totals.set(total, parsed);
  }
  const bodyStart = opening.index + opening[0].length;
  if (tag.endsWith("/>")) {
    if (xml.slice(bodyStart).trim() !== "") {
      panic(`Unparseable JUnit report ${source}: content after the root.`);
    }
    return { body: "", totals };
  }
  const trimmed = xml.trimEnd();
  if (!trimmed.endsWith(ROOT_CLOSING)) {
    panic(`Unparseable JUnit report ${source}: incomplete XML document.`);
  }
  return {
    body: trimmed.slice(bodyStart, trimmed.length - ROOT_CLOSING.length).trim(),
    totals,
  };
};

export const mergeJunitReports = (
  reports: readonly { source: string; xml: string }[],
): string => {
  const parsed = reports.map(({ source, xml }) => parseReport(xml, source));
  const attributes = ROOT_TOTALS.flatMap((total) => {
    const values = parsed.flatMap(({ totals }) => {
      const value = totals.get(total);
      return value === undefined ? [] : [value];
    });
    return values.length === 0
      ? []
      : [`${total}="${String(values.reduce((sum, value) => sum + value, 0))}"`];
  });
  const opening =
    attributes.length === 0
      ? "<testsuites>"
      : `<testsuites ${attributes.join(" ")}>`;
  return `${opening}\n${parsed.flatMap(({ body }) => (body === "" ? [] : [body])).join("\n")}\n${ROOT_CLOSING}\n`;
};
