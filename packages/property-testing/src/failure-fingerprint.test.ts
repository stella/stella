import { expect, test } from "bun:test";

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
