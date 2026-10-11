import { Result } from "better-result";
import * as v from "valibot";

import {
  LAW_READ_REFUSAL_CODE,
  type LawReadRefusalCode,
} from "@stll/api-contract/law-read-admission";

import { mayReadPublicLawForOrganization } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

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

export type LawReadAdmissionError = { type: LawReadRefusalCode };

export const isLawReadAdmissionErrorCode = (
  code: unknown,
): code is LawReadAdmissionError["type"] =>
  Object.values(LAW_READ_REFUSAL_CODE).some((candidate) => candidate === code);

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
    return Result.err({ type: LAW_READ_REFUSAL_CODE.missingScope });
  }
  const entitled = await mayReadPublicLaw(organizationId);
  if (Result.isError(entitled)) {
    return Result.err({ type: LAW_READ_REFUSAL_CODE.accessUnavailable });
  }
  if (!entitled.value) {
    return Result.err({ type: LAW_READ_REFUSAL_CODE.notEntitled });
  }
  return Result.ok(v.parse(lawReadAdmissionSchema, { organizationId }));
};

export const admitLawReadOrError = async (options: AdmitLawReadOptions) =>
  (await admitLawRead(options)).mapError(
    ({ type }) =>
      new HandlerError<403 | 503>({
        status: type === LAW_READ_REFUSAL_CODE.accessUnavailable ? 503 : 403,
        code: type,
        message: type,
      }),
  );

export const LAW_READ_REFUSAL_DESCRIPTION =
  "Organization law reads may return not_entitled (403), missing_scope (403; public law disabled), or access_unavailable (503; retry later).";
