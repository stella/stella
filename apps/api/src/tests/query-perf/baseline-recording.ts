import { panic } from "better-result";
import { appendFile, writeFile } from "node:fs/promises";

import { parseQueryPerfBaselineFile } from "./baseline";

type CompleteQueryPerfRunOptions = {
  mode: "compare" | "record";
  baseline: ReturnType<typeof parseQueryPerfBaselineFile> | null;
  recorded: ReturnType<typeof parseQueryPerfBaselineFile>["entries"];
  seedId: string;
  settingsDigest: string;
  baselinePath: string | URL;
  outputPath: string | undefined;
};

export const completeQueryPerfRun = async ({
  mode,
  baseline,
  recorded,
  seedId,
  settingsDigest,
  baselinePath,
  outputPath,
}: CompleteQueryPerfRunOptions) => {
  const missing = Object.keys(recorded).filter(
    (id) => baseline?.entries[id] === undefined,
  );
  if (mode === "compare" && missing.length === 0) {
    return;
  }
  const recording = parseQueryPerfBaselineFile({
    seedId,
    settingsDigest,
    entries:
      mode === "record" ? recorded : { ...recorded, ...baseline?.entries },
  });
  await writeFile(baselinePath, `${JSON.stringify(recording, null, 2)}\n`);
  if (outputPath !== undefined) {
    await appendFile(outputPath, "baseline_recorded=true\n");
  }
  if (mode === "compare") {
    return panic(
      `Missing query performance baselines: ${missing.join(", ")}. Commit the validated query-perf-baseline-record artifact, then rerun comparison.`,
    );
  }
};
