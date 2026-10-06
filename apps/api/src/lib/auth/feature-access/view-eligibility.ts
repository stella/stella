import { KindGuard, type TSchema } from "@sinclair/typebox";
import { and, eq, inArray, sql, type SQLWrapper } from "drizzle-orm";

import type { UnavailableWorkspaceView } from "@stll/api-contract";

import type { Transaction } from "@/api/db/root";
import { workspaceViews, workspaceViewTemplates } from "@/api/db/schema";
import {
  isFeatureEnabled,
  type FeatureAccessSnapshot,
} from "@/api/lib/auth/feature-access/policy";
import type {
  FeatureAccessRequirement,
  FeatureResourceContext,
} from "@/api/lib/auth/feature-access/requirements";
import type { SafeId } from "@/api/lib/branded-types";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { isRecord } from "@/api/lib/type-guards";
import type { AdvertisedSchemas } from "@/api/mcp/advertised-schema";

export const operationProposesAvtLayout = (body: unknown): boolean =>
  isRecord(body) &&
  (body["targetType"] === "avt" ||
    (isRecord(body["layout"]) && body["layout"]["type"] === "avt"));

type OperationUsesAvtLayoutArgs = {
  tx: Pick<Transaction, "select">;
  workspaceId: SafeId<"workspace">;
  body: unknown;
  params: unknown;
};

/** Resolves conditional access for execution and validation-only transports. */
export const isAvtViewLayout = (layout: unknown): boolean =>
  isRecord(layout) && layout["type"] === "avt";

export const operationUsesAvtLayout = async ({
  tx,
  workspaceId,
  body,
  params,
}: OperationUsesAvtLayoutArgs): Promise<boolean> => {
  if (operationProposesAvtLayout(body)) {
    return true;
  }
  let viewId: string | undefined;
  if (isRecord(params) && typeof params["viewId"] === "string") {
    viewId = params["viewId"];
  } else if (isRecord(body) && typeof body["viewId"] === "string") {
    viewId = body["viewId"];
  }
  if (viewId === undefined) {
    return false;
  }
  const view = (
    await tx
      .select({ layout: workspaceViews.layout })
      .from(workspaceViews)
      .where(
        and(
          eq(workspaceViews.workspaceId, workspaceId),
          eq(workspaceViews.id, sql`${viewId}`),
        ),
      )
      .limit(1)
  ).at(0);
  return view !== undefined && isAvtViewLayout(view.layout);
};

export const avtViewAccessStatus = ({
  snapshot,
  organizationId,
  userId,
}: {
  snapshot: FeatureAccessSnapshot | undefined;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user"> | null;
}): "available" | "unavailable" =>
  isDeploymentFeatureEnabled("FEATURE_LEGAL_LISTS") &&
  snapshot !== undefined &&
  isFeatureEnabled(snapshot, LIST_VERIFICATION_FEATURE_ID, {
    organizationId,
    userId,
  })
    ? "available"
    : "unavailable";

export const isAvtLayoutVisible = (
  layout: unknown,
  accessStatus: "available" | "unavailable",
): boolean => !isAvtViewLayout(layout) || accessStatus === "available";

type ProjectViewEligibilityArgs<
  T extends { id: string; layout: unknown },
  R,
> = {
  view: T;
  accessStatus: "available" | "unavailable";
  projectAvailable: (view: T) => R;
};

/** Complete identities keep list reconciliation independent of feature access. */
export const projectViewEligibility = <
  T extends { id: string; layout: unknown },
  R,
>({
  view,
  accessStatus,
  projectAvailable,
}: ProjectViewEligibilityArgs<T, R>): R | UnavailableWorkspaceView => {
  if (!isAvtLayoutVisible(view.layout, accessStatus)) {
    return { id: view.id, layout: { type: "avt" }, eligibility: "unavailable" };
  }
  return projectAvailable(view);
};

export const avtLayoutVisibilityCondition = (
  layout: SQLWrapper,
  accessStatus: "available" | "unavailable",
) =>
  accessStatus === "available"
    ? sql`true`
    : sql`${layout}->>'type' is distinct from 'avt'`;

const projectViewSchema = (schema: TSchema): TSchema => {
  if (Array.isArray(schema["enum"])) {
    return {
      ...schema,
      enum: schema["enum"].filter((value: unknown) => value !== "avt"),
    };
  }
  if (KindGuard.IsUnion(schema)) {
    return {
      ...schema,
      anyOf: schema.anyOf
        .filter(
          (branch) =>
            !(KindGuard.IsLiteral(branch) && branch.const === "avt") &&
            !(
              KindGuard.IsObject(branch) &&
              KindGuard.IsLiteral(branch.properties["type"]) &&
              branch.properties["type"].const === "avt"
            ),
        )
        .map(projectViewSchema),
    };
  }
  if (KindGuard.IsObject(schema)) {
    return {
      ...schema,
      properties: Object.fromEntries(
        Object.entries(schema.properties).map(([key, value]) => [
          key,
          projectViewSchema(value),
        ]),
      ),
    };
  }
  if (KindGuard.IsArray(schema)) {
    return { ...schema, items: projectViewSchema(schema.items) };
  }
  if (KindGuard.IsIntersect(schema)) {
    return { ...schema, allOf: schema.allOf.map(projectViewSchema) };
  }
  return schema;
};

export const projectAvtViewInputSchemas = (
  schemas: AdvertisedSchemas,
): AdvertisedSchemas => ({
  body:
    schemas.body === undefined ? undefined : projectViewSchema(schemas.body),
  params:
    schemas.params === undefined
      ? undefined
      : projectViewSchema(schemas.params),
  query:
    schemas.query === undefined ? undefined : projectViewSchema(schemas.query),
});

const usesAvtFeature = async ({
  body,
  params,
  workspaceId,
  scopedDb,
  organizationId,
  userId,
}: FeatureResourceContext): Promise<boolean> => {
  if (operationProposesAvtLayout(body)) {
    return true;
  }
  if (isRecord(params) && typeof params["templateId"] === "string") {
    if (userId === null) {
      return false;
    }
    const templateId = params["templateId"];
    const template = (
      await scopedDb((tx) =>
        tx
          .select({ layout: workspaceViewTemplates.layout })
          .from(workspaceViewTemplates)
          .where(
            and(
              eq(workspaceViewTemplates.id, sql`${templateId}`),
              eq(workspaceViewTemplates.organizationId, organizationId),
              eq(workspaceViewTemplates.userId, userId),
            ),
          )
          .limit(1),
      )
    ).at(0);
    return template !== undefined && isAvtViewLayout(template.layout);
  }
  if (
    workspaceId !== undefined &&
    isRecord(body) &&
    Array.isArray(body["viewIds"])
  ) {
    const viewIds = body["viewIds"].filter((id) => typeof id === "string");
    if (viewIds.length === 0) {
      return false;
    }
    const views = await scopedDb((tx) =>
      tx
        .select({ layout: workspaceViews.layout })
        .from(workspaceViews)
        .where(
          and(
            eq(workspaceViews.workspaceId, workspaceId),
            inArray(
              workspaceViews.id,
              sql`(${sql.join(
                viewIds.map((id) => sql`${id}`),
                sql`, `,
              )})`,
            ),
          ),
        ),
    );
    return views.some((view) => isAvtViewLayout(view.layout));
  }
  if (workspaceId === undefined) {
    return false;
  }
  return await scopedDb(
    async (tx) =>
      await operationUsesAvtLayout({ tx, workspaceId, body, params }),
  );
};

export const AVT_LAYOUT_FEATURE_ACCESS = {
  featureId: LIST_VERIFICATION_FEATURE_ID,
  type: "conditional",
  usesFeature: usesAvtFeature,
  projectInputSchema: projectAvtViewInputSchemas,
} as const satisfies FeatureAccessRequirement;
export const AVT_LAYOUT_DISCOVERY_FEATURE_ACCESS = {
  featureId: LIST_VERIFICATION_FEATURE_ID,
  type: "conditional",
  usesFeature: () => false,
  projectInputSchema: projectAvtViewInputSchemas,
} as const satisfies FeatureAccessRequirement;
