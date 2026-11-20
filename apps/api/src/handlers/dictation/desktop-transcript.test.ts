import { Result } from "better-result";
import { afterAll, beforeEach, expect, mock, test } from "bun:test";

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

import {
  createDesktopDictationTranscriptEndpoint,
  markdownText,
  transcriptMarkdown,
  transcriptTimestamp,
} from "./desktop-transcript";

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

const exercise = async ({
  body = BODY,
  readOnly = false,
  visible = true,
  status = "active",
}: {
  body?: unknown;
  readOnly?: boolean;
  visible?: boolean;
  status?: string;
} = {}) => {
  const device = await createDesktopDeviceSigner();
  const { scopedDb } = createScopedDbMock({});
  const authorizeAccount = asTestRaw<NonNullable<Options["authorizeAccount"]>>(
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
  const readMatter = mock(
    async () =>
      await Promise.resolve(
        Result.ok(
          visible ? { id: toSafeId<"workspace">(MATTER_ID), status } : null,
        ),
      ),
  );
  const createEntity = mock(
    async (input: { fileName: string; buffer: ArrayBuffer | Uint8Array }) =>
      await Promise.resolve(
        Result.ok({
          entityId: "entity",
          entityVersionId: "version",
          fieldId: "field",
          fileName: input.fileName,
          renamed: false,
        }),
      ),
  );
  const endpoint = createDesktopDictationTranscriptEndpoint({
    authorizeAccount,
    readMatter: asTestRaw<NonNullable<Options["readMatter"]>>(readMatter),
    createEntity: asTestRaw<NonNullable<Options["createEntity"]>>(createEntity),
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
  return { response, createEntity, readMatter };
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

test("the document leads each paragraph with its time and keeps spoken words literal", () => {
  expect(transcriptTimestamp(0)).toBe("0:00");
  expect(transcriptTimestamp(102_000)).toBe("1:42");
  expect(transcriptTimestamp(3_725_000)).toBe("1:02:05");
  expect(markdownText("a *b* [c] `d` ~e~ \\f")).toBe(
    "a \\*b\\* \\[c\\] \\`d\\` \\~e\\~ \\\\f",
  );
  expect(markdownText("snake_case stays, _this_ is escaped")).toBe(
    "snake_case stays, \\_this\\_ is escaped",
  );
  expect(markdownText("a <b> tag\nand\ttabs")).toBe("a \\<b> tag and tabs");
  expect(
    transcriptMarkdown({
      title: "Memo",
      paragraphs: [
        { startMs: 0, text: "First." },
        { startMs: 5000, text: "   " },
        { startMs: 65_000, text: "Second." },
      ],
    }),
  ).toBe("# Memo\n\n**0:00** First.\n\n**1:05** Second.");
});
