import { Result, TaggedError } from "better-result";
import path from "node:path";

import { parseNativeImageProbeReport } from "@stll/ai-catalog";
import type {
  NativeImageProbeRecord,
  NativeImageProbeReport,
} from "@stll/ai-catalog";

const OUTPUT_PATH = path.resolve(
  import.meta.dir,
  "../../ai-catalog/src/native-image-probes.json",
);

export class NativeImageProbeImportError extends TaggedError(
  "NativeImageProbeImportError",
)<{
  message: string;
}> {}

const probeKey = ({
  provider,
  modelId,
  mimeType,
}: NativeImageProbeRecord): string =>
  JSON.stringify([provider, modelId, mimeType]);

const uniqueRecords = (
  report: NativeImageProbeReport,
): Map<string, NativeImageProbeRecord> => {
  const records = new Map<string, NativeImageProbeRecord>();
  for (const record of report.records) {
    const key = probeKey(record);
    if (records.has(key)) {
      throw new NativeImageProbeImportError({
        message: `Duplicate native image probe: ${key}`,
      });
    }
    records.set(key, record);
  }
  return records;
};

type MergeNativeImageProbeReportsOptions = {
  current: unknown;
  incoming: unknown;
};

export const mergeNativeImageProbeReports = ({
  current,
  incoming,
}: MergeNativeImageProbeReportsOptions): NativeImageProbeReport => {
  const records = uniqueRecords(parseNativeImageProbeReport(current));
  const imported = uniqueRecords(parseNativeImageProbeReport(incoming));
  for (const [key, record] of imported) {
    const previous = records.get(key);
    if (previous) {
      const previousTime = Date.parse(previous.checkedAt);
      const incomingTime = Date.parse(record.checkedAt);
      if (incomingTime < previousTime) {
        throw new NativeImageProbeImportError({
          message: `Stale native image probe: ${key}`,
        });
      }
      if (
        incomingTime === previousTime &&
        JSON.stringify(previous) !== JSON.stringify(record)
      ) {
        throw new NativeImageProbeImportError({
          message: `Conflicting native image probe: ${key}`,
        });
      }
    }
    records.set(key, record);
  }
  return {
    probeVersion: 1,
    records: [...records.entries()]
      .sort(([left], [right]) => {
        if (left === right) {
          return 0;
        }
        return left < right ? -1 : 1;
      })
      .map(([, record]) => record),
  };
};

type NativeImageSupportChangedOptions = {
  current: NativeImageProbeReport;
  incoming: NativeImageProbeReport;
};

export const hasNativeImageSupportChanged = ({
  current,
  incoming,
}: NativeImageSupportChangedOptions): boolean => {
  const currentSupport = new Set(
    current.records
      .filter(({ status }) => status === "supported")
      .map(probeKey),
  );
  const incomingSupport = new Set(
    incoming.records
      .filter(({ status }) => status === "supported")
      .map(probeKey),
  );
  return (
    currentSupport.size !== incomingSupport.size ||
    [...currentSupport].some((key) => !incomingSupport.has(key))
  );
};

const run = async (): Promise<void> => {
  const args = Bun.argv.slice(2);
  const check = args.includes("--check");
  const inputPaths = args.filter((arg) => arg !== "--check");
  if (inputPaths.length === 0 && !check) {
    throw new NativeImageProbeImportError({
      message:
        "Pass one or more canary report paths, or --check to validate the snapshot.",
    });
  }
  const original = await Bun.file(OUTPUT_PATH).text();
  let report = mergeNativeImageProbeReports({
    current: JSON.parse(original),
    incoming: { probeVersion: 1, records: [] },
  });
  const current = report;
  for (const inputPath of inputPaths) {
    report = mergeNativeImageProbeReports({
      current: report,
      incoming: await Bun.file(inputPath).json(),
    });
  }
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (check) {
    const changed =
      inputPaths.length > 0
        ? hasNativeImageSupportChanged({ current, incoming: report })
        : original !== output;
    if (changed) {
      throw new NativeImageProbeImportError({
        message:
          "Native image support changed; import the canary reports and commit the result.",
      });
    }
    return;
  }
  await Bun.write(OUTPUT_PATH, output);
};

if (import.meta.main) {
  const result = await Result.tryPromise(run);
  if (Result.isError(result)) {
    console.error(result.error);
    process.exitCode = 1;
  }
}
