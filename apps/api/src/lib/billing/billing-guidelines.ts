import { panic } from "better-result";
import { and, eq, inArray, isNull, like, or } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  agentSkillResources,
  agentSkills,
  billingGuidelineFiles,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { readBounded } from "@/api/lib/db/read-bounded";

/** The firm binds one guideline file; `billing_guideline_files_firm_uidx`
 * holds the database to it. */
export const BILLING_GUIDELINE_MAX_FIRM_FILES = 1;
/** The most guideline files one client binds. */
export const BILLING_GUIDELINE_MAX_FILES_PER_CLIENT = 10;

/** The most files one scope binds: the firm without a client, else that
 * client. Every write and every bounded read derives its cap from these. */
export const billingGuidelineScopeCap = (clientId: string | undefined) =>
  clientId === undefined
    ? BILLING_GUIDELINE_MAX_FIRM_FILES
    : BILLING_GUIDELINE_MAX_FILES_PER_CLIENT;

/** The most bindings a read of the firm's files plus `clientCount` clients'
 * files can return: every scope full. */
export const billingGuidelineFileCap = (clientCount: number) =>
  BILLING_GUIDELINE_MAX_FIRM_FILES +
  BILLING_GUIDELINE_MAX_FILES_PER_CLIENT * clientCount;

export const extractBillingGuidelineSections = (content: string) => {
  // Text before the first heading is independently citable. Scan each line once:
  // overlapping heading/title/suffix regex quantifiers can backtrack quadratically.
  const sections = ["Preamble"];
  for (const line of content.split(/\r\n?|\n|\u2028|\u2029/u)) {
    let level = 0;
    while (level < 6 && line.charAt(level) === "#") {
      level += 1;
    }
    if (level === 0 || !/\s/u.test(line.charAt(level))) {
      continue;
    }
    const title = line.slice(level).trim();
    if (title.length === 0) {
      continue;
    }
    let end = title.length;
    while (end > 1 && title.charAt(end - 1) === "#") {
      end -= 1;
    }
    sections.push(title.slice(0, end).trimEnd());
  }
  return sections;
};

// A binding counts only while its file is a reference file of one of the
// organization's team skills. Drafting and every report of the drafting mode
// read bindings through these conditions, so both see the same files.
const boundResource = (organizationId: SafeId<"organization">) =>
  and(
    eq(agentSkillResources.id, billingGuidelineFiles.resourceId),
    eq(agentSkillResources.organizationId, organizationId),
  );
const boundSkill = (organizationId: SafeId<"organization">) =>
  and(
    eq(agentSkills.id, agentSkillResources.skillId),
    eq(agentSkills.organizationId, organizationId),
    eq(agentSkills.scope, "team"),
  );
const boundFile = (organizationId: SafeId<"organization">) =>
  and(
    eq(billingGuidelineFiles.organizationId, organizationId),
    like(agentSkillResources.path, "references/%"),
  );

/** A firm guideline file is bound to no client. */
export const isFirmGuidelineFile = ({
  clientId,
}: {
  clientId: SafeId<"contact"> | null;
}) => clientId === null;

type ReadFirmGuidelineBoundOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
};

/** Whether the organization has a firm guideline file bound; client files
 * alone never count. */
export const readFirmGuidelineBound = async ({
  tx,
  organizationId,
}: ReadFirmGuidelineBoundOptions) =>
  (
    await tx
      .select({ resourceId: billingGuidelineFiles.resourceId })
      .from(billingGuidelineFiles)
      .innerJoin(agentSkillResources, boundResource(organizationId))
      .innerJoin(agentSkills, boundSkill(organizationId))
      .where(
        and(boundFile(organizationId), isNull(billingGuidelineFiles.clientId)),
      )
      .limit(1)
  ).length > 0;

type LoadBillingGuidelinesOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  clientIds: readonly SafeId<"contact">[];
};

export const loadBillingGuidelines = async ({
  safeDb,
  organizationId,
  clientIds,
}: LoadBillingGuidelinesOptions) =>
  await safeDb(async (tx) => {
    const read = await readBounded(
      tx
        .select({
          fileId: agentSkillResources.id,
          fileName: agentSkillResources.path,
          content: agentSkillResources.content,
          clientId: billingGuidelineFiles.clientId,
        })
        .from(billingGuidelineFiles)
        .innerJoin(agentSkillResources, boundResource(organizationId))
        .innerJoin(agentSkills, boundSkill(organizationId))
        .where(
          and(
            boundFile(organizationId),
            clientIds.length === 0
              ? isNull(billingGuidelineFiles.clientId)
              : or(
                  isNull(billingGuidelineFiles.clientId),
                  inArray(billingGuidelineFiles.clientId, [...clientIds]),
                ),
          ),
        ),
      billingGuidelineFileCap(clientIds.length),
    );
    if (read.type === "overflow") {
      return panic("Billing guideline bindings exceed their configured cap", {
        organizationId,
      });
    }
    return read.rows;
  });
