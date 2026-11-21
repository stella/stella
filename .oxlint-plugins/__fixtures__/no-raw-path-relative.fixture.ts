// Suppressed calls exercise every supported Node path import form.

// oxlint-disable-next-line unicorn/import-style -- fixture exercises all path import forms
import path, { relative as relativePath, win32 } from "node:path";
import { relative as posixRelative } from "node:path/posix";
// oxlint-disable-next-line unicorn/import-style, unicorn/prefer-node-protocol -- fixture proves the legacy namespace module entry point
import * as nodePath from "path";
// oxlint-disable-next-line unicorn/prefer-node-protocol -- fixture proves the legacy platform module entry point
import win32Path from "path/win32";

import { isPathInside, repoRelativePath } from "@stll/portable-path";

declare const file: string;
declare const root: string;

// oxlint-disable-next-line no-raw-path-relative/no-raw-path-relative -- fixture proves default imports are detected
const _defaultImport = path.relative(root, file);
// oxlint-disable-next-line no-raw-path-relative/no-raw-path-relative -- fixture proves namespace imports are detected
const _namespaceImport = nodePath.relative(root, file);
// oxlint-disable-next-line no-raw-path-relative/no-raw-path-relative -- fixture proves named aliases are detected
const _namedAlias = relativePath(root, file);
// oxlint-disable-next-line no-raw-path-relative/no-raw-path-relative -- fixture proves platform entry-point named imports are detected
const _posixEntryPoint = posixRelative(root, file);
// oxlint-disable-next-line no-raw-path-relative/no-raw-path-relative -- fixture proves platform entry-point default imports are detected
const _win32EntryPoint = win32Path.relative(root, file);
// oxlint-disable-next-line no-raw-path-relative/no-raw-path-relative -- fixture proves platform members are detected
const _platformMember = path.win32.relative(root, file);
// oxlint-disable-next-line no-raw-path-relative/no-raw-path-relative -- fixture proves named platform objects are detected
const _namedPlatform = win32.relative(root, file);
// oxlint-disable-next-line no-raw-path-relative/no-raw-path-relative -- fixture proves native separator escape checks are detected
const _nativeSeparatorEscape = file.startsWith(`..${path.sep}`);
// oxlint-disable-next-line no-raw-path-relative/no-raw-path-relative -- fixture proves platform member separators are detected
const _platformSeparatorEscape = file.startsWith(`..${path.win32.sep}`);
// oxlint-disable-next-line no-raw-path-relative/no-raw-path-relative -- fixture proves Windows literal escape checks are detected
const _windowsLiteralEscape = file === ".." || file.startsWith("..\\");
const relativeMember = path.relative;
// oxlint-disable-next-line no-raw-path-relative/no-raw-path-relative -- fixture proves member aliases are detected
const _memberAlias = relativeMember(root, file);
const { relative: destructuredRelative } = path;
// oxlint-disable-next-line no-raw-path-relative/no-raw-path-relative -- fixture proves destructured aliases are detected
const _destructuredAlias = destructuredRelative(root, file);
const { relative: renamedRelative } = nodePath;
// oxlint-disable-next-line no-raw-path-relative/no-raw-path-relative -- fixture proves renamed destructured aliases are detected
const _renamedDestructuredAlias = renamedRelative(root, file);
const chainedRelative = relativeMember;
// oxlint-disable-next-line no-raw-path-relative/no-raw-path-relative -- fixture proves stable alias chains are detected
const _chainedAlias = chainedRelative(root, file);
const injectedRelative = (
  from: string,
  to: string,
  pathApi: Pick<typeof path, "relative" | "sep"> = path,
): string =>
  // oxlint-disable-next-line no-raw-path-relative/no-raw-path-relative -- fixture proves defaulted path API parameters are detected
  pathApi.relative(from, to).split(pathApi.sep).join("/");
void injectedRelative;

// oxlint-disable-next-line no-raw-path-relative/no-raw-path-relative -- fixture proves direct portable values reject native separators
const _portableSplit = repoRelativePath(root, file).split(path.sep);
const portableRelative = repoRelativePath(root, file);
// oxlint-disable-next-line no-raw-path-relative/no-raw-path-relative -- fixture proves stable portable values reject native separators
const _portableConcatenation = portableRelative + path.sep;

// expect-clean: no-raw-path-relative/no-raw-path-relative
const _portableContainment = isPathInside(root, file);
declare const specifier: string;
// expect-clean: no-raw-path-relative/no-raw-path-relative
const _moduleSpecifier = specifier.startsWith("../");
const nativeAbsolutePath = path.resolve(root, file);
// expect-clean: no-raw-path-relative/no-raw-path-relative
const _nativeSeparator = nativeAbsolutePath.split(path.sep);

const unrelated = { relative: (left: string, right: string) => left + right };
// expect-clean: no-raw-path-relative/no-raw-path-relative
const _unrelatedMember = unrelated.relative(root, file);
const relative = (left: string, right: string) => left + right;
// expect-clean: no-raw-path-relative/no-raw-path-relative
const _shadowedName = relative(root, file);
