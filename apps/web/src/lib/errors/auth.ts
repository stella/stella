import type { organizationClient } from "better-auth/client/plugins";
import { TaggedError } from "better-result";

import type { TranslationKey } from "@/i18n/types";
import { APIError } from "@/lib/errors/api";
import {
  STATUS_ERROR_KEYS,
  STATUS_TO_KEY,
  translateError,
} from "@/lib/errors/localization";

type OrganizationErrorCode = keyof ReturnType<
  typeof organizationClient
>["$ERROR_CODES"];

const ACTION_NOT_ALLOWED = "errors.apiCodes.forbidden";
const NOT_FOUND = "errors.api.notFound";
const CONFLICT = "errors.api.conflict";

/**
 * What each Better Auth organization code tells the person. Total on purpose:
 * a code added by an upgrade fails the build until someone picks its message,
 * so it can never fall through to generic text. Teams and custom roles are not
 * in use, so their codes take the nearest shared message.
 */
const ORGANIZATION_ERROR_KEYS = {
  CANNOT_DELETE_A_PRE_DEFINED_ROLE: CONFLICT,
  EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION:
    "errors.apiCodes.invitationEmailUnverified",
  EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION:
    "errors.apiCodes.invitationEmailUnverified",
  FAILED_TO_RETRIEVE_INVITATION: NOT_FOUND,
  INVALID_RESOURCE: "errors.api.badRequest",
  INVALID_TEAM_ID: "errors.api.badRequest",
  INVITATION_LIMIT_REACHED: "errors.apiCodes.invitationLimitReached",
  INVITATION_NOT_FOUND: NOT_FOUND,
  INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION: CONFLICT,
  MEMBER_NOT_FOUND: NOT_FOUND,
  MISSING_AC_INSTANCE: "errors.api.badRequest",
  NO_ACTIVE_ORGANIZATION: NOT_FOUND,
  ORGANIZATION_ALREADY_EXISTS: "organization.creationSlugConflict",
  ORGANIZATION_MEMBERSHIP_LIMIT_REACHED:
    "errors.apiCodes.organizationMemberLimitReached",
  ORGANIZATION_NOT_FOUND: NOT_FOUND,
  ORGANIZATION_SLUG_ALREADY_TAKEN: "organization.creationSlugConflict",
  ROLE_IS_ASSIGNED_TO_MEMBERS: CONFLICT,
  ROLE_NAME_IS_ALREADY_TAKEN: CONFLICT,
  ROLE_NOT_FOUND: NOT_FOUND,
  TEAM_ALREADY_EXISTS: CONFLICT,
  TEAM_MEMBER_LIMIT_REACHED: CONFLICT,
  TEAM_NOT_FOUND: NOT_FOUND,
  TOO_MANY_ROLES: CONFLICT,
  UNABLE_TO_REMOVE_LAST_TEAM: CONFLICT,
  USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION:
    "errors.apiCodes.alreadyOrganizationMember",
  USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION:
    "errors.apiCodes.invitationAlreadyPending",
  USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION: NOT_FOUND,
  USER_IS_NOT_A_MEMBER_OF_THE_TEAM: NOT_FOUND,
  YOU_ARE_NOT_ALLOWED_TO_ACCESS_THIS_ORGANIZATION: ACTION_NOT_ALLOWED,
  YOU_ARE_NOT_ALLOWED_TO_CANCEL_THIS_INVITATION: ACTION_NOT_ALLOWED,
  YOU_ARE_NOT_ALLOWED_TO_CREATE_A_NEW_ORGANIZATION: ACTION_NOT_ALLOWED,
  YOU_ARE_NOT_ALLOWED_TO_CREATE_A_NEW_TEAM: ACTION_NOT_ALLOWED,
  YOU_ARE_NOT_ALLOWED_TO_CREATE_A_NEW_TEAM_MEMBER: ACTION_NOT_ALLOWED,
  YOU_ARE_NOT_ALLOWED_TO_CREATE_A_ROLE: ACTION_NOT_ALLOWED,
  YOU_ARE_NOT_ALLOWED_TO_CREATE_TEAMS_IN_THIS_ORGANIZATION: ACTION_NOT_ALLOWED,
  YOU_ARE_NOT_ALLOWED_TO_DELETE_A_ROLE: ACTION_NOT_ALLOWED,
  YOU_ARE_NOT_ALLOWED_TO_DELETE_TEAMS_IN_THIS_ORGANIZATION: ACTION_NOT_ALLOWED,
  YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER: ACTION_NOT_ALLOWED,
  YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_ORGANIZATION: ACTION_NOT_ALLOWED,
  YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_TEAM: ACTION_NOT_ALLOWED,
  YOU_ARE_NOT_ALLOWED_TO_GET_A_ROLE: ACTION_NOT_ALLOWED,
  YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION: ACTION_NOT_ALLOWED,
  YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE:
    "errors.apiCodes.invitationRoleNotAllowed",
  YOU_ARE_NOT_ALLOWED_TO_LIST_A_ROLE: ACTION_NOT_ALLOWED,
  YOU_ARE_NOT_ALLOWED_TO_READ_A_ROLE: ACTION_NOT_ALLOWED,
  YOU_ARE_NOT_ALLOWED_TO_REMOVE_A_TEAM_MEMBER: ACTION_NOT_ALLOWED,
  YOU_ARE_NOT_ALLOWED_TO_UPDATE_A_ROLE: ACTION_NOT_ALLOWED,
  YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER: ACTION_NOT_ALLOWED,
  YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_ORGANIZATION: ACTION_NOT_ALLOWED,
  YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_TEAM: ACTION_NOT_ALLOWED,
  YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION:
    "errors.apiCodes.notOrganizationMember",
  YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION:
    "errors.apiCodes.invitationOtherRecipient",
  YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER:
    "errors.apiCodes.organizationLastOwner",
  YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER:
    "errors.apiCodes.organizationLastOwner",
  YOU_CAN_NOT_ACCESS_THE_MEMBERS_OF_THIS_TEAM: ACTION_NOT_ALLOWED,
  YOU_DO_NOT_HAVE_AN_ACTIVE_TEAM: NOT_FOUND,
  YOU_HAVE_REACHED_THE_MAXIMUM_NUMBER_OF_ORGANIZATIONS:
    "organization.creationNotAllowed",
  YOU_HAVE_REACHED_THE_MAXIMUM_NUMBER_OF_TEAMS: CONFLICT,
  YOU_MUST_BE_IN_AN_ORGANIZATION_TO_CREATE_A_ROLE: ACTION_NOT_ALLOWED,
} as const satisfies Record<OrganizationErrorCode, TranslationKey>;

const AUTH_ERROR_KEYS = {
  ...ORGANIZATION_ERROR_KEYS,
  DISPOSABLE_EMAIL_NOT_ALLOWED: "errors.apiCodes.disposableEmailNotAllowed",
} as const satisfies Record<string, TranslationKey>;

type AuthErrorCode = keyof typeof AUTH_ERROR_KEYS;

export class AuthClientError extends TaggedError("AuthClientError")<{
  code?: AuthErrorCode | undefined;
  message: string;
  status: number;
  statusText: string;
}> {}

type ToAuthClientErrorProps = {
  code?: string | undefined;
  message?: string | undefined;
  status: number;
  statusText: string;
};

/** Whether this code has a message of its own, so a caller can just show it. */
export const isAuthClientErrorCode = (code: string): code is AuthErrorCode =>
  Object.hasOwn(AUTH_ERROR_KEYS, code);

export const toAuthClientError = (props: ToAuthClientErrorProps) => {
  const { code, status, statusText } = props;
  const message = translateError(
    STATUS_TO_KEY[status] ?? STATUS_ERROR_KEYS.unknown,
  );
  if (!code) {
    return new AuthClientError({ message, status, statusText });
  }
  if (isAuthClientErrorCode(code)) {
    return new AuthClientError({
      code,
      message: translateError(AUTH_ERROR_KEYS[code]),
      status,
      statusText,
    });
  }
  return new APIError({
    code,
    message,
    rawMessage: props.message,
    status,
  });
};

export const isMemberError = (error: unknown) =>
  AuthClientError.is(error) &&
  error.code === "YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION";

export const isUnauthorizedError = (error: unknown) =>
  (APIError.is(error) || AuthClientError.is(error)) && error.status === 401;
