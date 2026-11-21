import { Result } from "better-result";
import { afterAll, beforeEach, expect, mock, test } from "bun:test";

import { UPLOAD_DOCUMENT_MAX_BYTES } from "@stll/api-contract/limits";
import { inspectDocxPackage } from "@stll/folio-core/server";
import { createTestState } from "@stll/test-state";

import { env } from "@/api/env";
import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import { toSafeId } from "@/api/lib/branded-types";
import { CALLER_AUTHORIZED } from "@/api/lib/entities/buffer-write-authority";
import { buildFeatureAccessSnapshot } from "@/api/lib/feature-access/snapshot";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import {
  authorizedMemberRole,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";
import {
  claimFixtureDeviceProof,
  createDesktopDeviceSigner,
} from "@/api/tests/helpers/desktop-device-proof";
import { serveForTest, type TestServer } from "@/api/tests/helpers/test-server";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { createDesktopDictationTranscriptEndpoint } from "./desktop-transcript";

const testState = createTestState({ file: import.meta.path, config: env });

const servers: TestServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map(async (server) => await server.stop()));
});

const USER_ID = toSafeId<"user">("desktop-transcribing-member");
const ORGANIZATION_ID = toSafeId<"organization">("desktop-transcribing-firm");
const EMAIL = "desktop-transcript@example.test";
const MATTER_ID = "0198c5e2-7c1f-7a6e-9a3b-2f4d5e6f7a8b";
const GRANT = {
  type: "member",
  organizationId: ORGANIZATION_ID,
  email: EMAIL,
} as const;

beforeEach(() => {
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
    "desktop-dictation": [GRANT],
  });
});

type Endpoint = typeof createDesktopDictationTranscriptEndpoint;
type Options = NonNullable<Parameters<Endpoint>[0]>;

const BODY = {
  matterId: MATTER_ID,
  title: "Memo to file 2026-11-14 transcript",
  paragraphs: [
    { startMs: 0, text: "Memo to file in Novák versus Stavby Praha." },
    { startMs: 102_000, text: "They propose a joint *expert*." },
  ],
};

const fixtureAccount = async (readOnly: boolean) => {
  const device = await createDesktopDeviceSigner();
  const { scopedDb } = createScopedDbMock({});
  return asTestRaw<NonNullable<Options["authorizeAccount"]>>(
    async (request: Request) =>
      Result.ok({
        featureAccessSnapshot: buildFeatureAccessSnapshot({
          organizationId: ORGANIZATION_ID,
          userId: USER_ID,
          identity: { email: EMAIL, emailVerified: true },
          enrolments: [],
        }),
        consumedProof: await claimFixtureDeviceProof({
          request: await device.signRequest({
            request,
            credential: "desktop-transcript-fixture",
          }),
          deviceJkt: device.deviceJkt,
          keyId: "linked-desktop",
          credential: "desktop-transcript-fixture",
        }),
        organizationId: ORGANIZATION_ID,
        userId: USER_ID,
        keyId: "linked-desktop",
        memberRole: readOnly
          ? authorizedMemberRole({
              role: "member",
              credential: {
                type: "attenuated",
                permissions: { workspace: ["read"] },
              },
            })
          : sessionMemberRole("member"),
        scopedDb,
      }),
  );
};

const FOLDER_ID = "0198c5e2-7c1f-7a6e-9a3b-2f4d5e6f7a90";

const exercise = async ({
  body = BODY,
  readOnly = false,
  visible = true,
  status = "active",
  refusedFileName,
}: {
  body?: unknown;
  readOnly?: boolean;
  visible?: boolean;
  status?: string;
  /** A document the matter does not take. */
  refusedFileName?: string;
} = {}) => {
  const authorizeAccount = await fixtureAccount(readOnly);
  const readMatter = mock(
    async () =>
      await Promise.resolve(
        Result.ok(
          visible ? { id: toSafeId<"workspace">(MATTER_ID), status } : null,
        ),
      ),
  );
  const createEntity = mock(
    async (input: {
      fileName: string;
      buffer: ArrayBuffer | Uint8Array;
      parentId?: string | null;
    }) =>
      await Promise.resolve(
        input.fileName === refusedFileName
          ? Result.err({ _tag: "EntityLimitError" as const })
          : Result.ok({
              entityId: "entity",
              entityVersionId: "version",
              fieldId: "field",
              fileName: input.fileName,
              renamed: false,
            }),
      ),
  );
  const createFolder = mock(
    async (input: { title: string; entityCount: number }) =>
      await Promise.resolve(
        Result.ok({
          folderId: toSafeId<"entity">(FOLDER_ID),
          folderName: `${input.title} (2)`,
        }),
      ),
  );
  const reserveAudio = mock(
    async (input: { folderId: string; audio: { size: number } }) =>
      await Promise.resolve(
        Result.ok({
          uploadId: "0198c5e2-7c1f-7a6e-9a3b-2f4d5e6f7a91",
          url: `https://uploads.example.test/${input.folderId}`,
          expiresAt: "2026-11-20T12:00:00.000Z",
          headers: {
            "content-type": "audio/mp4",
            "content-length": String(input.audio.size),
            "x-amz-checksum-sha256": "checksum",
            "x-amz-sdk-checksum-algorithm": "SHA256",
          },
        }),
      ),
  );
  const endpoint = createDesktopDictationTranscriptEndpoint({
    authorizeAccount,
    readMatter: asTestRaw<NonNullable<Options["readMatter"]>>(readMatter),
    createEntity: asTestRaw<NonNullable<Options["createEntity"]>>(createEntity),
    createFolder: asTestRaw<NonNullable<Options["createFolder"]>>(createFolder),
    reserveAudio: asTestRaw<NonNullable<Options["reserveAudio"]>>(reserveAudio),
  });
  const server = serveForTest(
    createHttpApp({
      middleware: [errorBoundary],
      routes: routes({ "/transcripts": { POST: endpoint } }),
    }),
  );
  servers.push(server);
  const response = await server.fetch(
    new Request("http://localhost/transcripts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { response, createEntity, readMatter, createFolder, reserveAudio };
};

const xmlPart = async (bytes: ArrayBuffer | Uint8Array, path: string) => {
  const inspection = await inspectDocxPackage(
    bytes instanceof Uint8Array ? bytes.slice().buffer : bytes,
    { xmlParts: [path] },
  );
  return inspection.xmlParts.find((part) => part.path === path)?.text ?? "";
};

const FOLDER = {
  transcriptName: "Diktát – odpověď na mail – přepis",
  cleanedName: "Diktát – odpověď na mail – upravený text",
  instructionsLabel: "Pokyny k diktátu:",
};
const AUDIO = {
  name: "Diktát – odpověď na mail.m4a",
  mimeType: "audio/mp4",
  size: 48_000_000,
  sha256Hex: "ab".repeat(32),
};
const CLEANED = {
  markdown:
    "## Odpověď\n\nDobrý den, **děkuji** za *zprávu*.\n\n- první\n- druhý",
  instructions: ["Udělej z toho e-mail."],
};

test("a transcript is filed in the matter as a Word document named after the recording", async () => {
  const { response, createEntity } = await exercise();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    fileName: "Memo to file 2026-11-14 transcript.docx",
  });
  const created = createEntity.mock.calls.at(0)?.[0];
  expect(created).toMatchObject({
    // The request authorized the write; the create does not recheck it.
    authority: CALLER_AUTHORIZED,
    fileName: "Memo to file 2026-11-14 transcript.docx",
    workspaceId: MATTER_ID,
    parentId: null,
  });
  // A DOCX is a ZIP archive.
  const bytes = new Uint8Array(created?.buffer ?? new ArrayBuffer(0));
  expect([...bytes.slice(0, 2)]).toEqual([0x50, 0x4b]);
});

test("filing needs the dictation decision, document create permission and a matter the member sees", async () => {
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", {});
  const ungranted = await exercise();
  expect(ungranted.response.status).toBe(403);
  expect(ungranted.readMatter).not.toHaveBeenCalled();
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
    "desktop-dictation": [GRANT],
  });
  const readOnly = await exercise({ readOnly: true });
  expect(readOnly.response.status).toBe(403);
  expect(readOnly.createEntity).not.toHaveBeenCalled();
  const hidden = await exercise({ visible: false });
  expect(hidden.response.status).toBe(404);
  expect(hidden.createEntity).not.toHaveBeenCalled();
  const archived = await exercise({ status: "archived" });
  expect(archived.response.status).toBe(409);
  expect(archived.createEntity).not.toHaveBeenCalled();
});

test("a transcript without paragraphs, with unknown fields or past four hours is refused", async () => {
  for (const body of [
    { ...BODY, paragraphs: [] },
    { ...BODY, title: "   " },
    { ...BODY, audio: "base64" },
    {
      ...BODY,
      paragraphs: [{ startMs: 4 * 60 * 60 * 1000 + 1, text: "late" }],
    },
  ]) {
    const { response, createEntity } = await exercise({ body });
    expect(response.status).toBe(422);
    expect(createEntity).not.toHaveBeenCalled();
  }
});

test("a folder named after the recording holds the transcript, the cleaned-up text and the recording's upload", async () => {
  const body = {
    ...BODY,
    title: "Diktát – odpověď na mail",
    folder: FOLDER,
    cleaned: CLEANED,
    audio: AUDIO,
  };
  const { response, createEntity, createFolder, reserveAudio } = await exercise(
    { body },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    fileName: `${FOLDER.transcriptName}.docx`,
    folderName: "Diktát – odpověď na mail (2)",
    files: [
      { kind: "transcript", fileName: `${FOLDER.transcriptName}.docx` },
      { kind: "cleaned", fileName: `${FOLDER.cleanedName}.docx` },
    ],
    audio: {
      status: "upload",
      uploadId: "0198c5e2-7c1f-7a6e-9a3b-2f4d5e6f7a91",
      url: `https://uploads.example.test/${FOLDER_ID}`,
      expiresAt: "2026-11-20T12:00:00.000Z",
      headers: {
        "content-type": "audio/mp4",
        "content-length": String(AUDIO.size),
        "x-amz-checksum-sha256": "checksum",
        "x-amz-sdk-checksum-algorithm": "SHA256",
      },
    },
  });
  expect(createFolder.mock.calls.at(0)?.[0]).toMatchObject({
    title: "Diktát – odpověď na mail",
    // The folder, both documents and the recording.
    entityCount: 4,
  });
  expect(
    createEntity.mock.calls.map(([{ fileName, parentId }]) => ({
      fileName,
      parentId,
    })),
  ).toEqual([
    { fileName: `${FOLDER.transcriptName}.docx`, parentId: FOLDER_ID },
    { fileName: `${FOLDER.cleanedName}.docx`, parentId: FOLDER_ID },
  ]);
  expect(reserveAudio.mock.calls.at(0)?.[0]).toMatchObject({
    folderId: FOLDER_ID,
    audio: AUDIO,
  });
  const cleaned = createEntity.mock.calls.at(1)?.[0].buffer;
  const documentXml = await xmlPart(
    cleaned ?? new ArrayBuffer(0),
    "word/document.xml",
  );
  expect(documentXml).toContain("Udělej z toho e-mail.");
  expect(documentXml).not.toContain("**");
});

test("a recording larger than a matter document is left out and the documents are still filed", async () => {
  const body = {
    ...BODY,
    folder: FOLDER,
    audio: { ...AUDIO, size: UPLOAD_DOCUMENT_MAX_BYTES + 1 },
  };
  const { response, createEntity, reserveAudio, createFolder } = await exercise(
    { body },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    audio: { status: "too_large", maxBytes: UPLOAD_DOCUMENT_MAX_BYTES },
    files: [{ kind: "transcript", fileName: `${FOLDER.transcriptName}.docx` }],
  });
  expect(createEntity).toHaveBeenCalledTimes(1);
  expect(reserveAudio).not.toHaveBeenCalled();
  // The recording takes no place in the matter, so a matter with room for
  // the folder and the transcript still takes them.
  expect(createFolder.mock.calls.at(0)?.[0]).toMatchObject({ entityCount: 2 });
});

test("cleaned-up text the matter does not take is reported, and the filed transcript and recording upload stand", async () => {
  const body = { ...BODY, folder: FOLDER, cleaned: CLEANED, audio: AUDIO };
  const { response, createEntity, reserveAudio } = await exercise({
    body,
    refusedFileName: `${FOLDER.cleanedName}.docx`,
  });
  expect(response.status).toBe(200);
  const reply = await response.json();
  expect(reply).toMatchObject({
    fileName: `${FOLDER.transcriptName}.docx`,
    folderName: `${BODY.title} (2)`,
    files: [{ kind: "transcript", fileName: `${FOLDER.transcriptName}.docx` }],
    notFiled: [{ kind: "cleaned" }],
    audio: { status: "upload" },
  });
  expect(createEntity).toHaveBeenCalledTimes(2);
  expect(reserveAudio).toHaveBeenCalledTimes(1);
});

test("an older desktop files the transcript alone at the matter's root, and cleaned text or a recording needs a folder", async () => {
  const older = await exercise();
  expect(older.response.status).toBe(200);
  expect(older.createFolder).not.toHaveBeenCalled();
  expect(older.reserveAudio).not.toHaveBeenCalled();
  for (const body of [
    { ...BODY, cleaned: CLEANED },
    { ...BODY, audio: AUDIO },
    { ...BODY, folder: { ...FOLDER, instructionsLabel: "" } },
    { ...BODY, folder: FOLDER, cleaned: { ...CLEANED, extra: true } },
  ]) {
    const { response, createEntity, createFolder } = await exercise({ body });
    expect(response.status).toBe(422);
    expect(createEntity).not.toHaveBeenCalled();
    expect(createFolder).not.toHaveBeenCalled();
  }
});
