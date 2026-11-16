import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";

import { EML_MIME_TYPE } from "@stll/api-contract/email-mime-types";

import { envBase } from "@/api/env-base";
import { NO_SKILL_BINDING_SCOPE } from "@/api/lib/agent-skills/binding";
import { createSafeId } from "@/api/lib/branded-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import { OBJECT_READ_TIMEOUT_MS } from "@/api/lib/s3";
import { activeFileContextFixture } from "@/api/tests/helpers/active-file-context";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import {
  responseByteFile,
  responseByteStream,
} from "@/api/tests/helpers/response-byte-stream";

import { buildChatSystemPromptParts } from "./chat-prompt";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("active email storage boundaries", () => {
  const fixture = activeFileContextFixture({
    fileName: "context.eml",
    mimeType: EML_MIME_TYPE,
  });
  beforeAll(fixture.seed);
  afterAll(fixture.dispose);
  const prompt = async () =>
    (
      await buildChatSystemPromptParts({
        activeDecision: undefined,
        activeExternal: undefined,
        activeFile: {
          entityId: fixture.source.entityId,
          fileFieldId: fixture.source.fieldId,
          fileName: "untrusted-client-name.eml",
        },
        activeSkillContext: null,
        activeStatute: undefined,
        contextMatterIds: [],
        hasReachableMatter: true,
        offeredToolNamesForSkills: () => new Set(),
        organizationId: fixture.organizationId,
        practiceJurisdictions: [],
        refRegistry: createChatRefRegistry(),
        safeDb: fixture.safeDb,
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
      })
    ).unwrap();

  test.each(["oversized", "undeclared", "deadline"] as const)(
    "a %s email read keeps file context and reports the missing citation snapshot",
    async (kind) => {
      const byteLength =
        kind === "deadline" ? 1 : FILE_SIZE_LIMIT_BYTES.document + 1;
      using bodyFile = responseByteFile(byteLength);
      const store = startFakeS3({
        readResponse: ({ headers }) => {
          const responseHeaders = new Headers(headers);
          if (kind === "undeclared") {
            responseHeaders.delete("content-length");
          } else {
            responseHeaders.set("content-length", String(byteLength));
          }
          return new Response(
            kind === "undeclared"
              ? responseByteStream(byteLength).body
              : bodyFile.body,
            { headers: responseHeaders },
          );
        },
      });
      store.put(
        envBase.S3_BUCKET,
        fixture.key,
        new Uint8Array(1),
        EML_MIME_TYPE,
      );
      const analytics = installRecordingAnalytics();
      const deadline = new AbortController();
      const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
      const timeoutSpy = spyOn(AbortSignal, "timeout").mockImplementation(
        (milliseconds) =>
          milliseconds === OBJECT_READ_TIMEOUT_MS
            ? deadline.signal
            : originalTimeout(milliseconds),
      );
      const hold =
        kind === "deadline"
          ? store.holdNext({ method: "GET", keyIncludes: fixture.key })
          : null;
      const building = prompt();
      try {
        if (hold !== null) {
          await hold.reached;
          expect(timeoutSpy.mock.calls).toContainEqual([
            OBJECT_READ_TIMEOUT_MS,
          ]);
          deadline.abort();
          hold.release();
        }
        const result = await building;
        expect(result.fullPrompt).toContain(fixture.source.fileName);
        expect(result.fullPrompt).not.toContain("untrusted-client-name.eml");
        expect(result.fullPrompt).not.toContain("#email:");
        expect(analytics.exceptions()).toHaveLength(1);
        expect(
          analytics.exceptions().at(0)?.properties["$exception_fingerprint"],
        ).toContain("chat.resolveActiveFilePromptContext.readResult_error");
        if (kind === "oversized") {
          expect(analytics.exceptions().at(0)?.properties["error.class"]).toBe(
            "S3ObjectBudgetError",
          );
        } else if (kind === "undeclared") {
          expect(analytics.exceptions().at(0)?.properties["error.class"]).toBe(
            "S3ObjectReadError",
          );
        }
        expect(store.requests.map(({ method }) => method)).toEqual(["GET"]);
      } finally {
        deadline.abort();
        hold?.release();
        try {
          await building;
        } finally {
          timeoutSpy.mockRestore();
          analytics.restore();
          store.stop();
        }
      }
    },
  );

  test("an ordinary uploaded email keeps its source-bound citation text", async () => {
    const body =
      "From: sender@example.test\r\nTo: reader@example.test\r\nSubject: Context boundary\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nBudget-safe email body.";
    const store = startFakeS3();
    store.put(envBase.S3_BUCKET, fixture.key, body, EML_MIME_TYPE);
    const analytics = installRecordingAnalytics();
    try {
      const result = await prompt();
      expect(result.fullPrompt).toContain("Budget-safe email body.");
      expect(result.fullPrompt).toContain(
        `#email:${fixture.source.entityId}:${fixture.source.fieldId}:`,
      );
      expect(result.fullPrompt).toContain(fixture.source.fileName);
      expect(analytics.exceptions()).toEqual([]);
      expect(store.requests.map(({ method }) => method)).toEqual(["GET"]);
    } finally {
      analytics.restore();
      store.stop();
    }
  });
});
