import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES,
  chatLocalRunImageType,
  parseChatLocalRunConversation,
} from "@stll/api-contract/chat-local-run-step-output";
import { assertProperty } from "@stll/property-testing";

import { SubagentConversation } from "../harness/step-output";
import {
  keepStepOutput,
  keptStepImage,
  keptStepText,
  stepOutputFile,
  stepOutputPath,
} from "./step-outputs";

const read = (file: ReturnType<typeof stepOutputFile>) => {
  const newline = file.indexOf(0x0a);
  const header: unknown = JSON.parse(
    new TextDecoder().decode(file.subarray(0, newline)),
  );
  return { header, kept: file.subarray(newline + 1) };
};

describe("a kept step output", () => {
  test("names how much the step produced and keeps a whole-character prefix within the cap", () => {
    assertProperty(
      "names how much the step produced and keeps a whole-character prefix within the cap",
      fc.property(
        fc.string({ unit: "grapheme", maxLength: 40 }),
        fc.integer({ min: 0, max: 3 }),
        (unit, padding) => {
          // Long enough to cross the cap at any offset of a multi-byte unit.
          const text = `${"x".repeat(CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES - padding)}${unit.repeat(4)}`;
          const bytes = new TextEncoder().encode(text);
          const { header, kept } = read(stepOutputFile(keptStepText(text)));
          expect(header).toEqual({ bytes: bytes.length });
          expect(kept.length).toBeLessThanOrEqual(
            CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES,
          );
          expect(bytes.subarray(0, kept.length)).toEqual(kept);
          const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
            kept,
          );
          expect(text.startsWith(decoded)).toBe(true);
        },
      ),
      { numRuns: 20 },
    );
  });

  test("keeps a short output whole", () => {
    const { header, kept } = read(stepOutputFile(keptStepText("ok\n")));
    expect(header).toEqual({ bytes: 3 });
    expect(new TextDecoder().decode(kept)).toBe("ok\n");
  });
});

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const WEBP = [
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
];

/** A folder of its own for one test's files, removed after `use`. */
const inFolder = async <T>(run: (folder: string) => Promise<T>): Promise<T> => {
  const folder = mkdtempSync(path.join(tmpdir(), "step-outputs-"));
  try {
    return await run(folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
};

describe("a subagent's conversation kept on the computer", () => {
  test("holds no more than a step may keep, counts the rest, and keeps what it was told and reported first", () => {
    assertProperty(
      "holds no more than a step may keep, counts the rest, and keeps what it was told and reported first",
      fc.property(
        fc.array(
          fc.oneof(
            fc.string({ unit: "grapheme", maxLength: 200 }),
            // Long enough that a few of them cross the bound.
            fc
              .integer({ min: 1, max: 4 })
              .map((quarters) =>
                "x".repeat(
                  (quarters * CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES) / 4,
                ),
              ),
          ),
          { maxLength: 12 },
        ),
        (written) => {
          const held = new SubagentConversation();
          for (const text of written) {
            held.add(text);
          }
          const { entries, droppedBytes } = held.ended({
            prompt: "List the arrears clauses.",
            report: "Clause 4.",
          });
          const bytes = (text: string) => new TextEncoder().encode(text).length;
          const messages = entries.flatMap(({ role, text }) =>
            role === "message" ? [text] : [],
          );
          const heldBytes = messages.reduce(
            (sum, text) => sum + bytes(text),
            0,
          );
          expect(heldBytes).toBeLessThanOrEqual(
            CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES,
          );
          // Nothing it wrote is lost from the count, and what is held is
          // what it wrote, in order.
          expect(heldBytes + droppedBytes).toBe(
            written.reduce((sum, text) => sum + bytes(text), 0),
          );
          const nonEmpty = written.filter((text) => text !== "");
          expect(nonEmpty).toEqual(expect.arrayContaining(messages));
          expect(entries.slice(0, 2)).toEqual([
            { role: "prompt", text: "List the arrears clauses." },
            { role: "report", text: "Clause 4." },
          ]);
        },
      ),
      { numRuns: 30 },
    );
  });

  test("is kept as a line per entry within the cap, and reads back whole up to the cut", async () => {
    await inFolder(async (stepOutputDir) => {
      const held = new SubagentConversation();
      held.add("Clause 4 covers arrears.\nClause 9 does not.");
      // Held, but with the entries before it more than a step keeps: the
      // file is cut inside this entry.
      held.add("y".repeat(CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES - 100));
      const output = held.ended({
        prompt: "List the arrears clauses.",
        report: "Clause 4.",
      });
      const runId = "0b6f5c8e-2d3a-4f1b-9c7e-5a4d3b2c1e0f";
      const kept = await keepStepOutput({
        stepOutputDir,
        workspaceDir: stepOutputDir,
        runId,
        toolCallId: "call-agent",
        output,
      });
      expect(kept.isOk()).toBe(true);
      const file = new Uint8Array(
        readFileSync(
          stepOutputPath({ stepOutputDir, runId, toolCallId: "call-agent" }),
        ),
      );
      const { header, kept: body } = read(file);
      expect(body.length).toBe(CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES);
      expect(header).toEqual({
        bytes: new TextEncoder().encode(
          output.entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
        ).length,
      });
      expect(
        parseChatLocalRunConversation(new TextDecoder().decode(body)),
      ).toEqual([
        { role: "prompt", text: "List the arrears clauses." },
        { role: "report", text: "Clause 4." },
        {
          role: "message",
          text: "Clause 4 covers arrears.\nClause 9 does not.",
        },
      ]);
    });
  });

  test("what it was told and what it reported each fit whatever their length, so neither is the line the cap cuts", () => {
    // Longer than a step keeps, ending in a character of several bytes.
    const long = `${"z".repeat(CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES)}\u00E9\u{1F4C4}`;
    const output = new SubagentConversation().ended({
      prompt: long,
      report: long,
    });
    const bytes = (text: string) => new TextEncoder().encode(text).length;
    const [told, reported] = output.entries;
    expect(output.entries.map(({ role }) => role)).toEqual([
      "prompt",
      "report",
    ]);
    for (const entry of [told, reported]) {
      const text = entry?.text ?? "";
      expect(long.startsWith(text)).toBe(true);
      expect(bytes(text)).toBeLessThanOrEqual(
        CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES / 4,
      );
      expect(bytes(text)).toBeGreaterThan(0);
    }
    // What was left out is counted, and both entries read back from the
    // kept file.
    expect(output.droppedBytes).toBe(
      2 * bytes(long) - bytes(told?.text ?? "") - bytes(reported?.text ?? ""),
    );
    const { kept } = keptStepText(
      output.entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
    );
    expect(
      parseChatLocalRunConversation(new TextDecoder().decode(kept)).map(
        ({ role }) => role,
      ),
    ).toEqual(["prompt", "report"]);
  });

  test("is kept under its own run: the same step of another run is another file", () => {
    const stepOutputDir = "/data/runs/chat.step-outputs";
    const first = stepOutputPath({
      stepOutputDir,
      runId: "0b6f5c8e-2d3a-4f1b-9c7e-5a4d3b2c1e0f",
      toolCallId: "call-agent",
    });
    const second = stepOutputPath({
      stepOutputDir,
      runId: "1c7a6d9f-3e4b-4a2c-8d6f-6b5e4c3d2f1a",
      toolCallId: "call-agent",
    });
    expect(path.dirname(first)).toBe(
      path.join(stepOutputDir, "0b6f5c8e-2d3a-4f1b-9c7e-5a4d3b2c1e0f"),
    );
    expect(path.dirname(second)).not.toBe(path.dirname(first));
    expect(path.basename(second)).not.toBe(path.basename(first));
  });
});

describe("an image a step viewed, kept on the computer", () => {
  test("is kept whole when its bytes are an image's and within the cap, whatever the file is called, and not at all otherwise", async () => {
    await inFolder(async (folder) => {
      await assertProperty(
        "is kept whole when its bytes are an image's and within the cap, whatever the file is called, and not at all otherwise",
        fc.asyncProperty(
          fc.constantFrom(PNG, JPEG, GIF, WEBP, []),
          fc.uint8Array({ maxLength: 64 }),
          fc.constantFrom("scan.png", "scan.txt", "scan"),
          async (signature, rest, name) => {
            const bytes = new Uint8Array([...signature, ...rest]);
            writeFileSync(path.join(folder, name), bytes);
            const kept = await keptStepImage(name, folder);
            if (chatLocalRunImageType(bytes) === null) {
              expect(kept).toBeNull();
              return;
            }
            expect(kept).toEqual({ totalBytes: bytes.length, kept: bytes });
          },
        ),
        { numRuns: 60 },
      );
    });
  });

  test("past the cap keeps only its size, and a name that is no file keeps nothing", async () => {
    await inFolder(async (folder) => {
      const large = new Uint8Array(CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES + 1);
      large.set(PNG);
      writeFileSync(path.join(folder, "large.png"), large);
      expect(await keptStepImage("large.png", folder)).toEqual({
        totalBytes: large.length,
        kept: new Uint8Array(),
      });
      // At the cap exactly, an image is still kept whole.
      const atCap = large.subarray(0, CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES);
      writeFileSync(path.join(folder, "at-cap.png"), atCap);
      expect((await keptStepImage("at-cap.png", folder))?.kept.length).toBe(
        CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES,
      );
      // A folder is no image; neither is a text file named like one.
      expect(await keptStepImage(".", folder)).toBeNull();
      writeFileSync(path.join(folder, "notes.png"), "<svg onload=alert(1)>");
      expect(await keptStepImage("notes.png", folder)).toBeNull();
    });
  });

  // A named pipe has no counterpart to make on Windows.
  test.skipIf(process.platform === "win32")(
    "a pipe named like an image is not waited on, and keeps nothing",
    async () => {
      await inFolder(async (folder) => {
        const pipe = path.join(folder, "pipe.png");
        expect(Bun.spawnSync(["mkfifo", pipe]).exitCode).toBe(0);
        // Nothing ever writes to it: an open that waited would never return.
        expect(await keptStepImage("pipe.png", folder)).toBeNull();
      });
    },
  );

  test("a step that viewed no image writes no file, and one that did keeps the image's own bytes", async () => {
    await inFolder(async (folder) => {
      const stepOutputDir = path.join(folder, "chat.step-outputs");
      const runId = "0b6f5c8e-2d3a-4f1b-9c7e-5a4d3b2c1e0f";
      const image = new Uint8Array([...PNG, 1, 2, 3]);
      writeFileSync(path.join(folder, "page.png"), image);
      writeFileSync(path.join(folder, "notes.png"), "not an image");
      const keep = async (toolCallId: string, file: string) =>
        await keepStepOutput({
          stepOutputDir,
          workspaceDir: folder,
          runId,
          toolCallId,
          output: { type: "image", path: file },
        });
      expect((await keep("call-image", "page.png")).isOk()).toBe(true);
      expect((await keep("call-notes", "notes.png")).isOk()).toBe(true);
      // A file that is gone is a step with nothing kept, not a failed run.
      expect((await keep("call-gone", "gone.png")).isErr()).toBe(true);
      const kept = read(
        new Uint8Array(
          readFileSync(
            stepOutputPath({ stepOutputDir, runId, toolCallId: "call-image" }),
          ),
        ),
      );
      expect(kept.header).toEqual({ bytes: image.length });
      expect(kept.kept).toEqual(image);
      for (const toolCallId of ["call-notes", "call-gone"]) {
        expect(
          existsSync(stepOutputPath({ stepOutputDir, runId, toolCallId })),
        ).toBe(false);
      }
      // A step reported again with nothing to keep leaves no earlier image.
      writeFileSync(path.join(folder, "page.png"), "no longer an image");
      expect((await keep("call-image", "page.png")).isOk()).toBe(true);
      expect(
        existsSync(
          stepOutputPath({ stepOutputDir, runId, toolCallId: "call-image" }),
        ),
      ).toBe(false);
    });
  });
});
