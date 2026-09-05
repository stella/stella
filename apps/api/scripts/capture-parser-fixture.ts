/**
 * Capture a parser fixture from its source, with provenance.
 *
 * Fetches a URL and writes the response bytes verbatim, next to a
 * `<name>.provenance.json` sidecar naming their sha256, the URL and the
 * capture time. `src/tests/fixture-provenance.test.ts` recomputes that
 * hash on every run, so a fixture written by hand — or edited after
 * capture — fails the suite.
 *
 * Writes bytes exactly as served: no reformatting, no re-indentation, no
 * trailing-newline fixups. Source whitespace is part of what the parser
 * is being tested against, and supplying whitespace the source did not
 * send is how a parser bug hides behind a green suite.
 *
 * Usage:
 *   bun apps/api/scripts/capture-parser-fixture.ts <url>
 *   bun apps/api/scripts/capture-parser-fixture.ts <url> --name cz-nss-8-as-12-2026.html
 *   bun apps/api/scripts/capture-parser-fixture.ts <url> --dir src/handlers/.../__fixtures__
 *   bun apps/api/scripts/capture-parser-fixture.ts <url> --note "spacer-span verdict"
 *   bun apps/api/scripts/capture-parser-fixture.ts <url> --name page.html.gz --gzip
 *
 * The eu-ecj decision corpus is not captured with this script: those
 * fixtures are paired with their Formex oracle, which only the adapter's
 * own query path can resolve. Re-record them with
 * `bun apps/api/scripts/record-eu-ecj-fixtures.ts`, which writes the
 * same sidecars. A single page in that directory that has no oracle to
 * pair with is captured here, with `--gzip` for the directory's
 * convention.
 */

import path from "node:path";

import { INGESTION_USER_AGENT } from "@/api/handlers/case-law/ingestion/adapters/utils";

import {
  CAPTURED_FIXTURE_ROOTS,
  formatProvenance,
  provenancePathOf,
  sha256Of,
} from "../src/tests/fixture-provenance";

const API_ROOT = path.resolve(import.meta.dir, "..");
const DEFAULT_DIR = CAPTURED_FIXTURE_ROOTS[0];
const FETCH_TIMEOUT_MS = 120_000;

const log = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

// The declaration-level annotation is what lets TypeScript narrow after a
// call: an inferred never on the initializer alone does not.
const fail: (message: string) => never = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

/** Value of `--flag <value>`, or undefined when the flag is absent. */
const flagValue = (
  argv: readonly string[],
  flag: string,
): string | undefined => {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
};

/**
 * Whether `child` really sits under `parent`.
 *
 * Compared through `path.relative` rather than a string prefix, which
 * would also accept a sibling directory whose name merely starts with
 * the root's (`__fixtures__-backup`).
 */
const isInside = (child: string, parent: string): boolean => {
  const relative = path.relative(
    path.resolve(API_ROOT, parent),
    path.resolve(API_ROOT, child),
  );
  return (
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
};

/** Filename implied by a URL, for when `--name` is not given. */
const nameFromUrl = (url: URL): string | undefined => {
  const base = path.basename(url.pathname);
  return base.length > 0 && base !== "/" ? base : undefined;
};

const capture = async (argv: readonly string[]): Promise<void> => {
  const rawUrl = argv.find((argument) => !argument.startsWith("--"));
  if (rawUrl === undefined) {
    fail(
      "usage: bun apps/api/scripts/capture-parser-fixture.ts <url> [--name <file>] [--dir <path>] [--note <text>]",
    );
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return fail(`not a URL: ${rawUrl}`);
  }

  const name = flagValue(argv, "--name") ?? nameFromUrl(url);
  if (name === undefined) {
    fail(`cannot derive a filename from ${rawUrl}; pass --name`);
  }

  const dir = flagValue(argv, "--dir") ?? DEFAULT_DIR;
  const relativePath = path.join(dir, name);
  // A capture outside a declared root is never hash-checked, so the
  // guard would pass while the fixture drifts. Refuse rather than write
  // a fixture nothing watches.
  if (!CAPTURED_FIXTURE_ROOTS.some((root) => isInside(relativePath, root))) {
    fail(
      `${relativePath} is outside the captured-fixture roots, where the provenance test would never see it.\n` +
        `Add the directory to CAPTURED_FIXTURE_ROOTS in src/tests/fixture-provenance.ts first.`,
    );
  }

  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "User-Agent": INGESTION_USER_AGENT },
  });
  if (!response.ok) {
    fail(`${url.href}: ${response.status} ${response.statusText}`);
  }

  const served = new Uint8Array(await response.arrayBuffer());
  // Compression is not a rewrite: gunzipping gives the served bytes back
  // exactly, and the sidecar pins what is on disk, which is what the
  // guard rehashes. Directories whose fixtures run to hundreds of
  // kilobytes store them this way.
  const bytes = argv.includes("--gzip") ? Bun.gzipSync(served) : served;
  const note = flagValue(argv, "--note");
  await Bun.write(path.resolve(API_ROOT, relativePath), bytes);
  await Bun.write(
    path.resolve(API_ROOT, provenancePathOf(relativePath)),
    formatProvenance({
      capture: "recorded",
      sha256: sha256Of(bytes),
      sourceUrl: url.href,
      capturedAt: new Date().toISOString(),
      ...(note === undefined ? {} : { note }),
    }),
  );

  log(`${relativePath}: ${bytes.length} bytes`);
  log(`${provenancePathOf(relativePath)}: recorded`);
};

if (import.meta.main) {
  await capture(process.argv.slice(2));
}
