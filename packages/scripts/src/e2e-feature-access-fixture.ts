import * as v from "valibot";

export const ROUTE_SMOKE_SCALE_SIZES = ["small", "large"] as const;
export type RouteSmokeScaleSize = (typeof ROUTE_SMOKE_SCALE_SIZES)[number];

export const routeSmokeScaleEmail = (
  size: RouteSmokeScaleSize,
  organizationId: string,
): string => `route-smoke-scale-${size}-${organizationId}@stella.dev`;

export const seededOrganizationSlug = (organizationId: string): string =>
  `seed-org-${organizationId.toLowerCase()}`;

const scaleIdentitySchema = v.object({
  organizationId: v.string(),
  email: v.pipe(v.string(), v.email()),
});

/** The private fixture is shared by API startup, scoped seed and browser setup. */
export const e2eFeatureAccessFixtureSchema = v.pipe(
  v.object({
    organizationId: v.string(),
    email: v.pipe(v.string(), v.email()),
    grants: v.record(
      v.string(),
      v.array(
        v.object({
          type: v.literal("organization"),
          organizationId: v.string(),
        }),
      ),
    ),
    routeSmokeScale: v.object({
      small: scaleIdentitySchema,
      large: scaleIdentitySchema,
    }),
  }),
  v.check(
    ({ organizationId, routeSmokeScale, grants }) =>
      routeSmokeScale.small.organizationId !==
        routeSmokeScale.large.organizationId &&
      organizationId !== routeSmokeScale.small.organizationId &&
      organizationId !== routeSmokeScale.large.organizationId &&
      grants["legal-lists"]?.some(
        (grant) => grant.organizationId === organizationId,
      ) === true &&
      ROUTE_SMOKE_SCALE_SIZES.every((size) => {
        const identity = routeSmokeScale[size];
        return (
          identity.email ===
            routeSmokeScaleEmail(size, identity.organizationId) &&
          grants["legal-lists"]?.some(
            (grant) => grant.organizationId === identity.organizationId,
          ) === true
        );
      }),
  ),
);
