/**
 * A recording transcription reads its recording under its requester's
 * current access, so nothing from a matter the requester can no longer open
 * reaches the transcription model. Driven against a real (PGlite) database,
 * an in-process object store and the real recording reader; the model and the
 * transcript document write are fakes.
 */

import { panic, Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import { member } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { recordingTranscriptionRuns, workspaceMembers } from "@/api/db/schema";
import type { RlsDatabase } from "@/api/db/scoped";
import * as dictation from "@/api/handlers/dictation/transcribe";
import * as aiConfigLoader from "@/api/lib/ai-config-loader";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import { DEFAULT_MANAGED_AI_RESIDENCY } from "@/api/lib/chat/ai-data-policy";
import { authorizeBufferWrite } from "@/api/lib/entities/buffer-write-authority";
import * as entityWriter from "@/api/lib/entities/create-from-buffer";
import { createFileKey } from "@/api/lib/files/utils";
import { processRecordingTranscriptionRun } from "@/api/lib/recording-transcription/run-queue";
import { createRootRunActor } from "@/api/lib/root-scoped-db";
import type { RootRunActor } from "@/api/lib/root-scoped-db";
import { brandPersistedRecordingTranscriptionRunId } from "@/api/lib/safe-id-boundaries";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

import { openRecordingReader } from "./recording-reader";
import { toneWav } from "./tone-wav.test-helper";

const BUCKET = process.env["S3_BUCKET"] ?? "stella";

type RlsFixture = Awaited<ReturnType<typeof getRlsFixture>>;
type OrganizationMember = typeof member.$inferSelect;
type MatterMember = typeof workspaceMembers.$inferSelect;

const fakeS3 = startFakeS3();
const runId = createSafeId<"recordingTranscriptionRun">();

let testDb: RlsFixture["testDb"];
let ids: RlsFixture["ids"];
let originalOrganizationMember: OrganizationMember;
let originalMatterMembers: MatterMember[];
let sourceKey: string;
let actor: RootRunActor<"recordingTranscriptionRun">;

beforeAll(async () => {
  ({ testDb, ids } = await getRlsFixture());
  const database = asTestRaw<RlsDatabase<Transaction>>(testDb);

  const organizationMember = (
    await testDb
      .select()
      .from(member)
      .where(eq(member.id, ids.memberA1org))
      .limit(1)
  ).at(0);
  // Leaving the organization also ends every matter membership in it, so the
  // restore covers all of them, not only the one a test removes directly.
  originalMatterMembers = await testDb.query.workspaceMembers.findMany({
    where: {
      userId: { eq: ids.userA1 },
      workspaceId: { in: [ids.wsA1, ids.wsA2] },
    },
  });
  if (!organizationMember || originalMatterMembers.length === 0) {
    panic("Transcription run fixture is incomplete");
  }
  originalOrganizationMember = organizationMember;

  // The fixture's file row is a DOCX; the run pins the file, and the reader
  // knows a recording by its bytes and the run's file name.
  sourceKey = createFileKey({
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    fileId: ids.fileObjectA1,
    mimeType: DOCX_MIME_TYPE,
  });
  fakeS3.put(BUCKET, sourceKey, toneWav(30), DOCX_MIME_TYPE);

  actor = createRootRunActor(
    {
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      runId,
    },
    brandPersistedRecordingTranscriptionRunId,
    database,
  );
});

const outputEntityId = createSafeId<"entity">();

type SpyOn<T extends object, K extends keyof T> = ReturnType<
  typeof spyOn<T, K>
>;
let settingsSpy: SpyOn<typeof aiConfigLoader, "loadOrgSettingsForAuth">;
let transcribeSpy: SpyOn<typeof dictation, "executeDictation">;
let writeSpy: SpyOn<typeof entityWriter, "createEntityFromBuffer">;

const speechPieceIndices = async (
  bytes: Uint8Array,
  extension: string,
): Promise<number[]> => {
  const reader = await openRecordingReader({
    bytes: bytes.slice().buffer,
    extension,
  });
  if (Result.isError(reader)) {
    panic("The fixture recording is unreadable");
  }
  const indices: number[] = [];
  try {
    for (;;) {
      const read = await reader.value.next();
      if (Result.isError(read)) {
        panic("The fixture recording stopped reading");
      }
      if (read.value === null) {
        return indices;
      }
      if (read.value.speech) {
        indices.push(read.value.index);
      }
    }
  } finally {
    await reader.value.close();
  }
};

const readRun = async () =>
  (
    await testDb
      .select()
      .from(recordingTranscriptionRuns)
      .where(eq(recordingTranscriptionRuns.id, runId))
      .limit(1)
  ).at(0);

const sourceReads = () =>
  fakeS3.requests.filter(
    (request) => request.method === "GET" && request.key === sourceKey,
  );

beforeEach(async () => {
  settingsSpy = spyOn(aiConfigLoader, "loadOrgSettingsForAuth");
  transcribeSpy = spyOn(dictation, "executeDictation");
  writeSpy = spyOn(entityWriter, "createEntityFromBuffer");
  settingsSpy.mockImplementation(async () => ({
    orgAIConfig: null,
    orgAIConfigStatus: "ok",
    promptCachingEnabled: false,
    managedAIResidency: DEFAULT_MANAGED_AI_RESIDENCY,
  }));
  transcribeSpy.mockImplementation(async () =>
    Result.ok({
      text: "Spoken words.",
      segments: [],
      detectedLanguage: "en",
      durationMs: 1000,
      modelId: "test",
      vocabulary: "not-supported",
    }),
  );
  writeSpy.mockImplementation(async (input) => {
    const created = {
      entityId: outputEntityId,
      entityVersionId: createSafeId<"entityVersion">(),
      fieldId: createSafeId<"field">(),
      fileName: input.fileName,
      renamed: false,
    };
    await input.scopedDb(async (tx) => {
      await authorizeBufferWrite(input.authority, tx);
      await input.afterCreate?.(tx, created);
    });
    return Result.ok(created);
  });
  fakeS3.requests.length = 0;
  await testDb.insert(recordingTranscriptionRuns).values({
    id: runId,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    entityId: ids.entityA1,
    fileFieldId: ids.fileFieldA1,
    entityVersionId: ids.entityVersionA1,
    sourceFileId: toSafeId<"userFile">(ids.fileObjectA1),
    sourceFileName: "call.wav",
    sourceMimeType: "audio/wav",
    status: "queued",
    requestedBy: ids.userA1,
  });
});

afterEach(async () => {
  mock.restore();
  await testDb
    .delete(recordingTranscriptionRuns)
    .where(eq(recordingTranscriptionRuns.id, runId));
  await testDb
    .insert(member)
    .values(originalOrganizationMember)
    .onConflictDoNothing();
  await testDb
    .update(member)
    .set({ role: originalOrganizationMember.role })
    .where(eq(member.id, ids.memberA1org));
  await testDb
    .insert(workspaceMembers)
    .values(originalMatterMembers)
    .onConflictDoNothing();
});

afterAll(async () => {
  fakeS3.stop();
  await releaseRlsFixture();
});

const expectStoppedBeforeReading = async () => {
  await processRecordingTranscriptionRun(
    actor,
    testModelAdmission(actor.organizationId),
  );
  const run = await readRun();
  expect(run).toMatchObject({
    status: "failed",
    errorCode: "internal",
    outputEntityId: null,
  });
  expect(run?.finishedAt).not.toBeNull();
  expect(sourceReads()).toEqual([]);
  expect(transcribeSpy).not.toHaveBeenCalled();
  expect(writeSpy).not.toHaveBeenCalled();
};

describe("recording transcription run", () => {
  test("a run stops when its requester no longer has access to the matter", async () => {
    await testDb
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.id, ids.memberA1wsA1));
    await expectStoppedBeforeReading();
  });

  test("a run stops when its requester has left the organization", async () => {
    await testDb.delete(member).where(eq(member.id, ids.memberA1org));
    await expectStoppedBeforeReading();
  });

  test("a run transcribes each piece once and saves the transcript", async () => {
    await processRecordingTranscriptionRun(
      actor,
      testModelAdmission(actor.organizationId),
    );
    expect(await readRun()).toMatchObject({
      status: "completed",
      errorCode: null,
      durationMs: 30_000,
      transcribedMs: 30_000,
      outputEntityId,
      outputFileName: "call transcript.docx",
    });
    expect(sourceReads()).toHaveLength(1);
    const keys = transcribeSpy.mock.calls.map(
      ([ctx]) => ctx.usageKey?.idempotencyKey,
    );
    // Every speech piece the reader hands out is sent once, under its own
    // run and piece key.
    expect(keys).toEqual(
      (await speechPieceIndices(toneWav(30), "wav")).map(
        (index) => `recording-transcription:${runId}:${index}`,
      ),
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  test("a recording the reader refuses fails without a model call", async () => {
    fakeS3.put(
      BUCKET,
      sourceKey,
      new TextEncoder().encode("not audio"),
      DOCX_MIME_TYPE,
    );
    await processRecordingTranscriptionRun(
      actor,
      testModelAdmission(actor.organizationId),
    );
    fakeS3.put(BUCKET, sourceKey, toneWav(30), DOCX_MIME_TYPE);
    expect(await readRun()).toMatchObject({
      status: "failed",
      errorCode: "unsupported_format",
    });
    expect(transcribeSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
  });
});
