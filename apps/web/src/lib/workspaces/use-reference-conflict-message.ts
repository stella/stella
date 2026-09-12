import { useTranslations } from "use-intl";

import { MATTER_REFERENCE_RETIRED_CODE } from "@stll/api-contract";

import { APIError } from "@/lib/errors/api";

/**
 * Wording for a rejected matter reference, shared by every surface that edits
 * one so the two conflicts cannot drift apart: a reference another live matter
 * holds is free again once that matter releases it, while a reference documents
 * were numbered under is retired for good. Returns null when the failure is not
 * a reference conflict, leaving the caller's generic error path in charge.
 */
export const useReferenceConflictMessage = () => {
  const t = useTranslations();

  return (error: unknown, reference: string) => {
    if (!APIError.is(error) || error.status !== 409) {
      return null;
    }

    return error.code === MATTER_REFERENCE_RETIRED_CODE
      ? t("workspaces.referenceRetired", { reference })
      : t("workspaces.referenceTaken");
  };
};
