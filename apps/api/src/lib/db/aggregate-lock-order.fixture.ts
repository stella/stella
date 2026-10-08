import { panic } from "better-result";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { createSafeId } from "@/api/lib/branded-types";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

import { withAggregateLock } from "./aggregate-lock";
import type { AggregateName } from "./aggregate-lock";

type Options = Parameters<typeof withAggregateLock>[0];
type FenceFixtures = {
  [Name in AggregateName]: Omit<Extract<Options, { aggregate: Name }>, "tx">;
};

export const aggregateFences = () => {
  const organizationId = mintAuthProviderId<"organization">();
  const workspaceId = createSafeId<"workspace">();
  const definitionId = createSafeId<"flowDefinition">();
  return {
    organization: {
      aggregate: "organization",
      id: organizationId,
      mode: "update",
    },
    orgFeatureAdmission: {
      aggregate: "orgFeatureAdmission",
      id: { organizationId, featureId: "flows" },
    },
    schedulerClaim: {
      aggregate: "schedulerClaim",
      id: { id: "scheduler-claim" },
      mode: "update",
    },
    definitionCap: { aggregate: "definitionCap", id: { definitionId } },
    definition: {
      aggregate: "definition",
      id: { id: definitionId, organizationId },
      mode: "update",
    },
    scoutCensus: {
      aggregate: "scoutCensus",
      id: { type: "run", id: createSafeId<"scoutRun">(), organizationId },
      mode: "update",
    },
    workspace: {
      aggregate: "workspace",
      id: { id: workspaceId, organizationId },
      mode: "update",
    },
    memberCleanup: {
      aggregate: "memberCleanup",
      id: { type: "organization-member", id: "member-claim", organizationId },
      mode: "update",
    },
    run: {
      aggregate: "run",
      id: { id: createSafeId<"flowRun">(), workspaceId },
      mode: "update",
    },
    currentStep: {
      aggregate: "currentStep",
      id: { id: createSafeId<"flowRunStep">(), workspaceId },
      mode: "update",
    },
    obligation: {
      aggregate: "obligation",
      id: { id: createSafeId<"entity">(), workspaceId },
      mode: "update",
    },
    entity: {
      aggregate: "entity",
      id: { id: createSafeId<"entity">(), workspaceId },
      mode: "update",
    },
    processingClaim: {
      aggregate: "processingClaim",
      id: { id: createSafeId<"documentProcessingRun">(), workspaceId },
      mode: "update",
    },
    contactCapacity: { aggregate: "contactCapacity", id: { organizationId } },
    personalCatalog: {
      aggregate: "personalCatalog",
      id: { organizationId, userId: mintAuthProviderId<"user">() },
    },
  } as const satisfies FenceFixtures;
};

const hashFixture = (value: unknown) => {
  const text = String(value);
  let hash = 0;
  for (const character of text) {
    hash =
      (hash * 31 +
        (character.codePointAt(0) ?? panic("Missing fixture hash character"))) %
      2_147_483_647;
  }
  return hash;
};

/** Stable physical keys distinguish namespaces and principals; this is not a PostgreSQL hash oracle. */
export const aggregateExecutionRows = (statement: SQL, found = true) => {
  const query = new PgDialect().sqlToQuery(statement);
  if (!query.sql.includes("advisory_xact_lock")) {
    return found ? [{ id: "locked" }] : [];
  }
  const first = query.params.at(0);
  const contact = query.sql.includes("'contact_capacity'");
  let key1 = hashFixture(first);
  if (contact) {
    key1 = hashFixture("contact_capacity");
  } else if (typeof first === "number") {
    key1 = first;
  }
  return [
    {
      key1,
      key2: hashFixture(query.params.at(contact ? 0 : 1)),
      acquired: true,
    },
  ];
};

export const aggregateRecorder = () => {
  const statements: ReturnType<PgDialect["sqlToQuery"]>[] = [];
  const tx = {
    execute: async (statement: SQL) => {
      await Promise.resolve();
      statements.push(new PgDialect().sqlToQuery(statement));
      return aggregateExecutionRows(statement);
    },
  };
  return { tx, statements };
};

export const plantedDescendingBlockingAcquisition = async (
  tx: Parameters<typeof withAggregateLock>[0]["tx"],
) => {
  const fixture = aggregateFences();
  await withAggregateLock({ ...fixture.workspace, tx });
  return await withAggregateLock({
    ...fixture.orgFeatureAdmission,
    wait: "block",
    tx,
  });
};

export const plantedWeakerHeldModeReuse = async (
  tx: Parameters<typeof withAggregateLock>[0]["tx"],
) => {
  const fixture = aggregateFences();
  await withAggregateLock({ ...fixture.workspace, mode: "key share", tx });
  await withAggregateLock({ ...fixture.entity, tx });
  return await withAggregateLock({ ...fixture.workspace, mode: "update", tx });
};

export const plantedBlockingUpgradeAtHighWater = async (
  tx: Parameters<typeof withAggregateLock>[0]["tx"],
) => {
  const fixture = aggregateFences();
  await withAggregateLock({ ...fixture.workspace, mode: "key share", tx });
  return await withAggregateLock({ ...fixture.workspace, mode: "update", tx });
};
