import { Result } from "better-result";
import * as v from "valibot";

import type { SafeId } from "@/api/lib/branded-types";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";

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
  type: "missing_scope";
};

type AdmitLawReadOptions = {
  organizationId: SafeId<"organization">;
  publicLawEnabled?: () => boolean;
};

export const admitLawRead = ({
  organizationId,
  publicLawEnabled = () => isDeploymentFeatureEnabled("FEATURE_PUBLIC_LAW"),
}: AdmitLawReadOptions): Result<LawReadAdmission, LawReadAdmissionError> => {
  if (!publicLawEnabled()) {
    return Result.err({ type: "missing_scope" as const });
  }
  return Result.ok(v.parse(lawReadAdmissionSchema, { organizationId }));
};
