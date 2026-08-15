#!/usr/bin/env bun
/**
 * Regenerates the committed Snowball stemmers under
 * `apps/api/src/lib/legal-search/morphology/snowball/`.
 *
 * Stem output is an index-format dependency: re-stemming a corpus with a
 * different algorithm version silently changes what a query matches. The
 * source is therefore pinned to a Snowball release tag, never to `main`.
 *
 * Modes:
 *   (default)          regenerate into a temp dir and diff against the
 *                      committed files; exit 1 on drift
 *   --write            overwrite the committed files and conformance fixtures
 *
 * Requires a C toolchain, `make`, `perl`, and `git`: the Snowball compiler is
 * built from source. It is a manual upgrade tool, deliberately outside the
 * build and outside CI. The committed output is bound to the pinned
 * algorithm instead by the conformance fixtures this script writes, which
 * `snowball/conformance.test.ts` checks on every run.
 */

import { panic } from "better-result";
import { $ } from "bun";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SNOWBALL_BASE_STEMMER_SHA256 } from "@/api/lib/legal-search/morphology/snowball/base-stemmer";

const SNOWBALL_REPO = "https://github.com/snowballstem/snowball";
const SNOWBALL_TAG = "v3.1.1";
/** Commit the tag resolves to; recorded so the checkout is verifiable. */
const SNOWBALL_COMMIT = "cd195b51e948a902a4312f023f4a14392516a543";

const SNOWBALL_DATA_REPO = "https://github.com/snowballstem/snowball-data";
/** snowball-data carries no tags; pin the commit the fixtures were cut from. */
const SNOWBALL_DATA_COMMIT = "a0ec0d0a2839ec885878868de20fcb63209d92b0";

const REPO_ROOT = path.join(import.meta.dir, "..");
const MODULE_DIR = path.join(
  REPO_ROOT,
  "apps/api/src/lib/legal-search/morphology/snowball",
);
const FIXTURE_DIR = path.join(MODULE_DIR, "__fixtures__");

/**
 * Conformance sampling: every Nth vocabulary pair, plus the head and tail of
 * the list. Deterministic, so re-running `--write` is a no-op unless the
 * upstream vocabulary itself moved.
 */
const SAMPLE_STRIDE = 25;
const SAMPLE_EDGE = 100;

type StemmerTarget = {
  /** Snowball algorithm name, i.e. `algorithms/<name>.sbl`. */
  readonly algorithm: string;
  /** Committed module basename, without extension. */
  readonly module: string;
  readonly className: string;
};

const TARGETS = [
  { algorithm: "czech", module: "czech.gen", className: "CzechStemmer" },
  { algorithm: "polish", module: "polish.gen", className: "PolishStemmer" },
] as const satisfies readonly StemmerTarget[];

const BASE_STEMMER_IMPORT =
  "@/api/lib/legal-search/morphology/snowball/base-stemmer";

const licenceHeader = (algorithm: string) => `/**
 * Generated Snowball stemmer. Do not edit by hand.
 *
 * Regenerate with:
 *   bun scripts/generate-snowball-stemmers.ts --write
 *
 * Upstream:  ${SNOWBALL_REPO}
 * Version:   ${SNOWBALL_TAG} (commit ${SNOWBALL_COMMIT})
 * Command:   ./snowball algorithms/${algorithm}.sbl -js -o ${algorithm}
 *
 * The generator emits JavaScript; the committed module is that output with
 * mechanical, script-applied edits only (module header, named export, type
 * annotations the repo's strict TypeScript settings require, and total
 * substitution-table reads). No algorithm logic is edited.
 *
 * Copyright (c) 2001, Dr Martin Porter
 * Copyright (c) 2004,2005, Richard Boulton
 * Copyright (c) 2013, Yoshiki Shibukawa
 * Copyright (c) 2006-2025, Olly Betts
 * All rights reserved. Distributed under the BSD 3-Clause licence; see the
 * full notice in ./base-stemmer.ts.
 */

import type { AmongTable } from "${BASE_STEMMER_IMPORT}";
import {
  BaseStemmer,
  substitution,
} from "${BASE_STEMMER_IMPORT}";
`;

const fixtureHeader = (
  algorithm: string,
  pairs: number,
) => `# Snowball ${algorithm} conformance fixture. Do not edit by hand.
#
# Regenerate with:
#   bun scripts/generate-snowball-stemmers.ts --write
#
# A deterministic sample (every ${SAMPLE_STRIDE}th pair, plus the first and
# last ${SAMPLE_EDGE}) of the official reference vocabulary:
#   ${SNOWBALL_DATA_REPO} @ ${SNOWBALL_DATA_COMMIT}
#   ${algorithm}/voc.txt -> ${algorithm}/output.txt
# produced by Snowball ${SNOWBALL_TAG}. ${pairs} pairs.
#
# Format: <word>\\t<stem>, one pair per line.
#
# The vocabularies are derived from third-party corpora; see
# ${algorithm}/COPYING upstream for their licence terms. The Snowball
# project itself is BSD 3-Clause (see ../base-stemmer.ts).
`;

type Rewrite = readonly [
  pattern: RegExp,
  replace: (match: string, ...groups: string[]) => string,
];

/**
 * Mechanical JS -> TS rewrites. Each pattern is anchored tightly enough that
 * a change in generator output shape fails loudly (the compile or the
 * conformance test breaks) instead of silently passing logic through
 * untranslated.
 */
const rewritesFor = (target: StemmerTarget): readonly Rewrite[] => [
  // Among tables: annotate so the row tuples type-check.
  [
    /^const (a_\d+) = \[$/gmu,
    (_match, name) => `const ${name}: AmongTable = [`,
  ],
  // Substitution and grouping tables: JSDoc comment -> real annotation.
  [
    /^const \/\*\* Array<string> \*\/ (as_\d+) = /gmu,
    (_match, name) => `const ${name}: readonly string[] = `,
  ],
  [
    /^const \/\*\* Array<number> \*\/ (g_\w+) = /gmu,
    (_match, name) => `const ${name}: readonly number[] = `,
  ],
  // Locals: `let /** number */ x;` has no initialiser to infer from.
  [
    /^( *)let \/\*\* number \*\/ (\w+);$/gmu,
    (_match, indent, name) => `${indent}let ${name}: number;`,
  ],
  // Locals with an initialiser: inference already covers them.
  [/const \/\*\* number \*\/ /gu, () => "const "],
  // Private field with a trailing JSDoc type comment.
  [
    /^( *)#(\w+)\/\*\* number \*\/ = /gmu,
    (_match, indent, name) => `${indent}#${name} = `,
  ],
  // Named export in place of the anonymous default.
  [
    /^export default class extends B \{$/gmu,
    () => `export class ${target.className} extends BaseStemmer {`,
  ],
  // Public entry point.
  [
    /^( *)stem\(\/\*\*string\*\/input\) \{$/gmu,
    (_match, indent) => `${indent}stem(input: string): string {`,
  ],
  // Substitution reads: total accessor in place of a possibly-undefined index.
  [
    /(as_\d+)\[([^\]]+)\]/gu,
    (_match, table, index) => `substitution(${table}, ${index})`,
  ],
];

const toTypeScriptModule = (generated: string, target: StemmerTarget) => {
  let source = generated
    .split("\n")
    .filter((line) => !line.startsWith("import B from './base-stemmer.js'"))
    .join("\n");

  for (const [pattern, replace] of rewritesFor(target)) {
    source = source.replace(pattern, (match, ...groups: string[]) =>
      replace(match, ...groups),
    );
  }

  if (source.includes("export default class extends B")) {
    panic(`${target.algorithm}: class declaration was not rewritten`);
  }
  if (/\/\*\*\s*(?:Array<|number|string)/u.test(source)) {
    panic(`${target.algorithm}: a JSDoc type comment survived the rewrite`);
  }

  return `${licenceHeader(target.algorithm)}\n${source.trimEnd()}\n`;
};

const sampleIndexes = (total: number): readonly number[] => {
  const picked = new Set<number>();
  for (let index = 0; index < Math.min(SAMPLE_EDGE, total); index++) {
    picked.add(index);
  }
  for (let index = Math.max(0, total - SAMPLE_EDGE); index < total; index++) {
    picked.add(index);
  }
  for (let index = 0; index < total; index += SAMPLE_STRIDE) {
    picked.add(index);
  }
  return [...picked].sort((a, b) => a - b);
};

const buildFixture = (algorithm: string, voc: string, output: string) => {
  const words = voc.split("\n");
  const stems = output.split("\n");
  if (words.length !== stems.length) {
    panic(
      `${algorithm}: voc.txt has ${words.length} lines but output.txt has ${stems.length}`,
    );
  }

  const rows: string[] = [];
  for (const index of sampleIndexes(words.length)) {
    const word = words[index];
    const stem = stems[index];
    if (word === undefined || stem === undefined || word === "") {
      continue;
    }
    rows.push(`${word}\t${stem}`);
  }

  return `${fixtureHeader(algorithm, rows.length)}${rows.join("\n")}\n`;
};

const sha256 = (contents: string) =>
  createHash("sha256").update(contents).digest("hex");

type Artifact = { readonly path: string; readonly contents: string };

type BuildTargetOptions = {
  readonly target: StemmerTarget;
  /** Checkout of the Snowball compiler repo at the pinned tag. */
  readonly snowballDir: string;
  /** Checkout of snowball-data at the pinned commit. */
  readonly dataDir: string;
  /** Scratch directory the compiler writes its JavaScript into. */
  readonly workDir: string;
};

const buildTarget = async ({
  target,
  snowballDir,
  dataDir,
  workDir,
}: BuildTargetOptions): Promise<readonly Artifact[]> => {
  const outputStem = path.join(workDir, target.algorithm);
  const compiler = path.join(snowballDir, "snowball");
  const algorithm = path.join(
    snowballDir,
    "algorithms",
    `${target.algorithm}.sbl`,
  );
  await $`${compiler} ${algorithm} -js -o ${outputStem}`.quiet();

  const [generated, voc, output] = await Promise.all([
    readFile(`${outputStem}.js`, "utf-8"),
    readFile(path.join(dataDir, target.algorithm, "voc.txt"), "utf-8"),
    readFile(path.join(dataDir, target.algorithm, "output.txt"), "utf-8"),
  ]);

  return [
    {
      path: path.join(MODULE_DIR, `${target.module}.ts`),
      contents: toTypeScriptModule(generated, target),
    },
    {
      path: path.join(FIXTURE_DIR, `${target.algorithm}.conformance.txt`),
      contents: buildFixture(target.algorithm, voc, output),
    },
  ];
};

const buildArtifacts = async (
  workDir: string,
): Promise<readonly Artifact[]> => {
  const snowballDir = path.join(workDir, "snowball");
  const dataDir = path.join(workDir, "snowball-data");

  await $`git clone --depth 1 --branch ${SNOWBALL_TAG} ${SNOWBALL_REPO} ${snowballDir}`.quiet();
  const head = (await $`git -C ${snowballDir} rev-parse HEAD`.text()).trim();
  if (head !== SNOWBALL_COMMIT) {
    panic(
      `${SNOWBALL_TAG} resolved to ${head}, expected ${SNOWBALL_COMMIT}; the tag moved`,
    );
  }
  await $`make -C ${snowballDir} snowball`.quiet();

  await $`git clone ${SNOWBALL_DATA_REPO} ${dataDir}`.quiet();
  await $`git -C ${dataDir} checkout ${SNOWBALL_DATA_COMMIT}`.quiet();

  const upstreamBaseStemmer = await readFile(
    path.join(snowballDir, "javascript/base-stemmer.js"),
    "utf-8",
  );
  const upstreamDigest = sha256(upstreamBaseStemmer);
  if (upstreamDigest !== SNOWBALL_BASE_STEMMER_SHA256) {
    panic(
      `upstream javascript/base-stemmer.js changed (${upstreamDigest}); re-port ` +
        "apps/api/src/lib/legal-search/morphology/snowball/base-stemmer.ts and update its digest",
    );
  }

  const perTarget = await Promise.all(
    TARGETS.map(
      async (target) =>
        await buildTarget({ target, snowballDir, dataDir, workDir }),
    ),
  );
  return perTarget.flat();
};

const check = async (artifact: Artifact): Promise<string | null> => {
  const committed = await readFile(artifact.path, "utf-8").catch(() => null);
  if (committed === artifact.contents) {
    return null;
  }
  return committed === null
    ? `missing: ${artifact.path}`
    : `drifted: ${artifact.path} (committed ${sha256(committed)}, regenerated ${sha256(artifact.contents)})`;
};

const main = async (): Promise<number> => {
  const write = process.argv.includes("--write");
  const workDir = await mkdtemp(path.join(os.tmpdir(), "snowball-"));

  try {
    const artifacts = await buildArtifacts(workDir);

    if (write) {
      await Promise.all(
        artifacts.map(
          async ({ path: file, contents }) =>
            await writeFile(file, contents, "utf-8"),
        ),
      );
      console.log(`wrote ${artifacts.length} files`);
      return 0;
    }

    const drift = (await Promise.all(artifacts.map(check))).filter(
      (entry) => entry !== null,
    );
    for (const entry of drift) {
      console.error(entry);
    }
    if (drift.length > 0) {
      console.error(
        `\n${drift.length} file(s) differ from Snowball ${SNOWBALL_TAG}. Run with --write.`,
      );
      return 1;
    }
    console.log(`${artifacts.length} files match Snowball ${SNOWBALL_TAG}`);
    return 0;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
};

process.exit(await main());
