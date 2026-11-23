import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { envBase } from "@/api/env-base";
import {
  mailMessage,
  MATTER_CORRESPONDENCE,
  writeMbox,
} from "@/api/tests/fixtures/mbox";
import { type FakeS3, startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { testFileKey } from "@/api/tests/helpers/file-key";

import {
  readStoredMailboxMessage,
  readStoredMailboxPreview,
} from "./mailbox-file";
import { MBOX_MESSAGE_MAX_BYTES, scanMbox } from "./mbox";

const key = testFileKey("user-files/spis-23-C-118-2026");
const fileName = "spis-23-C-118-2026.mbox";
const signal = () => AbortSignal.timeout(10_000);

/** A matter's mailbox, its correspondence repeated `rounds` times. */
const mailbox = (rounds = 1) =>
  writeMbox(
    Array.from({ length: rounds }, () =>
      MATTER_CORRESPONDENCE.map((message) => mailMessage(message)),
    ).flat(),
    "mboxcl2",
  );

let fake: FakeS3;

beforeEach(() => {
  fake = startFakeS3();
});

afterEach(() => {
  fake.stop();
});

const rangesRead = () =>
  fake.requests.flatMap(({ method, range }) =>
    method === "GET" && range !== null ? [range] : [],
  );

describe("a stored mailbox", () => {
  test("lists every message from the streamed object, no message read", async () => {
    const { bytes } = mailbox(40);
    fake.put(envBase.S3_BUCKET, key, bytes, "application/mbox");
    const preview = (
      await readStoredMailboxPreview({ key, fileName, signal: signal() })
    ).unwrap();
    expect(preview.truncated).toBe(false);
    expect(preview.messages).toHaveLength(40 * MATTER_CORRESPONDENCE.length);
    expect(preview.messages.at(-1)).toMatchObject({
      subject: "Vyjádření k žalobě",
      part: { part: `message:${String(preview.messages.length - 1)}` },
    });
    expect(rangesRead()).toEqual([]);
  });

  test("reads one message by exactly its range, as the email it was", async () => {
    const { bytes, expected } = mailbox(5);
    fake.put(envBase.S3_BUCKET, key, bytes, "application/mbox");
    const index = 7;
    const span = scanMbox(bytes).messages[index];
    if (span === undefined) {
      throw new Error("The fixture must hold the message");
    }
    const read = (
      await readStoredMailboxMessage({ key, fileName, index, signal: signal() })
    ).unwrap();
    expect(read.bytes).toEqual(expected[index] ?? new Uint8Array());
    expect(read.entry.fileName).toBe(
      "Re_ Spis 23 C 118_2026, podklady k jednání.eml",
    );
    expect(rangesRead()).toEqual([
      `bytes=${String(span.offset)}-${String(span.offset + span.length - 1)}`,
    ]);
  });

  test("every listed message opens under the name and type its row shows", async () => {
    const { bytes, expected } = mailbox(2);
    fake.put(envBase.S3_BUCKET, key, bytes, "application/mbox");
    const { messages } = (
      await readStoredMailboxPreview({ key, fileName, signal: signal() })
    ).unwrap();
    for (const [index, row] of messages.entries()) {
      const read = (
        await readStoredMailboxMessage({
          key,
          fileName,
          index,
          signal: signal(),
        })
      ).unwrap();
      expect(row.part).toEqual({
        part: `message:${String(index)}`,
        fileName: read.entry.fileName,
        mediaType: "message/rfc822",
        // The size the mailbox stores it at.
        sizeBytes: read.entry.length,
      });
      expect(read.bytes).toEqual(expected[index] ?? new Uint8Array());
    }
  });

  test("a message it does not hold, or one too large, is not read", async () => {
    const big = mailMessage({
      ...MATTER_CORRESPONDENCE[0]!,
      body: `${"Příloha spisu. ".repeat(64)}\n`.repeat(
        Math.ceil(MBOX_MESSAGE_MAX_BYTES / 1024) + 4,
      ),
    });
    const { bytes } = writeMbox([big], "mboxo");
    fake.put(envBase.S3_BUCKET, key, bytes, "application/mbox");
    const tooLarge = await readStoredMailboxMessage({
      key,
      fileName,
      index: 0,
      signal: signal(),
    });
    expect(tooLarge.isErr() && tooLarge.error).toMatchObject({
      type: "unavailable",
      entry: { unavailable: "tooLarge" },
    });
    const missing = await readStoredMailboxMessage({
      key,
      fileName,
      index: 1,
      signal: signal(),
    });
    expect(missing.isErr() && missing.error).toEqual({ type: "noMessage" });
    expect(rangesRead()).toEqual([]);
  });

  test("a stored file that is not a mailbox is refused", async () => {
    fake.put(
      envBase.S3_BUCKET,
      key,
      mailMessage(MATTER_CORRESPONDENCE[0]!),
      "application/mbox",
    );
    const preview = await readStoredMailboxPreview({
      key,
      fileName,
      signal: signal(),
    });
    expect(preview.isErr() && preview.error._tag).toBe("MboxParseError");
  });
});
