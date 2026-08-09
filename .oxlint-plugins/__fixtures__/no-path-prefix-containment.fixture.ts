// Passive regression fixture for
// `no-path-prefix-containment/no-path-prefix-containment`.
//
// Suppressed lines are unsafe containment checks the rule must flag. If the
// detector regresses, unused-disable reporting fails CI. Unsuppressed lines
// cover boundary-aware checks, URLs, unrelated strings, and fake or shadowed
// path helpers; any false positive fails the same fixture run.

// oxlint-disable-next-line unicorn/import-style -- fixture verifies named Node path import provenance
import path, {
  normalize as normalizePath,
  resolve as resolvePath,
  win32,
} from "node:path";

declare const candidate: string;
declare const domain: string;
declare const root: string;
declare const url: string;

// `/safe/root-backup` passes this bare prefix check for `/safe/root`.
// oxlint-disable-next-line no-path-prefix-containment/no-path-prefix-containment -- fixture proves a sibling path can bypass a bare root prefix
const _directResolve = path.resolve(root, candidate).startsWith(root);

// `join` also normalizes `..`, so a sibling can pass the same prefix check.
// oxlint-disable-next-line no-path-prefix-containment/no-path-prefix-containment -- fixture proves path.join retains rooted path provenance
const _directJoin = path.join(root, candidate).startsWith(root);

const resolvedRoot = path.resolve("/safe/root");
const resolvedCandidate = path.resolve(resolvedRoot, "../root-backup");
// oxlint-disable-next-line no-path-prefix-containment/no-path-prefix-containment -- fixture proves aliases retain Node path provenance
const _aliasedResolve = resolvedCandidate.startsWith(resolvedRoot);

// Independently normalized paths remain unsafe when compared as strings.
// oxlint-disable-next-line no-path-prefix-containment/no-path-prefix-containment -- fixture proves named Node path imports are tracked
const _normalized = normalizePath(candidate).startsWith(normalizePath(root));

// Windows has the same sibling-prefix problem with backslash-separated paths.
const windowsRoot = "C:\\safe\\root";
// oxlint-disable-next-line no-path-prefix-containment/no-path-prefix-containment -- fixture proves win32 path APIs and separators are understood
const _windows = win32
  .resolve(windowsRoot, "..\\root-backup")
  .startsWith(windowsRoot);

// Computed static member access cannot bypass the rule.
// oxlint-disable-next-line no-path-prefix-containment/no-path-prefix-containment, typescript/dot-notation -- fixture proves computed startsWith access is covered
const _computed = resolvePath(root, candidate)["startsWith"](root);

// --- Allowed: boundary-aware containment checks. ---

const rootWithSeparator = resolvedRoot.endsWith(path.sep)
  ? resolvedRoot
  : `${resolvedRoot}${path.sep}`;
const _separatorBoundary = resolvedCandidate.startsWith(rootWithSeparator);
const _inlineSeparatorBoundary = resolvedCandidate.startsWith(
  `${resolvedRoot}${path.sep}`,
);
const _windowsSeparatorBoundary = win32
  .resolve(windowsRoot, candidate)
  .startsWith(`${windowsRoot}${win32.sep}`);

const relativeCandidate = path.relative(resolvedRoot, resolvedCandidate);
const _relativeBoundary =
  relativeCandidate !== "" &&
  relativeCandidate !== ".." &&
  !relativeCandidate.startsWith(`..${path.sep}`) &&
  !path.isAbsolute(relativeCandidate);

declare const isPathInside: (
  rootPath: string,
  candidatePath: string,
) => boolean;
const _boundaryHelper = isPathInside(resolvedRoot, resolvedCandidate);

// Generic string and URL prefix checks have no Node path provenance.
const _domainPrefix = domain.startsWith("docs.");
const _urlPrefix = url.startsWith("https://");

// Same-named APIs from another module are not Node path operations.
declare const normalize: (value: string) => string;
declare const resolve: (...parts: string[]) => string;
const _fakeNormalize = normalize(candidate).startsWith(normalize(root));
const _fakeResolve = resolve(root, candidate).startsWith(root);

// A local binding shadowing the genuine named import loses its provenance.
const checkWithShadowedResolve = (
  localResolvePath: (...parts: string[]) => string,
) => localResolvePath(root, candidate).startsWith(root);

export const noPathPrefixContainmentFixture = {
  _aliasedResolve,
  _boundaryHelper,
  _computed,
  _directJoin,
  _directResolve,
  _domainPrefix,
  _fakeNormalize,
  _fakeResolve,
  _inlineSeparatorBoundary,
  _normalized,
  _relativeBoundary,
  _separatorBoundary,
  _urlPrefix,
  _windows,
  _windowsSeparatorBoundary,
  checkWithShadowedResolve,
};
