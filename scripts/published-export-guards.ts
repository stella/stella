import { Result } from "better-result";
import path from "node:path";

import { isPathStrictlyInside } from "@stll/portable-path";

const testArtifactPattern =
  /(?:^|\/)(?:fixtures\/|[^/]+\.(?:test|spec)\.(?:[cm]?[jt]sx?|d\.ts)$|[^/]+\.playwright\.[cm]?[jt]sx?$|playwright\.config\.[cm]?[jt]sx?$)/u;

export const isPublishedTestArtifact = (file: string) =>
  testArtifactPattern.test(file);

/**
 * Whether a Node load failure is the tarball's own defect.
 *
 * Node's ESM resolver is what decides whether a published package loads for a
 * consumer, and it is stricter than Bun's: Bun fills in an omitted relative
 * extension, so `export * from "./thing"` passes there and fails on install.
 * That is the hole worth failing on. In-repo, though, Node also walks outside
 * the package under test — a workspace dependency still exports TypeScript
 * source here, a third-party export map may use a directory import, a
 * Bun-targeted package imports `bun` — and none of those is decided by this
 * tarball. So a failure counts only when the specifier Node could not reach
 * lives in the package's own `dist`.
 *
 * Node phrases these as "<target> imported from <importer>"; the target is the
 * half that names what could not be resolved. It is prose around a path, so
 * the path is recovered by splitting on the quotes and spaces that surround it.
 */
export const isOwnDistLoadFailure = ({
  distDir,
  reason,
}: {
  readonly distDir: string;
  readonly reason: string;
}): boolean => {
  const [target] = reason.split(" imported from ");
  return (
    target
      ?.split(/["'\s]+/u)
      .some(
        (token) =>
          path.isAbsolute(token) && isPathStrictlyInside(distDir, token),
      ) === true
  );
};

// A string literal resolved against the module's own URL: worker entries and
// binary assets a built module loads at runtime rather than imports.
const IMPORT_META_URL_TARGET =
  /new\s+URL\(\s*(?<quote>["'`])(?<target>[^"'`$\\]+)\k<quote>\s*,\s*import\.meta\.url\s*\)/gu;
const URL_SCHEME = /^[a-z][a-z\d+.-]*:/iu;

/**
 * Package-relative paths a built module reaches through
 * `new URL("<relative>", import.meta.url)`. Nothing imports these, so neither
 * the export map nor a Node load proves they ship: a worker spawned this way
 * fails only when the consumer first starts it. Absolute and scheme URLs are
 * not package files and are skipped; a target ending in `/` names a directory.
 */
export const importMetaUrlTargets = ({
  file,
  contents,
}: {
  readonly file: string;
  readonly contents: string;
}): string[] =>
  [...contents.matchAll(IMPORT_META_URL_TARGET)].flatMap((match) => {
    const target = match.groups?.["target"];
    if (
      target === undefined ||
      target.startsWith("/") ||
      URL_SCHEME.test(target)
    ) {
      return [];
    }
    // posix.join keeps a trailing slash, so a directory target stays one.
    return [path.posix.join(path.posix.dirname(file), target)];
  });

/** Whether a package-relative URL target ships in the tarball's file list. */
export const isShippedUrlTarget = ({
  target,
  packed,
}: {
  readonly target: string;
  readonly packed: ReadonlySet<string>;
}): boolean =>
  target.endsWith("/")
    ? [...packed].some((file) => file.startsWith(target))
    : packed.has(target);

type PublishedExportEntry = string | { readonly import: string };

export const isExpectedPublishedExportResolution = ({
  entry,
  packageDir,
  resolved,
}: {
  readonly entry: PublishedExportEntry;
  readonly packageDir: string;
  readonly resolved: string;
}): boolean => {
  if (typeof entry === "string") {
    return path.resolve(resolved) === path.resolve(packageDir, entry);
  }

  return isPathStrictlyInside(path.resolve(packageDir, "dist"), resolved);
};

type ResolvePublishedExportOptions = {
  specifier: string;
  repoRoot: string;
  consumerDir: string;
};

/** Preserve root resolution; isolated consumers avoid package source aliases. */
export const resolvePublishedExport = ({
  specifier,
  repoRoot,
  consumerDir,
}: ResolvePublishedExportOptions): string => {
  const fromRoot = Result.try(() => Bun.resolveSync(specifier, repoRoot));
  return fromRoot.isOk()
    ? fromRoot.value
    : Bun.resolveSync(specifier, consumerDir);
};
