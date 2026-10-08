import { panic } from "better-result";
import { createOptions } from "knip/session";
import path from "node:path";

import { ProjectPrincipal } from "../node_modules/knip/dist/ProjectPrincipal.js";
import { run } from "../node_modules/knip/dist/run.js";
import { ISSUE_TYPES } from "./knip-exports-ratchet";

export const analyzeExports = async (cwd: string) => {
  const options = await createOptions({
    cwd,
    isShowProgress: false,
    args: { include: [...ISSUE_TYPES] },
  });
  // Knip 6.39 exposes only a repository-wide processed count. Its graph also
  // contains reference-only nodes, so counting graph or disk paths overstates
  // coverage. Observe actual source-analysis calls in this dedicated child,
  // then reconcile with Knip's counter so API drift fails explicitly. This
  // costs one Set insertion per file and keeps the existing single Knip run.
  const analyzedPaths = new Set<string>();
  const analyzeSourceFile = ProjectPrincipal.prototype.analyzeSourceFile;
  ProjectPrincipal.prototype.analyzeSourceFile = function (
    this: ProjectPrincipal,
    ...args: Parameters<typeof analyzeSourceFile>
  ) {
    const result = analyzeSourceFile.call(this, ...args);
    analyzedPaths.add(args[0]);
    return result;
  };
  const analysis = async () => {
    try {
      return await run(options);
    } finally {
      ProjectPrincipal.prototype.analyzeSourceFile = analyzeSourceFile;
    }
  };
  const { results } = await analysis();
  if (results.hasConfigLoadErrors) {
    panic("knip configuration did not load completely");
  }
  if (analyzedPaths.size !== results.counters.processed) {
    panic(
      `knip analysis counts disagree: ${analyzedPaths.size} observed, ${results.counters.processed} reported`,
    );
  }
  type IssueRow = {
    file: string;
    exports: { name: string }[];
    types: { name: string }[];
    nsExports: { name: string }[];
  };
  const rows = new Map<string, IssueRow>();
  for (const type of ISSUE_TYPES) {
    for (const symbols of Object.values(results.issues[type])) {
      for (const issue of Object.values(symbols)) {
        const file = path.relative(cwd, issue.filePath);
        const row = rows.get(file) ?? {
          file,
          exports: [],
          types: [],
          nsExports: [],
        };
        row[type].push({ name: issue.symbol });
        rows.set(file, row);
      }
    }
  }
  return {
    analyzedFiles: [...analyzedPaths].map((file) => path.relative(cwd, file)),
    issues: [...rows.values()],
  };
};

if (import.meta.main) {
  // Complete the JSON write before exiting, including when stdout is a pipe.
  await Bun.write(
    Bun.stdout,
    `${JSON.stringify(await analyzeExports(path.resolve(import.meta.dir, "..")))}\n`,
  );
}
