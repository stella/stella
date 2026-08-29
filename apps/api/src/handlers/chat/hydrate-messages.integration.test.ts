import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { inArray } from "drizzle-orm";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";

import type { SafeDb } from "@/api/db/safe-db";
import { userFiles } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { envBase } from "@/api/env-base";
import { TEXT_PLAIN_MIME_TYPE } from "@/api/handlers/chat/attachment-validation";
import { createChatAttachmentPart } from "@/api/handlers/chat/chat-message-parts";
import type { ChatMessage } from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { toUserFileUrl } from "@/api/lib/user-files/types";
import { XLSX_MIME_TYPE } from "@/api/mime-types";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { hydrateMessages } from "./stream-chat";

// Evidence for the `no-raw-filename-write` waiver in `hydrateMessages`: the
// filename handed to the provider-bound part is the stored `user_files` value,
// which only `uploadUserFile` writes and only after `sanitizeFilename`. The
// attachment part travels with the request and carries its own `filename`
// metadata, so "read-back, not request input" is a claim about which of the two
// the hydrated part uses — and the read-back is itself bounded to the caller's
// own files.

setDefaultTimeout(120_000);

const attachmentBytes = new TextEncoder().encode("Attachment body");
const xlsxBytes = new Uint8Array(
  await Bun.file(
    new URL("../../lib/search/__fixtures__/schedule.xlsx", import.meta.url),
  ).arrayBuffer(),
);

const bucket = envBase.S3_BUCKET;
let fake: FakeS3;

/** How many objects hydration has fetched from the store so far. */
const objectReadCount = (): number =>
  fake.requests.filter(({ method }) => method === "GET").length;

/** A name that must never survive to a provider payload unsanitized. */
const HOSTILE_NAME = '../../etc/passwd";rm -rf /';
const STORED_NAME = sanitizeFilename(HOSTILE_NAME);

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;

const ownFileId = toSafeId<"userFile">(Bun.randomUUIDv7());
const ownXlsxFileId = toSafeId<"userFile">(Bun.randomUUIDv7());
const secondOwnXlsxFileId = toSafeId<"userFile">(Bun.randomUUIDv7());
const foreignFileId = toSafeId<"userFile">(Bun.randomUUIDv7());

const attachmentMessage = (
  fileId: SafeId<"userFile">,
  filename: string,
): ChatMessage =>
  asTestRaw<ChatMessage>({
    id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
    role: "user",
    parts: [
      createChatAttachmentPart({
        filename,
        mimeType: TEXT_PLAIN_MIME_TYPE,
        url: toUserFileUrl(fileId),
      }),
    ],
  });

beforeAll(async () => {
  fake = startFakeS3();
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  safeDb = asTestRaw<SafeDb>(
    createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
  );

  await testDb.insert(userFiles).values([
    {
      id: ownFileId,
      userId: ids.userA1,
      fileName: STORED_NAME,
      mimeType: TEXT_PLAIN_MIME_TYPE,
      sizeBytes: attachmentBytes.byteLength,
      sha256Hex: "a".repeat(64),
      s3Key: `chat/${ids.userA1}/${ownFileId}`,
      threadId: ids.chatThreadWorkspaceA1,
    },
    {
      id: ownXlsxFileId,
      userId: ids.userA1,
      fileName: "schedule.xlsx",
      mimeType: XLSX_MIME_TYPE,
      sizeBytes: xlsxBytes.byteLength,
      sha256Hex: "c".repeat(64),
      s3Key: `chat/${ids.userA1}/${ownXlsxFileId}.xlsx`,
      threadId: ids.chatThreadWorkspaceA1,
    },
    {
      id: secondOwnXlsxFileId,
      userId: ids.userA1,
      fileName: "second-schedule.xlsx",
      mimeType: XLSX_MIME_TYPE,
      sizeBytes: xlsxBytes.byteLength,
      sha256Hex: "d".repeat(64),
      s3Key: `chat/${ids.userA1}/${secondOwnXlsxFileId}.xlsx`,
      threadId: ids.chatThreadWorkspaceA1,
    },
    {
      id: foreignFileId,
      userId: ids.userB1,
      fileName: sanitizeFilename("other-tenant-brief.txt"),
      mimeType: TEXT_PLAIN_MIME_TYPE,
      sizeBytes: attachmentBytes.byteLength,
      sha256Hex: "b".repeat(64),
      s3Key: `chat/${ids.userB1}/${foreignFileId}`,
      threadId: ids.chatThreadWorkspaceB1,
    },
  ]);

  // Every row above is hydrated from its own stored object, so the store holds
  // exactly what `user_files.s3_key` names.
  fake.put(bucket, `chat/${ids.userA1}/${ownFileId}`, attachmentBytes);
  fake.put(bucket, `chat/${ids.userA1}/${ownXlsxFileId}.xlsx`, xlsxBytes);
  fake.put(bucket, `chat/${ids.userA1}/${secondOwnXlsxFileId}.xlsx`, xlsxBytes);
  fake.put(bucket, `chat/${ids.userB1}/${foreignFileId}`, attachmentBytes);
});

afterAll(async () => {
  await testDb
    .delete(userFiles)
    .where(
      inArray(userFiles.id, [
        ownFileId,
        ownXlsxFileId,
        secondOwnXlsxFileId,
        foreignFileId,
      ]),
    );
  fake.stop();
  await releaseRlsFixture();
});

const hydrate = async (message: ChatMessage) =>
  await hydrateMessages({
    messages: [message],
    safeDb,
    sendMode: CHAT_SEND_MODE.rawOverride,
    userId: ids.userA1,
  });

const textOf = (result: Awaited<ReturnType<typeof hydrate>>): string => {
  if (Result.isError(result)) {
    throw result.error;
  }
  return JSON.stringify(result.value);
};

/** Panics travel wrapped, so the reason lives somewhere down the cause chain. */
const causeChainMessages = (thrown: unknown): string[] => {
  const messages: string[] = [];
  let current: unknown = thrown;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages;
};

describe("chat attachment hydration provenance", () => {
  test("names the attachment from the stored row, not from the request part", async () => {
    const hydrated = textOf(
      await hydrate(attachmentMessage(ownFileId, "renamed-by-client.txt")),
    );

    expect(hydrated).toContain(STORED_NAME);
    expect(hydrated).not.toContain("renamed-by-client.txt");
  });

  test("a request part carrying a traversal name cannot reintroduce it", async () => {
    const hydrated = textOf(
      await hydrate(attachmentMessage(ownFileId, HOSTILE_NAME)),
    );

    expect(hydrated).toContain(STORED_NAME);
    expect(hydrated).not.toContain("../../etc/passwd");
  });

  test("hydrates legacy XLSX files and persists their tenant-scoped cache in a batch", async () => {
    const message = asTestRaw<ChatMessage>({
      id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
      role: "user",
      parts: [
        createChatAttachmentPart({
          filename: "schedule.xlsx",
          mimeType: XLSX_MIME_TYPE,
          url: toUserFileUrl(ownXlsxFileId),
        }),
        createChatAttachmentPart({
          filename: "second-schedule.xlsx",
          mimeType: XLSX_MIME_TYPE,
          url: toUserFileUrl(secondOwnXlsxFileId),
        }),
      ],
    });

    const firstHydration = textOf(await hydrate(message));
    expect(firstHydration).toContain("Acme s.r.o.");

    const cachedRows = await testDb
      .select({ extractedText: userFiles.extractedText })
      .from(userFiles)
      .where(inArray(userFiles.id, [ownXlsxFileId, secondOwnXlsxFileId]));
    expect(cachedRows).toHaveLength(2);
    for (const { extractedText } of cachedRows) {
      expect(extractedText).toContain("Acme s.r.o.");
    }

    const readsAfterFirstHydration = objectReadCount();
    const secondHydration = textOf(await hydrate(message));
    expect(secondHydration).toContain("Acme s.r.o.");
    // The cached text served the second hydration: no workbook was refetched.
    expect(objectReadCount()).toBe(readsAfterFirstHydration);
  });

  test("another user's file id hydrates nothing", async () => {
    const rejection = await hydrate(
      attachmentMessage(foreignFileId, "other-tenant-brief.txt"),
    ).then(
      (value) => value,
      (error: unknown) => error,
    );

    expect(causeChainMessages(rejection)).toContain(
      "Persisted chat file reference missing user_files row",
    );
  });
});
