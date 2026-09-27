import { describe, expect, test } from "bun:test";

import {
  decideAttachable,
  ghSupportsAttach,
  isSealTrusted,
  parseCaptureLog,
  parseSealStatus,
  verifyAttachment,
  type ManifestEntry,
} from "./agent-evidence";

const EVIDENCE_DIR = "/work/.stella-dev/evidence";
const SHOT = `${EVIDENCE_DIR}/run/matter.png`;

const record = (url = "http://localhost:3269/workspaces") => ({
  label: "matter",
  path: SHOT,
  sha256: "abc",
  textEntered: false,
  url,
});

const entry = (overrides: Partial<ManifestEntry> = {}): ManifestEntry => ({
  ...record(),
  attachable: true,
  capturedAt: "2026-09-27T07:00:00.000Z",
  reason: null,
  ...overrides,
});

describe("parseSealStatus", () => {
  test("reads the last line the seal script prints", () => {
    expect(parseSealStatus('noise\n{"status":"pristine"}\n')).toEqual({
      status: "pristine",
    });
    expect(
      parseSealStatus('{"status":"modified","tables":["public.entities"]}'),
    ).toEqual({ status: "modified", tables: ["public.entities"] });
  });

  test("returns null for anything else", () => {
    expect(parseSealStatus("")).toBeNull();
    expect(parseSealStatus('{"status":"clean"}')).toBeNull();
    expect(parseSealStatus('{"status":"modified"}')).toBeNull();
  });
});

describe("parseCaptureLog", () => {
  test("reads one record per line", () => {
    expect(parseCaptureLog(`${JSON.stringify(record())}\n\n`)).toEqual([
      record(),
    ]);
  });
});

describe("decideAttachable", () => {
  const pristine = { status: "pristine" } as const;
  const modified = {
    status: "modified",
    tables: ["public.entities"],
  } as const;

  test("attaches a local capture of a stack pristine on both sides", () => {
    expect(
      decideAttachable({ after: pristine, before: pristine, record: record() }),
    ).toEqual({ attachable: true, reason: null });
  });

  test("refuses when content appeared before or during the capture", () => {
    for (const [before, after] of [
      [modified, pristine],
      [pristine, modified],
    ] as const) {
      const decision = decideAttachable({ after, before, record: record() });
      expect(decision.attachable).toBe(false);
      expect(decision.reason).toContain("public.entities");
    }
  });

  test("refuses a capture taken after text was entered", () => {
    const decision = decideAttachable({
      after: pristine,
      before: pristine,
      record: { ...record(), textEntered: true },
    });
    expect(decision.attachable).toBe(false);
    expect(decision.reason).toContain("text was entered");
  });

  test("refuses a stack that was never seeded", () => {
    expect(
      decideAttachable({
        after: { status: "fresh" },
        before: { status: "fresh" },
        record: record(),
      }).attachable,
    ).toBe(false);
  });

  test("refuses an unsealed stack and a non-local page", () => {
    expect(
      decideAttachable({
        after: pristine,
        before: { status: "unsealed" },
        record: record(),
      }).attachable,
    ).toBe(false);
    expect(
      decideAttachable({
        after: pristine,
        before: pristine,
        record: record("https://example.com/"),
      }).attachable,
    ).toBe(false);
  });
});

describe("verifyAttachment", () => {
  test("accepts an unaltered attachable capture", () => {
    expect(
      verifyAttachment({
        evidenceDir: EVIDENCE_DIR,
        filePath: SHOT,
        fileSha256: "abc",
        manifest: [entry()],
      }),
    ).toEqual({ type: "ok", entry: entry() });
  });

  test.each([
    [
      "a file outside the evidence directory",
      "/Users/me/Downloads/x.png",
      "abc",
      [entry()],
    ],
    ["a file with no record", `${EVIDENCE_DIR}/other.png`, "abc", [entry()]],
    ["a file edited after capture", SHOT, "def", [entry()]],
    [
      "a capture recorded as not attachable",
      SHOT,
      "abc",
      [entry({ attachable: false, reason: "modified" })],
    ],
  ] as const)("refuses %s", (_label, filePath, fileSha256, manifest) => {
    expect(
      verifyAttachment({
        evidenceDir: EVIDENCE_DIR,
        filePath,
        fileSha256,
        manifest,
      }).type,
    ).toBe("refused");
  });

  test("uses the latest record when a path was captured twice", () => {
    expect(
      verifyAttachment({
        evidenceDir: EVIDENCE_DIR,
        filePath: SHOT,
        fileSha256: "abc",
        manifest: [entry(), entry({ attachable: false, reason: "modified" })],
      }).type,
    ).toBe("refused");
  });
});

describe("ghSupportsAttach", () => {
  test.each([
    ["gh version 2.101.0 (2026-09-15)", true],
    ["gh version 2.102.3 (2026-10-01)", true],
    ["gh version 3.0.0 (2027-01-01)", true],
    ["gh version 2.100.9 (2026-08-01)", false],
    ["not gh", false],
  ])("%s -> %s", (output, expected) => {
    expect(ghSupportsAttach(output)).toBe(expected);
  });
});

describe("isSealTrusted", () => {
  test("trusts only a fresh database or one still matching its seal", () => {
    expect(isSealTrusted({ status: "fresh" })).toBe(true);
    expect(isSealTrusted({ status: "pristine" })).toBe(true);
    expect(isSealTrusted({ status: "unsealed" })).toBe(false);
    expect(
      isSealTrusted({ status: "modified", tables: ["public.entities"] }),
    ).toBe(false);
    expect(isSealTrusted(null)).toBe(false);
  });
});
