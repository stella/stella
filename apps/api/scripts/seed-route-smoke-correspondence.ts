import { panic } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import { runScriptWithErrorOutput } from "@stll/errors/script-error";

import { member, user } from "@/api/db/auth-schema";
import {
  correspondence,
  correspondenceFilers,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { openMaintenanceDb } from "@/api/lib/db/maintenance-db";
import { requireLocalDevOpen } from "@/api/runtime-mode";

import { DEFAULT_ORG_ID } from "./seed-utils";

requireLocalDevOpen("Seeding");

const [workspaceValue, correspondenceValue, subject] = v.parse(
  v.tuple([
    v.pipe(v.string(), v.uuid()),
    v.pipe(v.string(), v.uuid()),
    v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  ]),
  process.argv.slice(2),
);
const workspaceId = toSafeId<"workspace">(workspaceValue);
const correspondenceId = toSafeId<"correspondence">(correspondenceValue);
const db = openMaintenanceDb({ readOnly: false });

const operation = db.transaction(async (tx) => {
  const [filer] = await tx
    .select({ id: user.id, name: user.name, email: user.email })
    .from(workspaces)
    .innerJoin(member, eq(member.organizationId, workspaces.organizationId))
    .innerJoin(user, eq(user.id, member.userId))
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, workspaces.id),
        eq(workspaceMembers.userId, user.id),
      ),
    )
    .where(
      and(
        eq(workspaces.id, workspaceId),
        eq(workspaces.organizationId, DEFAULT_ORG_ID),
        eq(workspaces.name, `route-smoke-${workspaceId.slice(0, 8)}`),
        eq(workspaces.status, "active"),
        eq(user.email, "test@stella.dev"),
      ),
    )
    .limit(1);
  if (filer === undefined) {
    panic("Correspondence fixture requires the seeded user's smoke matter");
  }

  await tx.insert(correspondence).values({
    id: correspondenceId,
    organizationId: DEFAULT_ORG_ID,
    workspaceId,
    direction: "in",
    channel: "email",
    intake: "direct",
    authenticatedSenderAddress: "sender@correspondence.example.test",
    originalSignature: null,
    contentHash: "a".repeat(64),
    dedupKey: correspondenceId.replaceAll("-", "").repeat(2),
    from: { address: "sender@correspondence.example.test", name: null },
    to: [{ address: filer.email, name: filer.name }],
    cc: [],
    subject,
    receivedAt: new Date("2026-09-27T12:00:00.000Z"),
    references: [],
    bodyText: "A persisted message for correspondence route smoke.",
    spf: "pass",
    dkim: "pass",
    dmarc: "pass",
    alignedIdentifier: "correspondence.example.test",
  });
  await tx.insert(correspondenceFilers).values({
    organizationId: DEFAULT_ORG_ID,
    workspaceId,
    correspondenceId,
    filedByUserId: toSafeId<"user">(filer.id),
    filedByDisplay: { status: "active", name: filer.name, email: filer.email },
  });
});

await runScriptWithErrorOutput(async () => {
  await operation;
});
process.exit(0);
