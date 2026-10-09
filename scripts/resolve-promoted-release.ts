import { Result, TaggedError } from "better-result";
import { readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_MANIFEST_PATH = path.join(
  import.meta.dir,
  "../apps/landing/src/data/changelog-release-dates.json",
);
const STABLE_RELEASE_PATTERN = /^v\d+\.\d+\.\d+$/u;

export class PromotedReleaseManifestError extends TaggedError(
  "PromotedReleaseManifestError",
)<{
  message: string;
}> {}

export class PromotedReleaseMissingError extends TaggedError(
  "PromotedReleaseMissingError",
)<{
  message: string;
}> {}

export class PromotedReleaseAmbiguousError extends TaggedError(
  "PromotedReleaseAmbiguousError",
)<{
  message: string;
}> {}

type PromotedReleaseError =
  | PromotedReleaseManifestError
  | PromotedReleaseMissingError
  | PromotedReleaseAmbiguousError;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const resolvePromotedRelease = (
  manifest: unknown,
): Result<string, PromotedReleaseError> => {
  if (!isRecord(manifest)) {
    return Result.err(
      new PromotedReleaseManifestError({
        message: "The release publication manifest must be an object.",
      }),
    );
  }

  const promoted: {
    ref: string;
    publishedAt: string;
    publishedAtMs: number;
  }[] = [];
  for (const [ref, publishedAt] of Object.entries(manifest)) {
    if (ref === "_note") {
      continue;
    }
    if (!STABLE_RELEASE_PATTERN.test(ref)) {
      return Result.err(
        new PromotedReleaseManifestError({
          message: `The release publication manifest contains an invalid stable release ref: ${ref}.`,
        }),
      );
    }
    if (publishedAt === null) {
      continue;
    }
    if (typeof publishedAt !== "string") {
      return Result.err(
        new PromotedReleaseManifestError({
          message: `The release publication manifest contains an invalid publication time for ${ref}.`,
        }),
      );
    }
    const publishedAtMs = Date.parse(publishedAt);
    if (!Number.isFinite(publishedAtMs)) {
      return Result.err(
        new PromotedReleaseManifestError({
          message: `The release publication manifest contains an invalid publication time for ${ref}.`,
        }),
      );
    }
    promoted.push({ ref, publishedAt, publishedAtMs });
  }

  if (promoted.length === 0) {
    return Result.err(
      new PromotedReleaseMissingError({
        message:
          "The release publication manifest records no promoted release.",
      }),
    );
  }

  promoted.sort((left, right) => right.publishedAtMs - left.publishedAtMs);
  const latest = promoted.at(0);
  if (!latest) {
    return Result.err(
      new PromotedReleaseMissingError({
        message:
          "The release publication manifest records no promoted release.",
      }),
    );
  }
  const candidates = promoted.filter(
    ({ publishedAtMs }) => publishedAtMs === latest.publishedAtMs,
  );
  if (candidates.length !== 1) {
    return Result.err(
      new PromotedReleaseAmbiguousError({
        message: `The release publication manifest records multiple releases at ${latest.publishedAt}: ${candidates.map(({ ref }) => ref).join(", ")}.`,
      }),
    );
  }

  return Result.ok(latest.ref);
};

const run = async () => {
  const args = process.argv.slice(2);
  const manifestFlag = args.indexOf("--manifest");
  const manifestPath =
    manifestFlag === -1 ? DEFAULT_MANIFEST_PATH : args.at(manifestFlag + 1);
  const acceptedArgs = new Set(["--check", "--manifest", manifestPath]);
  if (!manifestPath || args.some((arg) => !acceptedArgs.has(arg))) {
    process.stderr.write(
      "Usage: bun scripts/resolve-promoted-release.ts --check [--manifest <path>]\n",
    );
    process.exitCode = 2;
    return;
  }

  const contents = await Result.tryPromise({
    try: async () => readFile(manifestPath, "utf-8"),
    catch: (cause) =>
      new PromotedReleaseMissingError({
        message: `Could not read the release publication manifest at ${manifestPath}: ${String(cause)}`,
      }),
  });
  if (contents.isErr()) {
    process.stderr.write(`${contents.error.name}: ${contents.error.message}\n`);
    process.exitCode = 1;
    return;
  }
  const parsed = Result.try({
    try: () => JSON.parse(contents.value),
    catch: (cause) =>
      new PromotedReleaseManifestError({
        message: `Could not parse the release publication manifest: ${String(cause)}`,
      }),
  });
  if (parsed.isErr()) {
    process.stderr.write(`${parsed.error.name}: ${parsed.error.message}\n`);
    process.exitCode = 1;
    return;
  }
  const resolved = resolvePromotedRelease(parsed.value);
  if (resolved.isErr()) {
    process.stderr.write(`${resolved.error.name}: ${resolved.error.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${resolved.value}\n`);
};

if (import.meta.main) {
  await run();
}
