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
  cause?: unknown;
}> {}

const probeKey = ({
  provider,
  modelId,
  mimeType,
}: NativeImageProbeRecord): string =>
  JSON.stringify([provider, modelId, mimeType]);

const uniqueRecords = (
  report: NativeImageProbeReport,
): Result<Map<string, NativeImageProbeRecord>, NativeImageProbeImportError> => {
  const records = new Map<string, NativeImageProbeRecord>();
  for (const record of report.records) {
    const key = probeKey(record);
    if (records.has(key)) {
      return Result.err(
        new NativeImageProbeImportError({
          message: `Duplicate native image probe: ${key}`,
        }),
      );
    }
    records.set(key, record);
  }
  return Result.ok(records);
};

const parseReport = (
  input: unknown,
): Result<NativeImageProbeReport, NativeImageProbeImportError> =>
  Result.try({
    try: () => parseNativeImageProbeReport(input),
    catch: (cause) =>
      new NativeImageProbeImportError({
        message: "Invalid native image probe report",
        cause,
      }),
  });

type MergeNativeImageProbeReportsOptions = {
  current: unknown;
  incoming: unknown;
};

export const mergeNativeImageProbeReports = ({
  current,
  incoming,
}: MergeNativeImageProbeReportsOptions): Result<
  NativeImageProbeReport,
  NativeImageProbeImportError
> =>
  Result.gen(function* () {
    const records = yield* uniqueRecords(yield* parseReport(current));
    const imported = yield* uniqueRecords(yield* parseReport(incoming));
    for (const [key, record] of imported) {
      const previous = records.get(key);
      if (previous) {
        const previousTime = Date.parse(previous.checkedAt);
        const incomingTime = Date.parse(record.checkedAt);
        if (incomingTime < previousTime) {
          return Result.err(
            new NativeImageProbeImportError({
              message: `Stale native image probe: ${key}`,
            }),
          );
        }
        if (
          incomingTime === previousTime &&
          JSON.stringify(previous) !== JSON.stringify(record)
        ) {
          return Result.err(
            new NativeImageProbeImportError({
              message: `Conflicting native image probe: ${key}`,
            }),
          );
        }
      }
      records.set(key, record);
    }
    return Result.ok({
      probeVersion: 1 as const,
      records: [...records.entries()]
        .sort(([left], [right]) => {
          if (left === right) {
            return 0;
          }
          return left < right ? -1 : 1;
        })
        .map(([, record]) => record),
    });
  });

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

const readJsonFile = async (
  filePath: string,
): Promise<Result<unknown, NativeImageProbeImportError>> =>
  await Result.tryPromise({
    try: async () => await Bun.file(filePath).json(),
    catch: (cause) =>
      new NativeImageProbeImportError({
        message: `Failed to read native image probe report: ${filePath}`,
        cause,
      }),
  });

const readTextFile = async (
  filePath: string,
): Promise<Result<string, NativeImageProbeImportError>> =>
  await Result.tryPromise({
    try: async () => await Bun.file(filePath).text(),
    catch: (cause) =>
      new NativeImageProbeImportError({
        message: `Failed to read native image probe report: ${filePath}`,
        cause,
      }),
  });

const run = async (): Promise<Result<void, NativeImageProbeImportError>> =>
  await Result.gen(async function* () {
    const args = Bun.argv.slice(2);
    const check = args.includes("--check");
    const inputPaths = args.filter((arg) => arg !== "--check");
    if (inputPaths.length === 0 && !check) {
      return Result.err(
        new NativeImageProbeImportError({
          message:
            "Pass one or more canary report paths, or --check to validate the snapshot.",
        }),
      );
    }
    const originalText = yield* Result.await(readTextFile(OUTPUT_PATH));
    const originalJson = yield* Result.try({
      try: () => JSON.parse(originalText),
      catch: (cause) =>
        new NativeImageProbeImportError({
          message: `Invalid native image probe report: ${OUTPUT_PATH}`,
          cause,
        }),
    });
    let report = yield* mergeNativeImageProbeReports({
      current: originalJson,
      incoming: { probeVersion: 1, records: [] },
    });
    const current = report;
    for (const inputPath of inputPaths) {
      const incoming = yield* Result.await(readJsonFile(inputPath));
      report = yield* mergeNativeImageProbeReports({
        current: report,
        incoming,
      });
    }
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (check) {
      const changed =
        inputPaths.length > 0
          ? hasNativeImageSupportChanged({ current, incoming: report })
          : originalText !== output;
      if (changed) {
        return Result.err(
          new NativeImageProbeImportError({
            message:
              "Native image support changed; import the canary reports and commit the result.",
          }),
        );
      }
      return Result.ok(undefined);
    }
    yield* Result.await(
      Result.tryPromise({
        try: async () => {
          await Bun.write(OUTPUT_PATH, output);
        },
        catch: (cause) =>
          new NativeImageProbeImportError({
            message: `Failed to write native image probe snapshot: ${OUTPUT_PATH}`,
            cause,
          }),
      }),
    );
    return Result.ok(undefined);
  });

if (import.meta.main) {
  const result = await run();
  if (Result.isError(result)) {
    console.error(result.error);
    process.exitCode = 1;
  }
}
