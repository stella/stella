import { expect, test } from "bun:test";

import { sha256Hex } from "@stll/sha256/node";

import { failureFingerprint } from "./failure-fingerprint";

test("quoted values preserve escaped delimiters and unmatched literal text", () => {
  const fingerprint = (error: string): string =>
    failureFingerprint({ id: "quoted values", error });
  for (const quote of ['"', "'", "`"]) {
    expect(fingerprint(`Expected ${quote}a\\${quote}b${quote}`)).toBe(
      fingerprint("Expected <value>"),
    );
    expect(fingerprint(`Expected ${quote}a\\\\${quote}`)).toBe(
      fingerprint("Expected <value>"),
    );
    expect(fingerprint(`Expected ${quote}unterminated`)).not.toBe(
      fingerprint("Expected <value>"),
    );
    // A failed outer delimiter still permits a different quoted value inside it.
    const inner = quote === '"' ? "'" : '"';
    expect(fingerprint(`Expected ${quote}open ${inner}a${inner}`)).toBe(
      fingerprint(`Expected ${quote}open <value>`),
    );
    for (const terminator of ["\r", "\u2028", "\u2029"]) {
      expect(fingerprint(`${quote}a\\${terminator}${quote}b${quote}`)).toBe(
        fingerprint(`${quote}a\\${terminator}<value>`),
      );
    }
  }
});

test("unterminated escaped quote suffixes finish within a bounded subprocess", () => {
  const source = new URL("failure-fingerprint.ts", import.meta.url).pathname;
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "--eval",
      `import { failureFingerprint } from ${JSON.stringify(source)};
      for (const quote of ['"', "'", '\x60']) {
        const error = quote + ('\\\\' + quote).repeat(250_000);
        const fingerprint = failureFingerprint({ id: "adversarial quotes", error });
        if (!/^[a-f\\d]{16}$/u.test(fingerprint)) process.exit(1);
      }
      console.log("finished");`,
    ],
    timeout: 2000,
    killSignal: "SIGKILL",
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString().trim()).toBe("finished");
});

const storedFingerprintVectors = [
  {
    id: "",
    error: "",
    normalized: "",
    fingerprint: "6e340b9cffb37a98",
  },
  {
    id: "assertion",
    error: "abc",
    normalized: "abc",
    fingerprint: "76a202f07e378883",
  },
  {
    id: "Příliš žluťoučký kůň 📄 中文",
    error: "Článek 📄",
    normalized: "Článek 📄",
    fingerprint: "f70268804a35637b",
  },
  {
    id: "é",
    error: "é",
    normalized: "é",
    fingerprint: "f316c6bf1753c1ee",
  },
  {
    id: "quoted input",
    error: '  Expected "Příliš" to equal 42\nstack ignored',
    normalized: "Expected <value> to equal <value>",
    fingerprint: "fd7821f72af0e4d0",
  },
] as const;

for (const { id, error, normalized, fingerprint } of storedFingerprintVectors) {
  test(`property failure grouping retains normalized NUL-delimited SHA identity: ${JSON.stringify(id)}`, () => {
    expect(failureFingerprint({ id, error })).toBe(fingerprint);
    expect(failureFingerprint({ id, error })).toBe(
      sha256Hex(`${id}\0${normalized}`).slice(0, 16),
    );
  });
}
