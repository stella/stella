import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

import { compareCodeUnit } from "@stll/collation";

import {
  CREDENTIAL_VERIFIERS,
  NON_PRINCIPAL_CREDENTIAL_SOURCES,
} from "@/api/tests/security/credential-verifiers";

const repoRoot = nodePath.resolve(import.meta.dir, "../../../../..");
const apiSourceRoot = "apps/api/src";

/**
 * Calls that check a presented credential: signature and token comparisons,
 * framework session reads, API key lookups and opaque-token digests.
 */
const VERIFICATION_PRIMITIVES: readonly RegExp[] = [
  /\bjwtVerify\s*\(/u,
  /\bverifyJWT\b/u,
  /\bverifyBearerToken\b/u,
  /\bverifyApiKey\s*\(/u,
  /\.getSession\s*\(/u,
  /\bgetSessionFromCtx\s*\(/u,
  /\btimingSafeEqual\s*\(/u,
  /\bhash\w*Token\s*\(/u,
];

// Tests and their helpers present credentials; operator scripts never accept
// a request.
const isServedSource = (path: string) =>
  path.endsWith(".ts") &&
  !path.endsWith(".d.ts") &&
  !/\.(?:test|type-test)\.ts$/u.test(path) &&
  !path.startsWith(`${apiSourceRoot}/tests/`) &&
  !path.startsWith(`${apiSourceRoot}/scripts/`) &&
  !path.startsWith(`${apiSourceRoot}/dev/`);

const withoutComments = (source: string) =>
  source
    .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
    .replaceAll(/(^|\s)\/\/.*$/gmu, "$1");

const usesVerificationPrimitive = (source: string) => {
  const code = withoutComments(source);
  return VERIFICATION_PRIMITIVES.some((primitive) => primitive.test(code));
};

const scanVerificationSources = async (): Promise<string[]> => {
  const glob = new Bun.Glob("**/*.ts");
  const found: string[] = [];
  for await (const relative of glob.scan({
    cwd: nodePath.join(repoRoot, apiSourceRoot),
  })) {
    const path = `${apiSourceRoot}/${relative}`;
    if (!isServedSource(path)) {
      continue;
    }
    const source = await Bun.file(nodePath.join(repoRoot, path)).text();
    if (usesVerificationPrimitive(source)) {
      found.push(path);
    }
  }
  return found.toSorted(compareCodeUnit);
};

const verifierSources = new Set(
  Object.values(CREDENTIAL_VERIFIERS).flatMap(({ sources }) => sources),
);

describe("credential verifier registry", () => {
  test("every file that checks a credential is a registered verifier or names why it yields no principal", async () => {
    const scanned = await scanVerificationSources();
    const unclaimed = scanned.filter(
      (path) =>
        !verifierSources.has(path) &&
        !Object.hasOwn(NON_PRINCIPAL_CREDENTIAL_SOURCES, path),
    );
    expect(unclaimed).toEqual([]);
  });

  test("every non-principal entry still checks a credential", async () => {
    const scanned = new Set(await scanVerificationSources());
    const stale = Object.keys(NON_PRINCIPAL_CREDENTIAL_SOURCES).filter(
      (path) => !scanned.has(path),
    );
    expect(stale).toEqual([]);
  });

  test("a file is either a verifier source or a non-principal source", () => {
    const both = Object.keys(NON_PRINCIPAL_CREDENTIAL_SOURCES).filter((path) =>
      verifierSources.has(path),
    );
    expect(both).toEqual([]);
  });

  test("every verifier source exists", async () => {
    const missing: string[] = [];
    for (const path of verifierSources) {
      if (!(await Bun.file(nodePath.join(repoRoot, path)).exists())) {
        missing.push(path);
      }
    }
    expect(missing).toEqual([]);
  });

  test("every out-of-suite proof names a test in its file", async () => {
    const missing: string[] = [];
    for (const verifier of Object.values(CREDENTIAL_VERIFIERS)) {
      if (!("proof" in verifier)) {
        continue;
      }
      const source = await Bun.file(
        nodePath.join(repoRoot, verifier.proof.file),
      ).text();
      if (!source.includes(`test("${verifier.proof.test}"`)) {
        missing.push(`${verifier.proof.file}: ${verifier.proof.test}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("the scan recognizes each primitive", () => {
    // Each shape the scan must see, and a commented-out one it must not.
    const shapes = [
      "await jwtVerify(token, key)",
      "await auth.api.verifyJWT({ body })",
      "verifyBearerToken(token, options)",
      "await verifyApiKey({ body })",
      "await getAuth().api.getSession({ headers })",
      "await getSessionFromCtx(ctx)",
      "timingSafeEqual(a, b)",
      "hashDesktopEditSessionToken(token)",
    ];
    expect(shapes.filter((shape) => !usesVerificationPrimitive(shape))).toEqual(
      [],
    );
    expect(usesVerificationPrimitive("// timingSafeEqual(a, b)")).toBe(false);
  });
});
