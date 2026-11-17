import { panic, Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import { member } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { officeFileEvidence } from "@/api/db/schema";
import { buildChatSystemPromptParts } from "@/api/handlers/chat/chat-prompt";
import { HttpStatusResponse } from "@/api/http/status";
import { NO_SKILL_BINDING_SCOPE } from "@/api/lib/agent-skills/binding";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import * as encryption from "@/api/lib/content-encryption";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import {
  findOfficeEvidenceBlock,
  loadOfficeEvidence,
} from "@/api/lib/files/office-evidence";
import * as officeEvidence from "@/api/lib/files/office-evidence";
import {
  OFFICE_EVIDENCE_FORMAT,
  OFFICE_EVIDENCE_STATUS,
} from "@/api/lib/files/office-evidence-domain";
import { OFFICE_EVIDENCE_PARSER_VERSION } from "@/api/lib/files/office-evidence-types";
import type { OfficeEvidencePayload } from "@/api/lib/files/office-evidence-types";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { XLSX_MIME_TYPE } from "@/api/mime-types";
import { activeFileContextFixture } from "@/api/tests/helpers/active-file-context";
import {
  createTestHandlerContext,
  NO_AUDIT,
} from "@/api/tests/helpers/handler-context";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";

import officeCitation from "./office-citation";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const blockId = "xlsx-1111111111111111";
const otherId = "xlsx-2222222222222222";
const payload = (id: string): OfficeEvidencePayload => ({
  version: 1,
  format: "xlsx",
  blocks: [
    {
      id,
      text: "Schedule total",
      locator: {
        type: "xlsx",
        range: "A1",
        sheetIndex: 0,
        sheetName: "Schedule",
      },
    },
  ],
});
const matching = JSON.stringify(payload(blockId));
const nonmatching = JSON.stringify(payload(otherId));
const unreadable = "Persisted evidence fixture could not be decoded";

describe.skipIf(!enabled)("Office citation read outcomes", () => {
  const fixture = activeFileContextFixture({
    fileName: "schedule.xlsx",
    mimeType: XLSX_MIME_TYPE,
  });
  let userId: SafeId<"user">;
  const scopedDb: ScopedDb = async (callback) =>
    Result.unwrap(await fixture.safeDb(callback));
  const clear = async () => {
    await rootDb
      .delete(officeFileEvidence)
      .where(eq(officeFileEvidence.fieldId, fixture.source.fieldId));
  };
  beforeAll(async () => {
    await fixture.seed();
    const principal = (
      await rootDb
        .select({ userId: member.userId })
        .from(member)
        .where(eq(member.organizationId, fixture.organizationId))
    ).at(0);
    if (!principal) {
      panic("Office fixture has no principal");
    }
    userId = brandPersistedUserId(principal.userId);
  });
  afterAll(fixture.dispose);
  beforeEach(clear);
  afterEach(clear);

  const seed = async (parserVersion: number, text: string) => {
    const encrypted = await encryption.encryptContent(
      fixture.organizationId,
      text,
    );
    await rootDb.insert(officeFileEvidence).values({
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      entityId: fixture.source.entityId,
      entityVersionId: fixture.source.entityVersionId,
      fieldId: fixture.source.fieldId,
      sourceFileId: fixture.source.fileId,
      sourceSha256Hex: fixture.source.sha256Hex,
      format: OFFICE_EVIDENCE_FORMAT.xlsx,
      parserVersion,
      status: OFFICE_EVIDENCE_STATUS.available,
      blockCount: 1,
      payloadCiphertext: encrypted.ciphertext,
      payloadIv: encrypted.iv,
    });
  };
  const lookup = async () =>
    await officeCitation.handler(
      createTestHandlerContext<Parameters<typeof officeCitation.handler>[0]>({
        audit: NO_AUDIT,
        safeDb: fixture.safeDb,
        scopedDb,
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        session: { activeOrganizationId: fixture.organizationId },
        user: { id: userId, email: `${userId}@example.test` },
        params: {
          entityId: fixture.source.entityId,
          fieldId: fixture.source.fieldId,
          blockId,
          workspaceId: fixture.workspaceId,
        },
        request: new Request(
          `https://example.test/files/${fixture.workspaceId}/office-citation/${fixture.source.entityId}/${fixture.source.fieldId}/${blockId}`,
        ),
      }),
    );

  test.each([
    { name: "no retained evidence", versions: [], code: 404 },
    {
      name: "readable versions without the block",
      versions: [nonmatching],
      code: 404,
    },
    { name: "unreadable evidence", versions: [unreadable], code: 500 },
    {
      name: "readable newer version and unreadable older version",
      versions: [nonmatching, unreadable],
      code: 500,
    },
    {
      name: "unreadable newer version and readable nonmatching older version",
      versions: [unreadable, nonmatching],
      code: 500,
    },
    {
      name: "invalid persisted payload",
      versions: [JSON.stringify({ format: "xlsx", version: 1, blocks: [] })],
      code: 500,
    },
  ])("$name keeps the absence verdict truthful", async ({ versions, code }) => {
    for (let index = 0; index < versions.length; index += 1) {
      const text = versions.at(index);
      if (text === undefined) {
        panic("Missing declared evidence version");
      }
      await seed(
        Math.max(OFFICE_EVIDENCE_PARSER_VERSION, versions.length) - index,
        text,
      );
    }
    const analytics = installRecordingAnalytics();
    try {
      const result = await lookup();
      expect(result).toBeInstanceOf(HttpStatusResponse);
      if (!(result instanceof HttpStatusResponse)) {
        panic("Expected Office citation error status");
      }
      expect(result.code).toBe(code);
      if (code === 500) {
        expect(result.response).toMatchObject({
          code: "internal_error",
          message: "Office citation is unavailable",
        });
        expect(JSON.stringify(result.response)).not.toContain(unreadable);
        expect(analytics.exceptions().length).toBeGreaterThan(0);
      } else {
        expect(result.response).toMatchObject({
          message: "Office citation not found",
        });
        expect(analytics.exceptions()).toEqual([]);
      }
    } finally {
      analytics.restore();
    }
  });

  test.each([
    { name: "current readable evidence", versions: [matching] },
    {
      name: "older readable evidence after a newer decode failure",
      versions: [unreadable, matching],
    },
    {
      name: "older readable evidence after a newer nonmatching version",
      versions: [nonmatching, matching],
    },
  ])("$name resolves the authentic retained block", async ({ versions }) => {
    for (let index = 0; index < versions.length; index += 1) {
      const text = versions.at(index);
      if (text === undefined) {
        panic("Missing declared evidence version");
      }
      await seed(
        Math.max(OFFICE_EVIDENCE_PARSER_VERSION, versions.length) - index,
        text,
      );
    }
    const analytics = installRecordingAnalytics();
    try {
      const result = await lookup();
      expect(result).not.toBeInstanceOf(HttpStatusResponse);
      expect(result).toMatchObject({
        locator: { type: "xlsx", range: "A1", sheetName: "Schedule" },
        source: {
          entityId: fixture.source.entityId,
          fieldId: fixture.source.fieldId,
          fileName: fixture.source.fileName,
        },
      });
    } finally {
      analytics.restore();
    }
  });

  test("a decrypt failure retains its original cause through the actual reader", async () => {
    await seed(OFFICE_EVIDENCE_PARSER_VERSION, matching);
    const failure = new Error("Evidence decryption is unavailable");
    const analytics = installRecordingAnalytics();
    const decrypt = spyOn(encryption, "decryptContent").mockRejectedValue(
      failure,
    );
    try {
      const result = await findOfficeEvidenceBlock({
        blockId,
        entityId: fixture.source.entityId,
        fieldId: fixture.source.fieldId,
        organizationId: fixture.organizationId,
        scopedDb,
        workspaceId: fixture.workspaceId,
      });
      expect(Result.isError(result)).toBe(true);
      if (!Result.isError(result)) {
        panic("Expected evidence decode failure");
      }
      expect(result.error.operation).toBe("office-evidence-decrypt");
      expect(result.error.cause).toBe(failure);
      const response = await lookup();
      expect(response).toBeInstanceOf(HttpStatusResponse);
      if (!(response instanceof HttpStatusResponse)) {
        panic("Expected unavailable citation");
      }
      expect(response.code).toBe(500);
      expect(JSON.stringify(response.response)).not.toContain(failure.message);
    } finally {
      decrypt.mockRestore();
      analytics.restore();
    }
  });

  const prompt = async (safeDb: SafeDb = fixture.safeDb) =>
    Result.unwrap(
      await buildChatSystemPromptParts({
        activeDecision: undefined,
        activeExternal: undefined,
        activeFile: {
          entityId: fixture.source.entityId,
          fileFieldId: fixture.source.fieldId,
          fileName: "request-name.xlsx",
        },
        activeSkillContext: null,
        activeStatute: undefined,
        contextMatterIds: [],
        hasReachableMatter: true,
        offeredToolNamesForSkills: () => new Set(),
        organizationId: fixture.organizationId,
        practiceJurisdictions: [],
        refRegistry: createChatRefRegistry(),
        safeDb,
        messages: [],
        requestedSkillNames: new Set(),
        skillBindingScope: NO_SKILL_BINDING_SCOPE,
        threadId: createSafeId<"chatThread">(),
        toolAvailability: {
          docxEditMode: null,
          templateAuthoring: false,
          webResearch: false,
          folioAgentDocTools: false,
          subagents: false,
        },
        userContext: undefined,
        workspaceId: fixture.workspaceId,
      }),
    );

  test("unreadable optional locator evidence keeps the real file prompt", async () => {
    await seed(OFFICE_EVIDENCE_PARSER_VERSION, unreadable);
    const analytics = installRecordingAnalytics();
    try {
      const result = await prompt();
      expect(result.fullPrompt).toContain(fixture.source.fileName);
      expect(result.fullPrompt).not.toContain("request-name.xlsx");
      expect(result.fullPrompt).not.toContain(
        `#office:${fixture.source.entityId}`,
      );
      expect(
        analytics.exceptions().map(({ properties }) => properties["operation"]),
      ).toEqual(["office-evidence-json"]);
    } finally {
      analytics.restore();
    }
  });
  test("a claim read failure stays typed while optional chat keeps its file context", async () => {
    const cause = new DatabaseError({
      message: "Office evidence claim is unavailable",
    });
    const failed: SafeDb = async () => Result.err(cause);
    const directAnalytics = installRecordingAnalytics();
    try {
      const result = await loadOfficeEvidence({ ...fixture, safeDb: failed });
      expect(Result.isError(result)).toBe(true);
      if (!Result.isError(result)) {
        panic("Expected typed claim failure");
      }
      expect(result.error.operation).toBe("office-evidence-claim");
      expect(result.error.cause).toBe(cause);
    } finally {
      directAnalytics.restore();
    }

    const originalLoad = officeEvidence.loadOfficeEvidence;
    const load = spyOn(officeEvidence, "loadOfficeEvidence").mockImplementation(
      async (options) => await originalLoad({ ...options, safeDb: failed }),
    );
    const analytics = installRecordingAnalytics();
    try {
      const result = await prompt();
      expect(load).toHaveBeenCalledTimes(1);
      expect(result.fullPrompt).toContain(fixture.source.fileName);
      expect(result.fullPrompt).not.toContain(
        `#office:${fixture.source.entityId}`,
      );
      expect(
        analytics.exceptions().map(({ properties }) => properties["operation"]),
      ).toEqual(["office-evidence-claim"]);
      expect(
        await rootDb
          .select()
          .from(officeFileEvidence)
          .where(eq(officeFileEvidence.fieldId, fixture.source.fieldId)),
      ).toEqual([]);
    } finally {
      load.mockRestore();
      analytics.restore();
    }
  });
});
