import { panic, Result, TaggedError } from "better-result";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { selectPromotedRelease } from "./promoted-release-policy";

const DEFAULT_MANIFEST_PATH = path.join(
  import.meta.dir,
  "../apps/landing/src/data/changelog-release-dates.json",
);
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

export const resolvePromotedRelease = (
  manifest: unknown,
): Result<string, PromotedReleaseError> => {
  const selected = selectPromotedRelease(manifest);
  switch (selected.status) {
    case "resolved":
      return Result.ok(selected.ref);
    case "invalid":
      return Result.err(
        new PromotedReleaseManifestError({ message: selected.message }),
      );
    case "missing":
      return Result.err(
        new PromotedReleaseMissingError({ message: selected.message }),
      );
    case "ambiguous":
      return Result.err(
        new PromotedReleaseAmbiguousError({ message: selected.message }),
      );
    default:
      selected satisfies never;
      return panic("Unhandled promotion selection");
  }
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
