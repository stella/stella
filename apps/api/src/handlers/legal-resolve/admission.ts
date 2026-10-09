import { Result } from "better-result";
import * as v from "valibot";

import type { SafeId } from "@/api/lib/branded-types";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { mayReadPublicLawForOrganization } from "@/api/lib/usage/organization-public-law-access";

type LawReadClaim = Readonly<{
  organizationId: SafeId<"organization">;
}>;

const lawReadAdmissionSchema = v.pipe(
  v.custom<LawReadClaim>(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      "organizationId" in value &&
      typeof value.organizationId === "string",
  ),
  v.brand("LawReadAdmission"),
);

export type LawReadAdmission = v.InferOutput<typeof lawReadAdmissionSchema>;

type LawReadAdmissionError = {
  type: "access_unavailable" | "missing_scope" | "not_entitled";
};

type AdmitLawReadOptions = {
  organizationId: SafeId<"organization">;
  mayReadPublicLaw?: (
    organizationId: SafeId<"organization">,
  ) => ReturnType<typeof mayReadPublicLawForOrganization>;
  publicLawEnabled?: () => boolean;
};

export const admitLawRead = async ({
  organizationId,
  mayReadPublicLaw = mayReadPublicLawForOrganization,
  publicLawEnabled = () => isDeploymentFeatureEnabled("FEATURE_PUBLIC_LAW"),
}: AdmitLawReadOptions): Promise<
  Result<LawReadAdmission, LawReadAdmissionError>
> => {
  if (!publicLawEnabled()) {
    return Result.err({ type: "missing_scope" as const });
  }
  const entitled = await mayReadPublicLaw(organizationId);
  if (Result.isError(entitled)) {
    return Result.err({ type: "access_unavailable" as const });
  }
  if (!entitled.value) {
    return Result.err({ type: "not_entitled" as const });
  }
  return Result.ok(v.parse(lawReadAdmissionSchema, { organizationId }));
};
