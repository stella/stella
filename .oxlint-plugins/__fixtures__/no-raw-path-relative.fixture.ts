// Suppressed calls exercise every supported Node path import form.

// oxlint-disable-next-line unicorn/import-style -- fixture exercises all path import forms
import path, { relative as relativePath, win32 } from "node:path";
import { relative as posixRelative } from "node:path/posix";
// oxlint-disable-next-line unicorn/import-style, unicorn/prefer-node-protocol -- fixture proves the legacy namespace module entry point
import * as nodePath from "path";
// oxlint-disable-next-line unicorn/prefer-node-protocol -- fixture proves the legacy platform module entry point
import win32Path from "path/win32";

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

const unrelated = { relative: (left: string, right: string) => left + right };
// expect-clean: no-raw-path-relative/no-raw-path-relative
const _unrelatedMember = unrelated.relative(root, file);
const relative = (left: string, right: string) => left + right;
// expect-clean: no-raw-path-relative/no-raw-path-relative
const _shadowedName = relative(root, file);
