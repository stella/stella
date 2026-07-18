import { describe, expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const mockDiagnosticsResult = {
  db: { status: "ok" as const, latencyMs: 5 },
  redis: { status: "ok" as const, backlogJobsCount: 0 },
  searchProvider: { status: "ok" as const, provider: "pg-fts" },
  aiAvailability: {
    configured: true,
    providerStatus: [{ provider: "openai", status: "reachable" as const }],
  },
  s3: { status: "ok" as const, bucketName: "stella-dev-bucket" },
};

let mockIsSystemAdmin = false;

mock.module("@/api/db/root", () => ({
  rootDb: {
    query: {
      user: {
        findFirst: async () => {
          if (mockIsSystemAdmin) {
            return { id: "user_test123", isSystemAdmin: true };
          }
          return { id: "user_test123", isSystemAdmin: false };
        },
      },
    },
  },
}));

mock.module("@/api/lib/health/probe-diagnostics", () => ({
  probeDiagnostics: async () => mockDiagnosticsResult,
}));

const { default: adminDiagnostics } = await import("./diagnostics");

type DiagnosticsCtx = Parameters<typeof adminDiagnostics.handler>[0];

const createContext = (isSystemAdmin: boolean): DiagnosticsCtx =>
  asTestRaw<DiagnosticsCtx>({
    user: {
      id: toSafeId<"user">("user_test123"),
      isSystemAdmin,
    },
    session: {
      activeOrganizationId: toSafeId<"organization">("org_test123"),
    },
    memberRole: { role: "owner" },
  });

describe("adminDiagnostics handler", () => {
  test("returns 403 Forbidden if user is not system admin", async () => {
    mockIsSystemAdmin = false;
    const result = await adminDiagnostics.handler(createContext(false));
    expect(result).toEqual({
      code: 403,
      response: {
        message: "Forbidden: Administrative access required",
      },
    });
  });

  test("returns diagnostics outcome if user is system admin", async () => {
    mockIsSystemAdmin = true;
    const result = await adminDiagnostics.handler(createContext(true));
    expect(result).toEqual(mockDiagnosticsResult);
  });
});
