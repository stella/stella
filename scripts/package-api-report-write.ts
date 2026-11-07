#!/usr/bin/env bun

// Regenerates every published package's API report, laid out as the
// repository formatter lays out JSON. The check (package-api-report.ts) runs
// under the offline network preload, so the formatter is reached only here.
import { writeFileSync } from "node:fs";
import path from "node:path";

import { formattedArtifactsLikeRepository } from "./generated-artifacts";
import {
  generateApiReport,
  publishedPackageDirs,
  REPORT_FILE,
  ROOT,
} from "./package-api-report";

const reports = await formattedArtifactsLikeRepository(
  publishedPackageDirs().map((relative) => ({
    path: `${relative}/${REPORT_FILE}`,
    contents: JSON.stringify(
      generateApiReport(path.join(ROOT, relative)),
      null,
      2,
    ),
  })),
);
for (const report of reports) {
  writeFileSync(path.join(ROOT, report.path), report.contents);
}
console.log("Published package API reports: regenerated.");
