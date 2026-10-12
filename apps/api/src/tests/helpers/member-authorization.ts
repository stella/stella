import {
  PROFESSIONAL_USE_STATEMENT_VERSION,
  PROFESSIONAL_USE_STATUS,
  PROFESSIONAL_USE_TERMS_VERSION,
} from "@stll/api-contract/professional-use";

/**
 * Account facts a member authorization carries, for fakes of the member
 * lookup that are not about feature access or professional use: a verified
 * member with no enrolments whose account has accepted the professional-use
 * statement.
 */
export const PLAIN_MEMBER_FACTS = {
  emailVerified: true,
  userDeleted: false,
  enrolledFeatureIds: [],
  professionalUse: {
    status: PROFESSIONAL_USE_STATUS.accepted,
    statementVersion: PROFESSIONAL_USE_STATEMENT_VERSION,
    termsVersion: PROFESSIONAL_USE_TERMS_VERSION,
    acceptedAt: new Date(0),
  },
} as const;
