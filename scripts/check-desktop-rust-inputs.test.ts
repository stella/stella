import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  checkDesktopRustInputs,
  extractIncludeMacroCalls,
  resolveEmbedPath,
} from "./check-desktop-rust-inputs.ts";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

const write = (root: string, file: string, contents: string) => {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
};

/** Mirrors scripts/detect-tauri-rust-changes.sh's real case patterns. */
const DETECTOR_SCRIPT_SOURCE = `#!/usr/bin/env bash
set -euo pipefail

desktop_rust_checks_required=false

for file in "$@"; do
  case "$file" in
    apps/desktop/src-tauri/*|apps/desktop/fixtures/*|apps/desktop/src/i18n/langs/*|apps/desktop/src/clipboard/clipboard-types.ts|packages/api-contract/src/desktop-account-policy.json|packages/api-contract/src/desktop-edit-file-types.ts|packages/api-contract/src/desktop-rpc.gen.ts)
      desktop_rust_checks_required=true
      break
      ;;
  esac
done

echo "$desktop_rust_checks_required"
`;

type Fixture = {
  readonly nativeTestInputs: readonly string[];
  readonly rustFiles: Record<string, string>;
  readonly extraFiles?: Record<string, string>;
};

/** A miniature repository: one crate directory and a turbo.json task. */
const createRoot = ({
  extraFiles,
  nativeTestInputs,
  rustFiles,
}: Fixture): string => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-desktop-rust-inputs-"));
  roots.push(root);

  write(
    root,
    "turbo.json",
    JSON.stringify({
      tasks: {
        "@stll/desktop#test:native": { inputs: nativeTestInputs },
      },
    }),
  );
  write(root, "scripts/detect-tauri-rust-changes.sh", DETECTOR_SCRIPT_SOURCE);
  for (const [file, contents] of Object.entries(rustFiles)) {
    write(root, `apps/desktop/src-tauri/${file}`, contents);
  }
  for (const [file, contents] of Object.entries(extraFiles ?? {})) {
    write(root, file, contents);
  }
  return root;
};

describe("extractIncludeMacroCalls", () => {
  test("extracts a literal on the line after the opening paren", () => {
    const calls = extractIncludeMacroCalls(
      'const X: &str = include_str!(\n  "../../fixtures/thing.json"\n);\n',
    );

    expect(calls).toEqual([
      {
        kind: "literal",
        line: 1,
        literal: "../../fixtures/thing.json",
        macro: "include_str!",
      },
    ]);
  });

  test("extracts a literal on the same line, for both macros", () => {
    const calls = extractIncludeMacroCalls(
      'const A: &str = include_str!("a.json");\n' +
        'const B: &[u8] = include_bytes!("b.bin");\n',
    );

    expect(calls).toEqual([
      { kind: "literal", line: 1, literal: "a.json", macro: "include_str!" },
      { kind: "literal", line: 2, literal: "b.bin", macro: "include_bytes!" },
    ]);
  });

  test("reports a non-literal argument instead of skipping it", () => {
    const calls = extractIncludeMacroCalls(
      'const X: &str = include_str!(concat!("a", "b"));\n',
    );

    expect(calls).toEqual([
      { kind: "non-literal", line: 1, macro: "include_str!" },
    ]);
  });

  test("does not mistake a quote char literal for a string opening", () => {
    // `'"'` used to desync the scanner: everything after it was read as one
    // unterminated string, hiding the real include_str! call that follows.
    const calls = extractIncludeMacroCalls(
      'let quote = \'"\';\nconst X: &str = include_str!("a.json");\n',
    );

    expect(calls).toEqual([
      { kind: "literal", line: 2, literal: "a.json", macro: "include_str!" },
    ]);
  });

  test("ignores a macro name mentioned only in a comment", () => {
    const calls = extractIncludeMacroCalls(
      "// embedded with `include_str!` (path relative to this file)\n" +
        'const X: &str = include_str!("a.json");\n',
    );

    expect(calls).toEqual([
      { kind: "literal", line: 2, literal: "a.json", macro: "include_str!" },
    ]);
  });
});

describe("resolveEmbedPath", () => {
  test("resolves relative to the including file's directory", () => {
    expect(
      resolveEmbedPath(
        "apps/desktop/src-tauri/src/i18n.rs",
        "../../src/i18n/langs/en.json",
      ),
    ).toBe("apps/desktop/src/i18n/langs/en.json");
  });
});

describe("checkDesktopRustInputs", () => {
  test("passes when every embed is covered, matched, and detected", () => {
    const root = createRoot({
      extraFiles: { "apps/desktop/fixtures/thing.json": "{}\n" },
      nativeTestInputs: ["src-tauri/**", "fixtures/**"],
      rustFiles: {
        "src/lib.rs":
          'const X: &str = include_str!("../../fixtures/thing.json");\n',
      },
    });

    expect(checkDesktopRustInputs(root)).toEqual([]);
  });

  test("reports an embed no input covers", () => {
    const root = createRoot({
      extraFiles: { "apps/desktop/fixtures/thing.json": "{}\n" },
      nativeTestInputs: ["src-tauri/**"],
      rustFiles: {
        "src/lib.rs":
          'const X: &str = include_str!("../../fixtures/thing.json");\n',
      },
    });
    const errors = checkDesktopRustInputs(root);

    expect(errors).toHaveLength(1);
    expect(errors.at(0)).toContain(
      'embeds "apps/desktop/fixtures/thing.json" from outside the crate, which no @stll/desktop#test:native input covers',
    );
  });

  test("reports an input no embed falls under any more", () => {
    const root = createRoot({
      nativeTestInputs: ["src-tauri/**", "fixtures/**"],
      rustFiles: { "src/lib.rs": "pub fn noop() {}\n" },
    });
    const errors = checkDesktopRustInputs(root);

    expect(errors).toHaveLength(1);
    expect(errors.at(0)).toContain(
      'declares "fixtures/**", which no include_str!/include_bytes! embed falls under any more',
    );
  });

  test("never flags src-tauri/** itself as stale", () => {
    const root = createRoot({
      nativeTestInputs: ["src-tauri/**"],
      rustFiles: { "src/lib.rs": "pub fn noop() {}\n" },
    });

    expect(checkDesktopRustInputs(root)).toEqual([]);
  });

  test("reports a non-literal macro argument", () => {
    const root = createRoot({
      nativeTestInputs: ["src-tauri/**"],
      rustFiles: {
        "src/lib.rs": 'const X: &str = include_str!(concat!("a", "b"));\n',
      },
    });
    const errors = checkDesktopRustInputs(root);

    expect(errors).toHaveLength(1);
    expect(errors.at(0)).toContain(
      "argument that is not a plain string literal",
    );
  });

  test("the real repository passes", () => {
    const repoRoot = path.resolve(import.meta.dirname, "..");

    expect(checkDesktopRustInputs(repoRoot)).toEqual([]);
  });
});
