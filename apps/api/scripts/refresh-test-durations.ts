import { panic } from "better-result";
import { readFileSync, writeFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";

/** Parse Bun's default reporter, including timestamped GitHub job logs. */
export const readTestDurations = (log: string) => {
  const files: Record<string, number> = {};
  const tests: { file: string; test: string; seconds: number }[] = [];
  let file: string | undefined;
  for (const raw of log.split("\n")) {
    const line = stripVTControlCharacters(raw);
    const header =
      /(?:^|Z |##\[group\])(?<file>(?:src|scripts|evals)\/[^\r\n]+\.test\.tsx?):\s*$/u.exec(
        line,
      )?.groups?.["file"];
    if (header !== undefined) {
      file = header;
      files[file] ??= 0;
      continue;
    }
    const timing =
      /\((?:pass|fail)\) (?<test>.+) \[(?<duration>[\d.]+)(?<unit>ms|s)\]/u.exec(
        line,
      )?.groups;
    if (timing === undefined || file === undefined) {
      continue;
    }
    const seconds =
      Number(timing["duration"]) / (timing["unit"] === "ms" ? 1000 : 1);
    files[file] = (files[file] ?? 0) + seconds;
    tests.push({ file, test: timing["test"] ?? "", seconds });
  }
  return {
    files: Object.fromEntries(
      Object.entries(files)
        .toSorted(([a], [b]) => (a < b ? -1 : Number(a > b)))
        .map(([name, seconds]) => [name, Number(seconds.toFixed(6))]),
    ),
    slowestTests: tests.toSorted((a, b) => b.seconds - a.seconds).slice(0, 50),
  };
};

// File weights sum reported test times; loading, external hooks and process
// startup are not measured by Bun's per-test reporter.
if (import.meta.main) {
  const [logPath, outputPath] = process.argv.slice(2);
  if (logPath === undefined || outputPath === undefined) {
    panic(
      "Usage: bun scripts/refresh-test-durations.ts <bun-log> <output.json>",
    );
  }
  const result = readTestDurations(readFileSync(logPath, "utf-8"));
  if (Object.keys(result.files).length === 0) {
    panic("No API test timings found");
  }
  writeFileSync(outputPath, `${JSON.stringify(result.files, null, 2)}\n`);
  console.log(
    `Wrote ${Object.keys(result.files).length} file weights to ${outputPath}`,
  );
}
