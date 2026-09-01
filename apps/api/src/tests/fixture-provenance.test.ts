import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  CAPTURED_FIXTURE_ROOTS,
  type FixtureProvenance,
  isCapturedFixture,
  LEGACY_CAPTURES,
  parseProvenance,
  provenancePathOf,
  PROVENANCE_SUFFIX,
  sha256Of,
} from "./fixture-provenance";

// `apps/api`, two levels up from `src/tests`.
const API_ROOT = path.resolve(import.meta.dir, "../..");

const RECAPTURE_HINT =
  "captured fixtures hold source bytes verbatim; recapture with " +
  "`bun apps/api/scripts/capture-parser-fixture.ts <url> --name <file>` " +
  "(or record-eu-ecj-fixtures.ts for the eu-ecj corpus) " +
  "rather than editing the file";

type CapturedFixture = {
  relativePath: string;
  sha256: string;
  /** Sidecar text, or undefined when no sidecar exists. */
  sidecar: string | undefined;
  provenance: FixtureProvenance | undefined;
};

/** Repo-relative paths of everything under the declared roots. */
const scanRoots = async (): Promise<string[]> => {
  const perRoot = await Promise.all(
    CAPTURED_FIXTURE_ROOTS.map(async (root) => {
      const entries = await Array.fromAsync(
        new Bun.Glob("**/*").scan({
          cwd: path.resolve(API_ROOT, root),
          onlyFiles: true,
          dot: true,
        }),
      );
      return entries.map((entry) => `${root}/${entry}`);
    }),
  );
  // Plain code-unit ordering: these are file paths, not display text.
  return perRoot.flat().sort();
};

const readFixture = async (relativePath: string): Promise<CapturedFixture> => {
  const [bytes, sidecarFile] = [
    await Bun.file(path.resolve(API_ROOT, relativePath)).bytes(),
    Bun.file(path.resolve(API_ROOT, provenancePathOf(relativePath))),
  ];
  const sidecar = (await sidecarFile.exists())
    ? await sidecarFile.text()
    : undefined;
  return {
    relativePath,
    sha256: sha256Of(bytes),
    sidecar,
    provenance: sidecar === undefined ? undefined : parseProvenance(sidecar),
  };
};

const allPaths = await scanRoots();
const fixtures = await Promise.all(
  allPaths.filter(isCapturedFixture).map(readFixture),
);
const sidecarPaths = allPaths.filter((entry) =>
  entry.endsWith(PROVENANCE_SUFFIX),
);

describe("captured fixture provenance", () => {
  /**
   * Guard the walk itself. Every other test here reports violations out
   * of this list, so a glob that silently matched nothing would turn the
   * whole suite green while checking no fixture at all.
   */
  test("the fixture roots are non-empty", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  test("every captured fixture has a provenance sidecar", () => {
    const missing = fixtures
      .filter(({ sidecar }) => sidecar === undefined)
      .map(({ relativePath }) => relativePath);

    expect(
      missing,
      `fixtures without a ${PROVENANCE_SUFFIX} sidecar: record one with the capture script`,
    ).toEqual([]);
  });

  test("every sidecar is well formed", () => {
    const malformed = fixtures
      .filter(({ sidecar, provenance }) => sidecar !== undefined && !provenance)
      .map(({ relativePath }) => provenancePathOf(relativePath));

    expect(
      malformed,
      'sidecars need capture: "recorded" with sourceUrl + capturedAt, or capture: "legacy" with a note',
    ).toEqual([]);
  });

  /**
   * The point of the whole file: the bytes on disk are the bytes that
   * were captured. A hand edit, a formatter pass, or an editor honoring
   * `.editorconfig`'s trailing-whitespace and final-newline rules all
   * break this hash, and each one silently changes what the parser suite
   * is testing against.
   */
  test("every captured fixture still hashes to its recorded sha256", () => {
    const drifted = fixtures.flatMap(({ relativePath, sha256, provenance }) =>
      provenance === undefined || provenance.sha256 === sha256
        ? []
        : [`${relativePath}: recorded ${provenance.sha256}, found ${sha256}`],
    );

    expect(drifted, RECAPTURE_HINT).toEqual([]);
  });

  test("no sidecar is orphaned", () => {
    const captured = new Set(fixtures.map(({ relativePath }) => relativePath));
    const orphans = sidecarPaths.filter(
      (sidecar) => !captured.has(sidecar.slice(0, -PROVENANCE_SUFFIX.length)),
    );

    expect(orphans, "sidecar without the fixture it describes").toEqual([]);
  });

  /**
   * Ratchet. Legacy captures predate the convention and cannot be given
   * an origin honestly, so they are allowed — but only the ones already
   * on the ledger. Holding the ledger and the sidecars to exact
   * agreement in both directions means recapturing one requires deleting
   * its ledger entry, and adding a new capture without provenance
   * requires adding one in the diff, where review can see it.
   */
  test("legacy captures match the ledger exactly", () => {
    const legacy = fixtures
      .filter(({ provenance }) => provenance?.capture === "legacy")
      .map(({ relativePath }) => relativePath)
      .sort();

    expect(legacy).toEqual([...LEGACY_CAPTURES].sort());
  });
});
