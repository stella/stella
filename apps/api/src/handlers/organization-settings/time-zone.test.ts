import { Value } from "@sinclair/typebox/value";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { parseTimeZoneId, Temporal } from "@stll/time";
import type { TimeZoneId } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import type { PracticeJurisdiction } from "@/api/db/schema";
import { projectOrganizationSettingsRow } from "@/api/handlers/organization-settings/get";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { createFeatureAccessSnapshot } from "@/api/lib/feature-access/policy";
import type { MemberRole } from "@/api/lib/member-roles";
import {
  hasMemberPermission,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";
import type { McpRequestContext } from "@/api/mcp/context";
import { RESEARCH_ADMIN_TOOL_HANDLERS } from "@/api/mcp/research-admin-tools";
import { DEFAULT_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";
import type { McpToolResponse } from "@/api/mcp/tool-types";
import { isMcpEgressPlan } from "@/api/mcp/tool-types";
import { serializeToolResult } from "@/api/mcp/tool-utils";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import updateOrganizationSettings, {
  updateOrganizationSettingsHandler,
} from "./update";

const organizationId = toSafeId<"organization">("org_test");

type StoredSettings = {
  timeZone: string | null;
  practiceJurisdictions: PracticeJurisdiction[];
};

type Capture = {
  safeDb: SafeDb;
  writes: () => Record<string, unknown>[];
};

/**
 * A database whose settings row is `stored`; it records every upsert's value
 * and conflict-update set so both surfaces can be compared write for write.
 */
const capturingDb = (stored: StoredSettings): Capture => {
  const writes: Record<string, unknown>[] = [];
  const rows = [stored];
  const tx = asTestRaw<Transaction>({
    select: () => ({
      from: () => ({
        where: () => ({
          // Awaiting the array yields the rows; `.for("update")` locks them.
          limit: () => Object.assign([...rows], { for: async () => rows }),
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: async () => {},
        onConflictDoUpdate: async ({
          set,
        }: {
          set: Record<string, unknown>;
        }) => {
          const { updatedAt: _updatedAt, ...rest } = set;
          writes.push(rest);
        },
      }),
    }),
  });
  return {
    safeDb: async (operation) => Result.ok(await operation(tx)),
    writes: () => writes,
  };
};

const NO_ZONE: StoredSettings = { timeZone: null, practiceJurisdictions: [] };

const updateOverRest = async ({
  body,
  stored = NO_ZONE,
  now,
}: {
  body: Parameters<typeof updateOrganizationSettingsHandler>[0]["body"];
  stored?: StoredSettings;
  now?: Temporal.Instant;
}) => {
  const db = capturingDb(stored);
  const audits: Parameters<AuditRecorder>[1][] = [];
  const result = await Result.gen(() =>
    updateOrganizationSettingsHandler({
      body,
      organizationId,
      recordAuditEvent: async (_tx, event) => {
        audits.push(event);
      },
      safeDb: db.safeDb,
      ...(now === undefined ? {} : { now }),
    }),
  );
  return { result, writes: db.writes(), audits };
};

const mcpContext = (
  memberRole: MemberRole,
  safeDb: SafeDb,
  audits: Parameters<AuditRecorder>[1][],
): McpRequestContext => ({
  accessibleWorkspaceIds: [],
  accessibleWorkspaceIdSet: new Set(),
  accessibleWorkspaceStatusById: new Map(),
  accessibleWorkspaces: [],
  grantedScopes: [],
  memberRole,
  organizationId,
  recordAuditEvent: async (_tx, event) => {
    audits.push(event);
  },
  safeDb,
  scopedDb: asTestRaw<McpRequestContext["scopedDb"]>(() => {
    throw new Error("manage_organization reads through safeDb");
  }),
  userId: toSafeId<"user">("user_1"),
  userEmail: "admin@example.test",
});

const toolPayload = (response: McpToolResponse) => {
  if (isMcpEgressPlan(response)) {
    throw new Error("expected a CallToolResult");
  }
  const serialized = serializeToolResult(response);
  const first = serialized.content.at(0);
  const text = first !== undefined && "text" in first ? first.text : "";
  return {
    isError: serialized.isError === true,
    text,
    payload: serialized.isError === true ? null : JSON.parse(text),
  };
};

const updateOverMcp = async ({
  args,
  memberRole = "owner",
  stored = NO_ZONE,
}: {
  args: Record<string, unknown>;
  memberRole?: MemberRole;
  stored?: StoredSettings;
}) => {
  const db = capturingDb(stored);
  const audits: Parameters<AuditRecorder>[1][] = [];
  const response = await RESEARCH_ADMIN_TOOL_HANDLERS.manage_organization({
    args: { action: "update_org_settings", ...args },
    context: mcpContext(memberRole, db.safeDb, audits),
  });
  return { ...toolPayload(response), writes: db.writes(), audits };
};

describe("organization time zone setting", () => {
  test("stores the tz database's spelling and audits the change", async () => {
    const { result, writes, audits } = await updateOverRest({
      body: { timeZone: " europe/prague " },
    });

    const echoed: Record<string, unknown> = result.unwrap();
    expect(echoed).toEqual({ timeZone: "Europe/Prague" });
    expect(writes).toEqual([{ timeZone: "Europe/Prague" }]);
    expect(audits).toMatchObject([
      { changes: { timeZone: { old: null, new: "Europe/Prague" } } },
    ]);
  });

  test("null hands the zone back to the jurisdiction default", async () => {
    const { result, writes } = await updateOverRest({
      body: { timeZone: null },
      stored: { timeZone: "Asia/Tokyo", practiceJurisdictions: [] },
    });

    const echoed: Record<string, unknown> = result.unwrap();
    expect(echoed).toEqual({ timeZone: null });
    expect(writes).toEqual([{ timeZone: null }]);
  });

  test("refuses unknown zones and fixed offsets before the database", async () => {
    for (const timeZone of ["Mars/Olympus_Mons", "+01:00", "CET+1"]) {
      const result = await Result.gen(() =>
        updateOrganizationSettingsHandler({
          body: { timeZone },
          organizationId,
          recordAuditEvent: async () => {},
          safeDb: async () => {
            throw new Error("An invalid zone reached the database");
          },
        }),
      );
      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error).toMatchObject({
          status: 400,
          code: "invalid_time_zone",
        });
      }
    }
  });

  test("judges a lock month on the organization's day", async () => {
    // 22:30 UTC on 30 September is already 1 October in Prague.
    const now = Temporal.Instant.from("2026-09-30T22:30:00Z");
    const lock = { timeLockedThroughMonth: "2026-09-30" };

    const inUtc = await updateOverRest({ body: lock, now });
    expect(inUtc.result).toMatchObject({
      error: { status: 400, code: "invalid_time_locked_month" },
    });

    const czechByDefault = await updateOverRest({
      body: lock,
      now,
      stored: {
        timeZone: null,
        practiceJurisdictions: [{ countryCode: "CZ", isPrimary: true }],
      },
    });
    expect(Result.isOk(czechByDefault.result)).toBe(true);

    const zoneInSameRequest = await updateOverRest({
      body: { ...lock, timeZone: "Europe/Prague" },
      now,
    });
    expect(Result.isOk(zoneInSameRequest.result)).toBe(true);
  });
});

describe("organization time zone REST/MCP/CLI parity", () => {
  test("both surfaces write, audit and echo the same zone", async () => {
    const stored = { timeZone: "Asia/Tokyo", practiceJurisdictions: [] };
    for (const timeZone of ["america/new_york", null]) {
      const rest = await updateOverRest({ body: { timeZone }, stored });
      const mcp = await updateOverMcp({
        args: { time_zone: timeZone },
        stored,
      });

      expect(mcp.isError).toBe(false);
      expect(rest.writes).toHaveLength(1);
      expect(mcp.payload).toEqual(rest.result.unwrap());
      expect(mcp.writes).toEqual(rest.writes);
      expect(mcp.audits).toEqual(rest.audits);
    }
  });

  test("both surfaces refuse the same zone with the same code", async () => {
    const rest = await updateOverRest({ body: { timeZone: "+02:00" } });
    const mcp = await updateOverMcp({ args: { time_zone: "+02:00" } });

    expect(rest.result).toMatchObject({
      error: { code: "invalid_time_zone" },
    });
    expect(mcp.isError).toBe(true);
    expect(mcp.text).toContain("timeZone must be an IANA");
    expect(mcp.writes).toEqual([]);
  });

  test("the MCP input and the REST body accept the same values", async () => {
    expect(
      DEFAULT_MCP_TOOL_DEFINITIONS.find(
        (tool) => tool.name === "manage_organization",
      )?.inputSchema.properties,
    ).toHaveProperty("time_zone");

    const long = `Europe/${"x".repeat(60)}`;
    for (const value of ["Europe/Prague", null, "", long]) {
      const restAccepts = Value.Check(updateOrganizationSettings.config.body, {
        timeZone: value,
      });
      const mcp = await updateOverMcp({ args: { time_zone: value } });
      expect({ value, restAccepts, mcpAccepts: !mcp.isError }).toEqual({
        value,
        restAccepts: value !== "" && value !== long,
        mcpAccepts: restAccepts,
      });
    }
  });

  test("only roles that may update organization settings change the zone", async () => {
    for (const role of [
      "owner",
      "admin",
      "member",
      "intern",
      "external",
    ] as const) {
      const restAllows = hasMemberPermission(
        sessionMemberRole(role),
        updateOrganizationSettings.config.permissions,
      );
      const mcp = await updateOverMcp({
        args: { time_zone: "Europe/Prague" },
        memberRole: role,
      });
      expect({ role, mcpAllows: !mcp.isError }).toEqual({
        role,
        mcpAllows: restAllows,
      });
      expect(mcp.writes.length > 0).toBe(restAllows);
    }
  });
});

describe("reading the organization time zone", () => {
  const emptySnapshot = createFeatureAccessSnapshot({
    organizationId: "org_test",
    userId: "user_test",
    decisions: new Map(),
  });
  const row = (
    timeZone: TimeZoneId | null,
    practiceJurisdictions: PracticeJurisdiction[],
  ) =>
    projectOrganizationSettingsRow(
      {
        documentProcessingMode: "off",
        matterNumberPadding: 3,
        matterNumberPattern: "{SEQ}",
        practiceJurisdictions,
        promptCachingEnabled: true,
        managedAIResidency: "eu",
        memoryExtractionEnabled: false,
        timeMinimumUnitMinutes: 6,
        timeEditWindowDays: 90,
        timeLockedThroughMonth: null,
        timeNarrativeRequired: true,
        timeZone,
      },
      emptySnapshot,
    );

  test("a chosen zone wins over the jurisdiction", () => {
    expect(
      row(parseTimeZoneId("Asia/Tokyo"), [
        { countryCode: "CZ", isPrimary: true },
      ]),
    ).toMatchObject({ timeZone: "Asia/Tokyo", timeZoneSource: "organization" });
  });

  test("an unset zone follows the primary practice jurisdiction", () => {
    for (const [countryCode, timeZone] of [
      ["CZ", "Europe/Prague"],
      ["SK", "Europe/Prague"],
      ["DE", "UTC"],
    ] as const) {
      expect(
        row(null, [
          { countryCode: "US", isPrimary: false },
          { countryCode, isPrimary: true },
        ]),
      ).toMatchObject({ timeZone, timeZoneSource: "practice-jurisdiction" });
    }
    expect(projectOrganizationSettingsRow(null, emptySnapshot)).toMatchObject({
      timeZone: "UTC",
      timeZoneSource: "practice-jurisdiction",
    });
  });
});
