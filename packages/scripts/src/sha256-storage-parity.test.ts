import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sha256Hex as nodeSha256Hex } from "@stll/sha256/node";

import { agentCaptureFileSha256 } from "./agent-session";
import { authSpecContentSha256 } from "./auth-md-spec-drift";
import { dockerProjectName } from "./dev-runner";
import { generatedFileHash } from "./prepared-generated-sources";

const INPUTS = [
  "",
  "plain text",
  "Příliš žluťoučký kůň",
  "e\u0301",
  "Článek\u0000📄",
];

for (const text of INPUTS) {
  test(`generated outputs and auth-spec pins preserve Node UTF-8 bytes: ${JSON.stringify(text)}`, () => {
    expect(generatedFileHash(text)).toBe(nodeSha256Hex(text));
    expect(authSpecContentSha256(text)).toBe(nodeSha256Hex(text));
    expect(
      dockerProjectName({
        infraOffset: 17,
        isWorktree: true,
        worktreePath: text,
      }),
    ).toBe(`stella-dev-17-${nodeSha256Hex(text).slice(0, 12)}`);
  });
}

for (const bytes of [
  new Uint8Array(),
  new TextEncoder().encode("Článek\u0000📄"),
  new Uint8Array([255, 0, 128, 13, 10]),
  new Uint8Array([7, 255, 0, 128, 9]).subarray(1, 4),
]) {
  test(`generated file and screenshot attachment identities preserve exact binary ranges: ${JSON.stringify([...bytes])}`, () => {
    const directory = mkdtempSync(path.join(tmpdir(), "script-sha256-parity-"));
    try {
      const file = path.join(directory, "capture.png");
      writeFileSync(file, bytes);
      expect(generatedFileHash(bytes)).toBe(nodeSha256Hex(bytes));
      expect(agentCaptureFileSha256(file)).toBe(nodeSha256Hex(bytes));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
