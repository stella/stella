import { describe, expect, test } from "bun:test";

import { ApiRequestError } from "./api-request";
import {
  admitPickedFiles,
  attachmentParts,
  attachmentsSendable,
  base64Bytes,
  CHAT_FILE_MAX_BYTES,
  CHAT_FILES_PER_MESSAGE,
  chatFileMimeType,
  readAttachment,
  readyFiles,
  sendRefusal,
} from "./chat-attachments";
import type { ChatAttachment } from "./chat-attachments";

const DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const counter = () => {
  let next = 0;
  return () => {
    next += 1;
    return `file-${next}`;
  };
};

const reading = (name: string, mimeType: ChatAttachment["mimeType"]) =>
  ({
    id: name,
    uri: `file:///tmp/${name}`,
    name,
    mimeType,
    size: undefined,
    state: { status: "reading" },
  }) satisfies ChatAttachment;

describe("which picked files chat takes", () => {
  test("takes the picker's type when chat takes it, else the name's extension", () => {
    expect(chatFileMimeType("Lease.pdf", "application/pdf")).toBe(
      "application/pdf",
    );
    expect(chatFileMimeType("Notes.TXT", "text/plain; charset=utf-8")).toBe(
      "text/plain",
    );
    expect(chatFileMimeType("Draft.docx", "application/octet-stream")).toBe(
      DOCX,
    );
    expect(chatFileMimeType("Scan.JPEG", undefined)).toBe("image/jpeg");
    expect(chatFileMimeType("setup.exe", "application/x-msdownload")).toBe(
      undefined,
    );
    expect(chatFileMimeType("Contract", null)).toBe(undefined);
  });

  test("adds files to read, leaving out unknown kinds, oversized files and those past the limit", () => {
    const { added, refused } = admitPickedFiles({
      current: [],
      newId: counter(),
      picked: [
        { uri: "file:///a.pdf", name: "a.pdf", mimeType: "application/pdf" },
        { uri: "file:///b.exe", name: "b.exe", mimeType: null },
        {
          uri: "file:///c.pdf",
          name: "c.pdf",
          size: CHAT_FILE_MAX_BYTES + 1,
        },
      ],
    });
    expect(added).toEqual([
      {
        id: "file-1",
        uri: "file:///a.pdf",
        name: "a.pdf",
        mimeType: "application/pdf",
        size: undefined,
        state: { status: "reading" },
      },
    ]);
    // The first reason a file was left out is the one reported.
    expect(refused).toBe("unsupported");
  });

  test("stops at the files one message may carry", () => {
    const current = Array.from(
      { length: CHAT_FILES_PER_MESSAGE - 1 },
      (_, index) => reading(`${index}.pdf`, "application/pdf"),
    );
    const { added, refused } = admitPickedFiles({
      current,
      newId: counter(),
      picked: [
        { uri: "file:///x.png", name: "x.png", mimeType: "image/png", size: 4 },
        { uri: "file:///y.png", name: "y.png", mimeType: "image/png", size: 4 },
      ],
    });
    expect(added.map(({ name }) => name)).toEqual(["x.png"]);
    expect(refused).toBe("too-many");
  });

  test("reports nothing when every file was taken", () => {
    expect(
      admitPickedFiles({
        current: [],
        newId: counter(),
        picked: [{ uri: "file:///a.md", name: "a.md" }],
      }).refused,
    ).toBeUndefined();
  });
});

describe("reading a file into the message", () => {
  test("counts a base64 payload's bytes", () => {
    expect(base64Bytes("")).toBe(0);
    expect(base64Bytes(btoa("a"))).toBe(1);
    expect(base64Bytes(btoa("ab"))).toBe(2);
    expect(base64Bytes(btoa("abc"))).toBe(3);
    expect(base64Bytes(btoa("hello world"))).toBe(11);
  });

  test("sends the bytes under the chat type, whatever type the reader guessed", () => {
    const read = readAttachment(
      reading("Draft.docx", DOCX),
      `data:application/octet-stream;base64,${btoa("PK")}`,
    );
    expect(read).toEqual({
      ...reading("Draft.docx", DOCX),
      size: 2,
      state: { status: "ready", dataUrl: `data:${DOCX};base64,${btoa("PK")}` },
    });
  });

  test("fails a read that gave no base64 data URL", () => {
    const pdf = reading("a.pdf", "application/pdf");
    expect(readAttachment(pdf, undefined)).toEqual({
      ...pdf,
      state: { status: "failed" },
    });
    expect(readAttachment(pdf, "data:application/pdf,%25PDF")).toEqual({
      ...pdf,
      state: { status: "failed" },
    });
  });

  test("refuses a file found too large once its bytes are counted", () => {
    const payload = "A".repeat(Math.ceil((CHAT_FILE_MAX_BYTES + 3) / 3) * 4);
    expect(
      readAttachment(
        reading("big.pdf", "application/pdf"),
        `data:application/pdf;base64,${payload}`,
      ),
    ).toBe("too-large");
  });
});

describe("sending files", () => {
  const ready = (name: string, mimeType: ChatAttachment["mimeType"]) =>
    ({
      ...reading(name, mimeType),
      size: 2,
      state: { status: "ready", dataUrl: `data:${mimeType};base64,QUI=` },
    }) satisfies ChatAttachment;

  test("waits until every file is read, and holds back a failed one", () => {
    expect(attachmentsSendable([])).toBe(true);
    expect(attachmentsSendable([ready("a.pdf", "application/pdf")])).toBe(true);
    expect(
      attachmentsSendable([
        ready("a.pdf", "application/pdf"),
        reading("b.pdf", "application/pdf"),
      ]),
    ).toBe(false);
    expect(
      attachmentsSendable([
        { ...reading("c.pdf", "application/pdf"), state: { status: "failed" } },
      ]),
    ).toBe(false);
  });

  test("builds the parts the web sends: an image or a document carrying its data URL", () => {
    expect(
      attachmentParts(
        readyFiles([
          ready("Stamp.png", "image/png"),
          ready("Lease.pdf", "application/pdf"),
        ]),
      ),
    ).toEqual([
      {
        type: "image",
        source: {
          type: "url",
          value: "data:image/png;base64,QUI=",
          mimeType: "image/png",
        },
        metadata: { filename: "Stamp.png" },
      },
      {
        type: "document",
        source: {
          type: "url",
          value: "data:application/pdf;base64,QUI=",
          mimeType: "application/pdf",
        },
        metadata: { filename: "Lease.pdf" },
      },
    ]);
  });

  test("tells a refused file from a failed send", () => {
    const answered = (status?: number) =>
      new ApiRequestError({ message: "refused", status });
    expect(sendRefusal(answered(422), true)).toBe("file-not-anonymizable");
    expect(sendRefusal(answered(400), true)).toBe("file-refused");
    expect(sendRefusal(answered(413), true)).toBe("file-refused");
    expect(sendRefusal(answered(503), true)).toBe("failed");
    expect(sendRefusal(answered(), true)).toBe("failed");
    // Without files the server refused the message itself.
    expect(sendRefusal(answered(422), false)).toBe("failed");
  });
});
