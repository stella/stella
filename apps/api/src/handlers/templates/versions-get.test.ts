import { S3Client as AwsS3Client } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ElysiaCustomStatusResponse } from "elysia/error";

import type { ScopedDb } from "@/api/db/safe-db";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import {
  resetAwsS3ClientForTesting,
  setScopedS3ClientFactoryForTesting,
  setScopedSigningEnabledForTesting,
} from "@/api/lib/s3-presign";
import type { S3SigningScope } from "@/api/lib/s3-presign";

import { getTemplateVersionHandler } from "./versions";

// The real presigner runs; only the STS-backed tenant session is replaced by
// a client with static test credentials. Signing is local, so the URL the
// handler returns is the genuine grant: its expiry, key, and disposition can
// be read back and checked against the audit row instead of trusted.
const signingClient = new AwsS3Client({
  credentials: {
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
  },
  region: "us-east-1",
});
const scopeRequests: {
  actions: readonly string[];
  scope: S3SigningScope;
}[] = [];

beforeEach(() => {
  scopeRequests.length = 0;
  setScopedSigningEnabledForTesting(() => true);
  setScopedS3ClientFactoryForTesting(async (scope, actions) => {
    scopeRequests.push({ actions, scope });
    return { client: signingClient, expiresAt: Date.now() + 60 * 60 * 1000 };
  });
});

afterEach(() => {
  resetAwsS3ClientForTesting();
});

const organizationId = toSafeId<"organization">("org_1");
const templateId = toSafeId<"template">("tpl_1");
const versionId = toSafeId<"templateVersion">("ver_2");
const s3Key = "org_1/templates/tpl_1/v2.docx";

type LookupScenario = "found" | "template-not-found" | "version-not-found";

const makeScopedDb = (scenario: LookupScenario = "found") => {
  let transactionCount = 0;
  const tx = {
    query: {
      templates: {
        findFirst: async () =>
          scenario === "template-not-found"
            ? undefined
            : {
                id: templateId,
                fileName: "agreement.docx",
              },
      },
      templateVersions: {
        findFirst: async () =>
          scenario === "version-not-found"
            ? undefined
            : {
                id: versionId,
                version: 2,
                s3Key,
                fieldCount: 4,
                createdAt: new Date("2026-08-11T10:00:00.000Z"),
              },
      },
    },
  };

  // SAFETY: test stub; the fake tx implements exactly the query surface
  // `getTemplateVersionHandler` touches.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const scopedDb = (async (fn: (value: typeof tx) => unknown) => {
    transactionCount += 1;
    return await fn(tx);
  }) as unknown as ScopedDb;

  return {
    getTransactionCount: () => transactionCount,
    scopedDb,
  };
};

describe("template version download", () => {
  test("records the granted template-version download", async () => {
    const events: Parameters<AuditRecorder>[1][] = [];
    const recordAuditEvent: AuditRecorder = async (_tx, event) => {
      events.push(event);
    };
    const { getTransactionCount, scopedDb } = makeScopedDb();
    const props = {
      scopedDb,
      organizationId,
      templateId,
      versionId,
      recordAuditEvent,
    };

    const result = await getTemplateVersionHandler(props);

    expect(result).toMatchObject({ id: versionId });
    if (!("downloadUrl" in result)) {
      throw new TypeError("expected a found version");
    }
    const grant = new URL(result.downloadUrl);
    // The grant is signed inside the template's tenant, never with the
    // unscoped bucket credentials.
    expect(scopeRequests).toEqual([
      {
        actions: ["s3:GetObject"],
        scope: { organizationId, workspaceId: null },
      },
    ]);
    expect(grant.pathname.endsWith(`/${s3Key}`)).toBe(true);
    expect(grant.searchParams.get("response-content-disposition")).toContain(
      "agreement.docx",
    );
    expect(getTransactionCount()).toBe(1);
    expect(events).toEqual([
      {
        action: AUDIT_ACTION.DOWNLOAD,
        resourceType: AUDIT_RESOURCE_TYPE.TEMPLATE,
        resourceId: templateId,
        metadata: {
          disposition: "attachment",
          expiresInSeconds: 900,
          fileName: "agreement.docx",
          s3Key,
          version: 2,
          versionId,
        },
      },
    ]);
    // The audit row must describe the grant that was actually issued.
    const audited = events.at(0);
    if (audited === undefined || Array.isArray(audited)) {
      throw new TypeError("expected exactly one audit event");
    }
    expect(grant.searchParams.get("X-Amz-Expires")).toBe(
      String(audited.metadata?.["expiresInSeconds"]),
    );
  });

  test("returns 404 without auditing when the template is missing", async () => {
    const events: Parameters<AuditRecorder>[1][] = [];
    const recordAuditEvent: AuditRecorder = async (_tx, event) => {
      events.push(event);
    };
    const { getTransactionCount, scopedDb } =
      makeScopedDb("template-not-found");

    const result = await getTemplateVersionHandler({
      scopedDb,
      organizationId,
      templateId,
      versionId,
      recordAuditEvent,
    });

    expect(result).toBeInstanceOf(ElysiaCustomStatusResponse);
    if (result instanceof ElysiaCustomStatusResponse) {
      expect(result.code).toBe(404);
      expect(result.response).toEqual({ message: "Template not found" });
    }
    expect(getTransactionCount()).toBe(1);
    expect(events).toEqual([]);
  });

  test("returns 404 without auditing when the version is missing", async () => {
    const events: Parameters<AuditRecorder>[1][] = [];
    const recordAuditEvent: AuditRecorder = async (_tx, event) => {
      events.push(event);
    };
    const { getTransactionCount, scopedDb } = makeScopedDb("version-not-found");

    const result = await getTemplateVersionHandler({
      scopedDb,
      organizationId,
      templateId,
      versionId,
      recordAuditEvent,
    });

    expect(result).toBeInstanceOf(ElysiaCustomStatusResponse);
    if (result instanceof ElysiaCustomStatusResponse) {
      expect(result.code).toBe(404);
      expect(result.response).toEqual({ message: "Version not found" });
    }
    expect(getTransactionCount()).toBe(1);
    expect(events).toEqual([]);
  });
});
