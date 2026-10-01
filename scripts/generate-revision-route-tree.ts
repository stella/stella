import { panic } from "better-result";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { generateRouteTree } from "../apps/web/scripts/generate-route-tree";

const run = (command: string[]) => {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    panic(result.stderr.toString());
  }
  return result.stdout.toString().trim();
};

type GenerateRevisionRouteTreeOptions = { revision: string; output: string };
const generateRevisionRouteTree = async ({
  revision,
  output,
}: GenerateRevisionRouteTreeOptions) => {
  const commit = run([
    "git",
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${revision}^{commit}`,
  ]);
  const routes = "apps/web/src/routes";
  const entries = run(["git", "ls-tree", "-r", "-z", commit, "--", routes]);
  for (const entry of entries.split("\0").filter(Boolean)) {
    const separator = entry.indexOf("\t");
    const metadata = entry.slice(0, separator);
    const filename = entry.slice(separator + 1);
    // The router loads __virtual modules, and follows symlinks. Privileged
    // delivery must only parse regular route sources, never execute PR code.
    if (
      separator === -1 ||
      !/^100(?:644|755) blob /u.test(metadata) ||
      /__virtual\.[mc]?[jt]s$/u.test(filename)
    ) {
      panic("Revision route generation requires regular physical route files");
    }
  }
  const temporary = mkdtempSync(path.join(tmpdir(), "stella-revision-routes-"));
  try {
    const archive = path.join(temporary, "routes.tar");
    run([
      "git",
      "archive",
      "--format=tar",
      `--output=${archive}`,
      commit,
      "--",
      routes,
    ]);
    run(["tar", "-xf", archive, "-C", temporary]);
    // Only route sources are archived: revision-owned config and scripts cannot
    // redirect or customize the trusted generator.
    await generateRouteTree({
      webRoot: path.join(temporary, "apps/web"),
      mode: "write",
    });
    copyFileSync(path.join(temporary, "apps/web/src/routeTree.gen.ts"), output);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  const [revision, output, ...extra] = process.argv.slice(2);
  if (revision === undefined || output === undefined || extra.length > 0) {
    panic("Usage: bun scripts/generate-revision-route-tree.ts REVISION OUTPUT");
  }
  await generateRevisionRouteTree({ revision, output });
}
