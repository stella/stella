import { panic, Result } from "better-result";
import { expect, test } from "bun:test";
import Elysia from "elysia";
import * as v from "valibot";

import { desktopTimeEntryBatchResponseSchema } from "@stll/api-contract/desktop-time-entries";

import { desktopTimeEntryBatches, timeEntries } from "@/api/db/schema";
import { env } from "@/api/env";
import { DEFAULT_TIME_POLICY } from "@/api/lib/billing-time";
import { toSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import {
  createScopedDbMock,
  createSelectQueryMock,
} from "@/api/tests/scoped-db-mock";

import {
  createDesktopTimeEntryBatchEndpoint,
  desktopBatchFingerprint,
} from "./batch";

const MATTER = "00000000-0000-4000-8000-000000000001";
const BODY = {
  idempotencyKey: "review",
  entries: [
    {
      matterId: MATTER,
      dateWorked: new Date().toISOString().slice(0, 10),
      timezoneId: "UTC",
      durationMinutes: 6,
      narrative: "Reviewed agreement",
      billable: false,
    },
  ],
};
const receiptSchema = v.object({
  requestFingerprint: v.string(),
  result: desktopTimeEntryBatchResponseSchema,
});
test("batch fingerprint follows reviewed field values rather than JSON key order", () => {
  const entry = BODY.entries.at(0);
  if (!entry) {
    panic("Missing fixture entry");
  }
  const {
    matterId,
    dateWorked,
    timezoneId,
    durationMinutes,
    narrative,
    billable,
  } = entry;
  expect(desktopBatchFingerprint(BODY)).toBe(
    desktopBatchFingerprint({
      entries: [
        {
          billable,
          narrative,
          durationMinutes,
          timezoneId,
          dateWorked,
          matterId,
        },
      ],
      idempotencyKey: "different-key",
    }),
  );
  expect(desktopBatchFingerprint(BODY)).not.toBe(
    desktopBatchFingerprint({
      ...BODY,
      entries: [{ ...entry, narrative: "Changed" }],
    }),
  );
});

test("batch replay converges and a changed payload or revoked matter refuses without new writes", async () => {
  let receipt: v.InferOutput<typeof receiptSchema> | undefined;
  let missingMatter = false;
  const writes: unknown[] = [];
  const { scopedDb } = createScopedDbMock(
    {
      query: {
        workspaces: {
          findMany: async () => (missingMatter ? [] : [{ id: MATTER }]),
          findFirst: async () => ({ leadUserId: null }),
        },
        organizationSettings: { findFirst: async () => DEFAULT_TIME_POLICY },
        rateTables: { findFirst: async () => undefined },
      },
      select: () => createSelectQueryMock(receipt ? [receipt] : []),
      $count: async () => 0,
      insert: (table: unknown) => ({
        values: (row: unknown) => {
          if (table === desktopTimeEntryBatches) {
            receipt = v.parse(receiptSchema, row);
          }
          if (table === timeEntries) {
            writes.push(row);
          }
          return {
            returning: async () => [
              { id: "00000000-0000-4000-8000-000000000002" },
            ],
          };
        },
      }),
    },
    {
      featureAccess: {
        identity: { email: "desktop@example.test", emailVerified: true },
        enrolments: [
          {
            featureId: "time-billing",
            organizationId: "org_test",
            userId: "user_test",
          },
        ],
      },
    },
  );
  const endpoint = createDesktopTimeEntryBatchEndpoint(async () =>
    Result.ok({
      scopedDb,
      organizationId: toSafeId<"organization">("org_test"),
      userId: toSafeId<"user">("user_test"),
      keyId: "desktop-key",
      memberRole: sessionMemberRole("member"),
    }),
  );
  const app = new Elysia().put("/batch", endpoint.handler, {
    body: endpoint.config.body,
    response: endpoint.config.response,
  });
  const send = async (body: typeof BODY) =>
    await app.handle(
      new Request("http://localhost/batch", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const previous = env.API_FEATURE_ACCESS_GRANTS;
  const previousDeployment = env.FEATURE_TIME_BILLING;
  env.FEATURE_TIME_BILLING = true;
  env.API_FEATURE_ACCESS_GRANTS = {
    "activity-timeline": [
      {
        type: "member",
        organizationId: "org_test",
        email: "desktop@example.test",
      },
    ],
  };
  try {
    const first = await send(BODY);
    expect(first.status).toBe(200);
    const result = await first.json();
    const replay = await send(BODY);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(result);
    expect(writes).toHaveLength(1);
    const changed = await send({
      ...BODY,
      entries: BODY.entries.map((entry) => ({
        ...entry,
        narrative: "Changed",
      })),
    });
    expect(changed.status).toBe(409);
    missingMatter = true;
    expect((await send(BODY)).status).toBe(404);
    expect(writes).toHaveLength(1);
  } finally {
    env.API_FEATURE_ACCESS_GRANTS = previous;
    env.FEATURE_TIME_BILLING = previousDeployment;
  }
});

test("batch rejects unknown fields before authorization under default normalization", async () => {
  const endpoint = createDesktopTimeEntryBatchEndpoint(async () =>
    panic("Invalid batch must fail validation before authorization"),
  );
  const app = new Elysia().put("/batch", endpoint.handler, {
    body: endpoint.config.body,
    response: endpoint.config.response,
  });
  for (const extra of [
    { appName: "private" },
    { rawSegments: [] },
    { summary: "private" },
    { taskCode: "private" },
  ]) {
    for (const body of [
      { ...BODY, ...extra },
      {
        ...BODY,
        entries: BODY.entries.map((entry) => ({ ...entry, ...extra })),
      },
    ]) {
      const response = await app.handle(
        new Request("http://localhost/batch", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      expect(response.status).toBe(422);
    }
  }
});
