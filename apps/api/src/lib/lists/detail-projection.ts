import { LIST_DETAILS_STATUS } from "@stll/api-contract/list-details";

import type {
  entities,
  legalListFactDetails,
  legalListItemSources,
} from "@/api/db/schema";
import { isFeatureEnabled } from "@/api/lib/auth/feature-access/policy";
import type {
  FeatureAccessPrincipal,
  FeatureAccessSnapshot,
} from "@/api/lib/auth/feature-access/policy";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";

type ListDetailProjectionContext = {
  principal: FeatureAccessPrincipal;
  featureAccessSnapshot: FeatureAccessSnapshot | undefined;
};

const verificationDetailsVisible = ({
  principal,
  featureAccessSnapshot,
}: ListDetailProjectionContext) =>
  featureAccessSnapshot !== undefined &&
  isFeatureEnabled(
    featureAccessSnapshot,
    LIST_VERIFICATION_FEATURE_ID,
    principal,
  );

type FactItemDetails = {
  factDetails: Pick<
    typeof legalListFactDetails.$inferSelect,
    | "confidence"
    | "occurredOn"
    | "occurredOnPrecision"
    | "evidenceKind"
    | "medium"
    | "interpretationNote"
    | "scoring"
  > | null;
  firstSource: {
    documentId: typeof legalListItemSources.$inferSelect.sourceEntityId;
    documentName: typeof entities.$inferSelect.name;
    locator: typeof legalListItemSources.$inferSelect.locator;
  } | null;
};

export const projectListFactDetails = <T extends FactItemDetails>(
  { factDetails, firstSource, ...item }: T,
  context: ListDetailProjectionContext,
) => {
  if (!verificationDetailsVisible(context)) {
    return {
      ...item,
      factDetailsStatus: LIST_DETAILS_STATUS.featureUnavailable,
      factDetails: null,
      firstSource: null,
    };
  }
  return {
    ...item,
    factDetailsStatus: LIST_DETAILS_STATUS.visible,
    factDetails,
    firstSource,
  };
};

type SourceVerificationDetails = Pick<
  typeof legalListItemSources.$inferSelect,
  "verificationStatus" | "verifiedBy" | "verifiedAt"
>;

export const projectListSourceVerification = <
  T extends SourceVerificationDetails,
>(
  { verificationStatus, verifiedBy, verifiedAt, ...source }: T,
  context: ListDetailProjectionContext,
) => {
  if (!verificationDetailsVisible(context)) {
    return {
      ...source,
      verificationDetailsStatus: LIST_DETAILS_STATUS.featureUnavailable,
      verificationStatus: null,
      verifiedBy: null,
      verifiedAt: null,
    };
  }
  return {
    ...source,
    verificationDetailsStatus: LIST_DETAILS_STATUS.visible,
    verificationStatus,
    verifiedBy,
    verifiedAt,
  };
};
