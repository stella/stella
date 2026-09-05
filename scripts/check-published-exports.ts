#!/usr/bin/env bun
// Guard: every subpath a publishable package declares must resolve, ship, and
// load from the published tarball.
//
// The in-repo manifest points `exports` at `./src`, so nothing in ordinary
// development exercises the published shape: a build config that misses an
// entry, an export map naming a file the build never emits, or a `files`
// allowlist that leaves a subpath out of the tarball all stay invisible until
// an install fails. This runs the real publish path — build, prepare-publish,
// `bun pm pack` — and then, with the published manifest in place, resolves
// every subpath the way a consumer's resolver would and imports what it finds
// in plain Node, the runtime an installed consumer most often uses.
//
// usage: bun scripts/check-published-exports.ts <package-dir>

import { panic } from "better-result";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  distEntryFiles,
  isDistModuleEntry,
  toPublishedManifest,
} from "./publish-manifest";
import {
  isExpectedPublishedExportResolution,
  isOwnDistLoadFailure,
  isPublishedTestArtifact,
} from "./published-export-guards";

const repoRoot = path.resolve(import.meta.dir, "..");

const pkgDir = path.resolve(
  process.argv[2] ??
    panic("usage: bun scripts/check-published-exports.ts <package-dir>"),
);
const pkgPath = path.join(pkgDir, "package.json");

const run = async (cmd: string[], cwd: string): Promise<string> => {
  const proc = Bun.spawn({ cmd, cwd, stderr: "inherit", stdout: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) {
    panic(`command failed in ${cwd}: ${cmd.join(" ")}`);
  }
  return stdout;
};

/**
 * Load a built module the way an installed consumer does, in plain Node.
 *
 * Bun's resolver fills in an omitted relative extension, so importing the same
 * file from this script would pass on a `./thing` that Node's ESM resolver
 * rejects outright — the published package would then fail at the consumer's
 * first import. Node decides this, so Node runs the load.
 */
type NodeLoad =
  | { readonly type: "loaded"; readonly exportCount: number }
  | { readonly type: "unresolved"; readonly reason: string }
  | { readonly type: "unreported" };

/** The count travels on its own line so module output cannot be read as one. */
const EXPORT_COUNT_MARKER = "__stella_export_count__:";

const parseExportCount = (stdout: string): number | undefined => {
  const marked = stdout
    .split("\n")
    .flatMap((line) =>
      line.startsWith(EXPORT_COUNT_MARKER)
        ? [Number(line.slice(EXPORT_COUNT_MARKER.length))]
        : [],
    );
  const count = marked.at(0);
  return marked.length === 1 && count !== undefined && Number.isInteger(count)
    ? count
    : undefined;
};

const loadInNode = async (file: string): Promise<NodeLoad> => {
  const proc = Bun.spawn({
    cmd: [
      "node",
      "--input-type=module",
      "-e",
      // The loaded module owns this stdout too — a banner, a deprecation
      // notice, a stray console.log — so the count travels on its own marked
      // line rather than as the whole stream. Report the error, not Node's
      // internal stack: the frames are all node:internal paths and say
      // nothing about which import broke.
      `try {
         const module = await import(${JSON.stringify(pathToFileURL(file).href)});
         process.stdout.write(\`\\n${EXPORT_COUNT_MARKER}\${Object.keys(module).length}\\n\`);
       } catch (error) {
         process.stderr.write(\`\${error.code ?? "Error"}: \${error.message}\`);
         process.exit(1);
       }`,
    ],
    cwd: repoRoot,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    return {
      reason:
        stderr
          .split("\n")
          .find((line) => line.trim().length > 0)
          ?.trim() ?? `node exited ${exitCode}`,
      type: "unresolved",
    };
  }
  const exportCount = parseExportCount(stdout);
  return exportCount === undefined
    ? { type: "unreported" }
    : { exportCount, type: "loaded" };
};

// `bun pm pack --dry-run` lists the tarball contents as "packed <size> <path>",
// one per line, among the build output the pack's own prepack step produces.
// Split on whitespace rather than matching a pattern: the path is everything
// after the size, and a file name may contain spaces.
const packedFiles = (output: string): string[] =>
  output.split("\n").flatMap((line) => {
    const [marker, , ...rest] = line.trim().split(/\s+/u);
    return marker === "packed" && rest.length > 0 ? [rest.join(" ")] : [];
  });

const sourceManifest = await Bun.file(pkgPath).text();
const published = toPublishedManifest(JSON.parse(sourceManifest));

await run([process.execPath, "run", "--bun", "build"], pkgDir);

const failures: string[] = [];
const resolvedBySubpath = new Map<string, string>();
try {
  await run(
    [
      process.execPath,
      path.join(repoRoot, "scripts/prepare-publish.ts"),
      pkgDir,
    ],
    repoRoot,
  );
  const packed = new Set(
    packedFiles(
      await run([process.execPath, "pm", "pack", "--dry-run"], pkgDir),
    ),
  );
  const embeddedDependencyFiles = [...packed].filter((file) =>
    file.startsWith("dist/node_modules/"),
  );
  if (embeddedDependencyFiles.length > 0) {
    failures.push(
      `tarball embeds ${embeddedDependencyFiles.length} dependency file(s) under dist/node_modules; declare the dependency in runtime or peer metadata (first: ${embeddedDependencyFiles.at(0)})`,
    );
  }
  const testArtifacts = [...packed].filter(isPublishedTestArtifact);
  if (testArtifacts.length > 0) {
    failures.push(
      `tarball includes ${testArtifacts.length} test or fixture artifact(s) (first: ${testArtifacts.at(0)})`,
    );
  }

  const bundledTestRuntimes = (
    await Promise.all(
      [...packed]
        .filter((file) => file.startsWith("dist/") && file.endsWith(".js"))
        .map(async (file) => ({
          contents: await Bun.file(path.join(pkgDir, file)).text(),
          file,
        })),
    )
  )
    .filter(({ contents }) =>
      /from\s*["'](?:node:|@playwright\/test|playwright)["']/u.test(contents),
    )
    .map(({ file }) => file);
  if (bundledTestRuntimes.length > 0) {
    failures.push(
      `tarball bundles Node or Playwright imports (first: ${bundledTestRuntimes.at(0)})`,
    );
  }

  // One check per subpath, run together: each pushes its own findings, so the
  // report names every broken entry rather than the first one.
  await Promise.all(
    Object.entries(published.exports).map(async ([subpath, entry]) => {
      await Promise.all(
        distEntryFiles(entry).map(async (file) => {
          const relative = file.replace(/^\.\//u, "");
          if (!(await Bun.file(path.join(pkgDir, relative)).exists())) {
            failures.push(`${subpath}: the build emitted no ${file}`);
            return;
          }
          if (!packed.has(relative)) {
            failures.push(`${subpath}: ${file} is missing from the tarball`);
          }
        }),
      );

      // Resolve through the package name, so this exercises the export map a
      // consumer's resolver reads rather than the paths this script computed.
      const specifier = `${published.name}${subpath.replace(/^\./u, "")}`;
      let resolved: string;
      try {
        resolved = Bun.resolveSync(specifier, repoRoot);
      } catch {
        failures.push(`${subpath}: "${specifier}" does not resolve`);
        return;
      }
      if (
        !isExpectedPublishedExportResolution({
          entry,
          packageDir: pkgDir,
          resolved,
        })
      ) {
        failures.push(
          isDistModuleEntry(entry)
            ? `${subpath}: "${specifier}" resolved outside dist`
            : `${subpath}: "${specifier}" did not resolve to ${entry}`,
        );
      }
      resolvedBySubpath.set(subpath, resolved);

      if (!isDistModuleEntry(entry)) {
        return;
      }
      const loaded = await loadInNode(resolved);
      switch (loaded.type) {
        case "loaded": {
          if (loaded.exportCount === 0) {
            failures.push(`${subpath}: loaded from dist but exports nothing`);
          }
          return;
        }
        case "unreported": {
          failures.push(
            `${subpath}: Node loaded it but reported no export count`,
          );
          return;
        }
        case "unresolved": {
          if (
            isOwnDistLoadFailure({
              distDir: path.join(pkgDir, "dist"),
              reason: loaded.reason,
            })
          ) {
            failures.push(
              `${subpath}: does not load in Node: ${loaded.reason}`,
            );
            return;
          }
          // Node could not reach something this tarball does not decide. Bun's
          // importer still answers whether the entry exports anything.
          const viaBun: Record<string, unknown> = await import(resolved);
          if (Object.keys(viaBun).length === 0) {
            failures.push(`${subpath}: loaded from dist but exports nothing`);
          }
          return;
        }
        default: {
          loaded satisfies never;
          panic(`unhandled Node load result for ${subpath}`);
        }
      }
    }),
  );

  // A grouped subpath is a deprecated alias of the flat one, so the two have
  // to land on the same module. Nothing else keeps them from drifting into two
  // components with one name once the flat map is the one people edit.
  for (const subpath of Object.keys(published.exports)) {
    const segments = subpath.split("/");
    const name = segments.at(-1);
    if (segments.length < 3 || name === undefined) {
      continue;
    }
    const flat = `./${name}`;
    const aliased = resolvedBySubpath.get(subpath);
    const primary = resolvedBySubpath.get(flat);
    if (primary === undefined) {
      failures.push(`${subpath}: no flat subpath "${flat}" to alias`);
      continue;
    }
    if (aliased !== primary) {
      failures.push(
        `${subpath}: alias resolves to ${aliased}, but "${flat}" resolves to ${primary}`,
      );
    }
  }
} finally {
  await Bun.write(pkgPath, sourceManifest);
}

if (failures.length > 0) {
  panic(
    `${published.name}: published export map does not hold\n  ${failures.join("\n  ")}`,
  );
}

console.log(
  `${published.name}@${published.version}: ${Object.keys(published.exports).length} exports resolve and ship; modules load from dist in Node`,
);
