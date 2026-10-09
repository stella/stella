import { panic } from "better-result";
import { expect, test } from "bun:test";

import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/feature-access/policy";
import {
  FEATURE_REGISTRY,
  LEGAL_LISTS_FEATURE_ID,
  LIST_VERIFICATION_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import { isRecord } from "@/api/lib/type-guards";
import { CAPABILITY_DISPATCH } from "@/api/mcp/generated/capability-dispatch";
import {
  NO_AUDIT,
  NO_DB,
  createTestHandlerContext,
} from "@/api/tests/helpers/handler-context";

for (const grants of [
  [],
  [LEGAL_LISTS_FEATURE_ID],
  [LEGAL_LISTS_FEATURE_ID, LIST_VERIFICATION_FEATURE_ID],
]) {
  test(`every list REST handler declares the shared policy with ${grants.length} grants`, async () => {
    const grantMap = Object.fromEntries(
      grants.map((id) => [
        id,
        [{ type: "organization" as const, organizationId: "org_test" }],
      ]),
    );
    const snapshot = createFeatureAccessSnapshot({
      organizationId: "org_test",
      userId: "user_test",
      decisions: new Map(
        Object.keys(FEATURE_REGISTRY).map((featureId) => [
          featureId,
          decideFeatureAccess({
            registry: FEATURE_REGISTRY,
            grants: grantMap,
            featureId,
            organizationId: "org_test",
            userId: "user_test",
            membership: true,
            user: { email: "standard@example.test", emailVerified: true },
          }),
        ]),
      ),
    });
    const entries = Object.entries(CAPABILITY_DISPATCH).filter(([id]) =>
      id.startsWith("lists."),
    );
    expect(entries.length).toBeGreaterThan(0);
    for (const [id, entry] of entries) {
      const module: Record<string, unknown> = await entry.load();
      const endpoint =
        module[
          "exportName" in entry && typeof entry.exportName === "string"
            ? entry.exportName
            : "default"
        ];
      if (
        !isRecord(endpoint) ||
        !isRecord(endpoint["config"]) ||
        typeof endpoint["handler"] !== "function"
      ) {
        panic("List endpoint definition required");
      }
      const featureId =
        "featureId" in entry
          ? entry.featureId
          : panic("List feature declaration required");
      expect(endpoint["config"]["featureAccess"]).toEqual({
        type: "required",
        featureId,
      });
      if (snapshot.decisions.get(featureId)?.status === "enabled") {
        continue;
      }
      // NO_DB panics if any handler reaches a resource lookup.
      const result = await endpoint["handler"](
        createTestHandlerContext({
          audit: NO_AUDIT,
          safeDb: NO_DB,
          scopedDb: NO_DB,
          featureAccessSnapshot: snapshot,
        }),
      );
      expect(result, id).toMatchObject({
        code: 404,
        response: { message: "Not found" },
      });
    }
  });
}
