import { getOAuthState } from "better-auth/api";
import { panic } from "better-result";
import { and, eq, isNull, sql } from "drizzle-orm";

import {
  PROFESSIONAL_USE_DISPLAYED_VERSION_FIELD,
  PROFESSIONAL_USE_STATEMENT_VERSION,
  PROFESSIONAL_USE_STATUS,
  PROFESSIONAL_USE_TERMS_VERSION,
} from "@stll/api-contract/professional-use";

import { member } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  organizationProfessionalUseAcceptances,
  userProfessionalUseAcceptances,
} from "@/api/db/schema";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  recordAuditGroups,
} from "@/api/lib/audit-log";
import { AGENT_IDENTITY_CREATE_USER_PATH } from "@/api/lib/auth/agent-auth-user";
import { REVIEW_ACCOUNT_CREATE_USER_PATH } from "@/api/lib/auth/review-account-plugin";
import type { SafeId } from "@/api/lib/branded-types";
import type { MemberRole } from "@/api/lib/member-roles";
import { brandPersistedOrganizationId } from "@/api/lib/safe-id-boundaries";
import { isRecord } from "@/api/lib/type-guards";

const PROFESSIONAL_USE_AUDIT_FIELD = "professionalUseAcceptance";
const PROFESSIONAL_USE_LOCK_DOMAIN = "professional-use";
const OWNER_ROLE = "owner" satisfies MemberRole;

/** Where an account was created. */
const USER_CREATION_ORIGIN = {
  /** Email-OTP sign-in on the sign-in panel, which shows the statement. */
  emailOtpRegistration: "email_otp_registration",
  /** A social provider's callback, after the sign-in panel showed it. */
  socialRegistration: "social_registration",
  /** The self-host first-account sign-up on the sign-in panel. */
  bootstrapRegistration: "bootstrap_registration",
  /** A provider ID token posted straight to the API; no Stella page is shown. */
  identityTokenSignIn: "identity_token_sign_in",
  /** An agent's verified identity, provisioned without a browser. */
  agentProvisioning: "agent_provisioning",
  /** The operator command that creates the review account. */
  operatorCommand: "operator_command",
} as const;

type UserCreationOrigin =
  (typeof USER_CREATION_ORIGIN)[keyof typeof USER_CREATION_ORIGIN];

/**
 * Where a registration request names the statement version its page
 * displayed: the request body, or the OAuth state the social sign-in wrote
 * (its `additionalData`) and the callback read back.
 */
type DisplayedVersionCarrier = "request_body" | "oauth_state";

type StatementAtCreation =
  | { type: "shown"; displayedVersionIn: DisplayedVersionCarrier }
  | { type: "not_shown" };

/**
 * Whether each creation origin shows the statement, and where a showing
 * origin's request names the version it displayed. Total over the origins,
 * so a new origin cannot land without this decision.
 */
const STATEMENT_AT_CREATION = {
  email_otp_registration: { type: "shown", displayedVersionIn: "request_body" },
  social_registration: { type: "shown", displayedVersionIn: "oauth_state" },
  bootstrap_registration: { type: "shown", displayedVersionIn: "request_body" },
  identity_token_sign_in: { type: "not_shown" },
  agent_provisioning: { type: "not_shown" },
  operator_command: { type: "not_shown" },
} as const satisfies Record<UserCreationOrigin, StatementAtCreation>;

/**
 * The Better Auth endpoint paths that create an account, by origin. A path
 * missing here refuses the creation (`requireUserCreationOrigin`), so a new
 * creation path cannot record, or skip, an acceptance by default.
 */
const USER_CREATION_PATH_ORIGINS = new Map([
  ["/sign-in/email-otp", USER_CREATION_ORIGIN.emailOtpRegistration],
  ["/callback/:id", USER_CREATION_ORIGIN.socialRegistration],
  ["/sign-up/email", USER_CREATION_ORIGIN.bootstrapRegistration],
  ["/sign-in/social", USER_CREATION_ORIGIN.identityTokenSignIn],
  [AGENT_IDENTITY_CREATE_USER_PATH, USER_CREATION_ORIGIN.agentProvisioning],
  [REVIEW_ACCOUNT_CREATE_USER_PATH, USER_CREATION_ORIGIN.operatorCommand],
]);

// Every social provider calls back on `/callback/:id`; a request carries the
// provider (`/callback/google`), a server call the template.
const SOCIAL_CALLBACK_PREFIX = "/callback/";

/**
 * The origin of an account created by the endpoint at `path` (the user
 * hook's endpoint context). Panics on any other path, or none: account
 * creation outside the listed endpoints is a programming error.
 */
export const requireUserCreationOrigin = (
  path: string | undefined,
): UserCreationOrigin => {
  const endpoint = path?.startsWith(SOCIAL_CALLBACK_PREFIX)
    ? "/callback/:id"
    : path;
  const origin =
    endpoint === undefined
      ? undefined
      : USER_CREATION_PATH_ORIGINS.get(endpoint);
  return (
    origin ??
    panic(
      `Account creation through ${endpoint ?? "no endpoint"} has no professional-use origin`,
    )
  );
};

type AcceptingUser = { userId: SafeId<"user">; statementVersion: string };

/**
 * Insert-once acceptance of a statement version. The caller holds the
 * account's row lock (`lockAccount`) or is creating the account.
 */
const insertUserAcceptance = async (
  tx: Pick<Transaction, "insert">,
  { userId, statementVersion }: AcceptingUser,
): Promise<void> => {
  // audit: skip - audit rows are organization-scoped; each organization acceptance row is audited
  await tx
    .insert(userProfessionalUseAcceptances)
    .values({
      userId,
      statementVersion,
      termsVersion: PROFESSIONAL_USE_TERMS_VERSION,
    })
    .onConflictDoNothing({ target: userProfessionalUseAcceptances.userId });
};

/**
 * Whether creating an account was its acceptance. Only a showing origin
 * whose request names the current statement version accepted; a version
 * that is absent (a page that never sent one) or stale (cached assets, or a
 * statement updated since) leaves the account `required`, to accept on its
 * first interactive sign-in.
 */
export type CreationAcceptance =
  | { type: "accepted"; statementVersion: string }
  | {
      type: "required";
      reason:
        | "statement_not_shown"
        | "displayed_version_absent"
        | "displayed_version_stale";
    };

/** The parts of the user hook's endpoint context the decision reads. */
type CreationContext = { path: string; body: unknown } | null | undefined;

const readDisplayedVersion = async (
  carrier: DisplayedVersionCarrier,
  context: CreationContext,
): Promise<unknown> => {
  switch (carrier) {
    case "request_body":
      return isRecord(context?.body)
        ? context.body[PROFESSIONAL_USE_DISPLAYED_VERSION_FIELD]
        : undefined;
    case "oauth_state": {
      const state: unknown = await getOAuthState();
      return isRecord(state)
        ? state[PROFESSIONAL_USE_DISPLAYED_VERSION_FIELD]
        : undefined;
    }
    default:
      carrier satisfies never;
      return panic("Unhandled displayed-version carrier");
  }
};

/**
 * Decide, inside the user hook, whether the account being created accepted
 * the statement. Panics on a creation path without an origin.
 */
export const readCreationAcceptance = async (
  context: CreationContext,
): Promise<CreationAcceptance> => {
  const statement =
    STATEMENT_AT_CREATION[requireUserCreationOrigin(context?.path)];
  switch (statement.type) {
    case "not_shown":
      return { type: "required", reason: "statement_not_shown" };
    case "shown": {
      const displayed = await readDisplayedVersion(
        statement.displayedVersionIn,
        context,
      );
      if (typeof displayed !== "string") {
        return { type: "required", reason: "displayed_version_absent" };
      }
      return displayed === PROFESSIONAL_USE_STATEMENT_VERSION
        ? { type: "accepted", statementVersion: displayed }
        : { type: "required", reason: "displayed_version_stale" };
    }
    default:
      statement satisfies never;
      return panic("Unhandled professional-use statement disposition");
  }
};

type UserCreation = {
  userId: SafeId<"user">;
  acceptance: CreationAcceptance;
};

/**
 * Record a new account's acceptance when creating it was one. Otherwise the
 * account starts `required` and accepts on its first interactive sign-in.
 */
export const recordUserProfessionalUseAtCreation = async (
  db: Pick<Transaction, "insert">,
  { userId, acceptance }: UserCreation,
): Promise<void> => {
  switch (acceptance.type) {
    case "accepted":
      await insertUserAcceptance(db, {
        userId,
        statementVersion: acceptance.statementVersion,
      });
      return;
    case "required":
      return;
    default:
      acceptance satisfies never;
      panic("Unhandled creation acceptance");
  }
};

/** An account's professional-use state, read from its acceptance row. */
export type UserProfessionalUseState =
  | {
      status: typeof PROFESSIONAL_USE_STATUS.accepted;
      statementVersion: string;
      termsVersion: string;
      acceptedAt: Date;
    }
  | { status: typeof PROFESSIONAL_USE_STATUS.required };

type AcceptanceColumns = {
  statementVersion: string | null;
  termsVersion: string | null;
  acceptedAt: Date | null;
};

/** The state a (left-joined) acceptance row describes. */
export const professionalUseStateOf = ({
  statementVersion,
  termsVersion,
  acceptedAt,
}: AcceptanceColumns): UserProfessionalUseState =>
  statementVersion === null || termsVersion === null || acceptedAt === null
    ? { status: PROFESSIONAL_USE_STATUS.required }
    : {
        status: PROFESSIONAL_USE_STATUS.accepted,
        statementVersion,
        termsVersion,
        acceptedAt,
      };

/** Columns for a left join on `userProfessionalUseAcceptances`. */
export const professionalUseColumns = {
  statementVersion: userProfessionalUseAcceptances.statementVersion,
  termsVersion: userProfessionalUseAcceptances.termsVersion,
  acceptedAt: userProfessionalUseAcceptances.acceptedAt,
};

export const readUserProfessionalUse = async (
  db: Pick<Transaction, "select">,
  userId: SafeId<"user">,
): Promise<UserProfessionalUseState> => {
  const row = await db
    .select(professionalUseColumns)
    .from(userProfessionalUseAcceptances)
    .where(eq(userProfessionalUseAcceptances.userId, userId))
    .limit(1)
    .then((rows) => rows.at(0));
  return row === undefined
    ? { status: PROFESSIONAL_USE_STATUS.required }
    : professionalUseStateOf(row);
};

/**
 * Serializes an account's acceptance with its organizations' reads of it:
 * an organization created while its creator accepts is recorded by exactly
 * one of the two transactions.
 */
const lockAccount = async (
  tx: Transaction,
  userId: SafeId<"user">,
): Promise<void> => {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`${PROFESSIONAL_USE_LOCK_DOMAIN}:${userId}`}))`,
  );
};

type AcceptedVersions = { statementVersion: string; termsVersion: string };

type InsertOrganizationAcceptancesOptions = {
  tx: Transaction;
  organizationIds: readonly SafeId<"organization">[];
  userId: SafeId<"user">;
  versions: AcceptedVersions;
};

/**
 * Insert-once organization acceptances carrying `userId`'s accepted
 * versions; each one that inserts is audited in the same transaction.
 */
const insertOrganizationAcceptances = async ({
  tx,
  organizationIds,
  userId,
  versions,
}: InsertOrganizationAcceptancesOptions): Promise<void> => {
  if (organizationIds.length === 0) {
    return;
  }
  const inserted = await tx
    .insert(organizationProfessionalUseAcceptances)
    .values(
      organizationIds.map((id) => ({
        organizationId: id,
        acceptedByUserId: userId,
        ...versions,
      })),
    )
    .onConflictDoNothing({
      target: organizationProfessionalUseAcceptances.organizationId,
    })
    .returning({
      organizationId: organizationProfessionalUseAcceptances.organizationId,
    });
  await recordAuditGroups({
    tx,
    groups: inserted.map((row) => ({
      bindings: {
        organizationId: brandPersistedOrganizationId(row.organizationId),
        workspaceId: null,
        userId,
        execution: {
          performer: { type: "user", id: userId },
          trigger: { type: "direct" },
        },
      },
      events: [
        {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
          resourceId: row.organizationId,
          metadata: { field: PROFESSIONAL_USE_AUDIT_FIELD, ...versions },
        },
      ],
    })),
  });
};

type RecordOrganizationProfessionalUseOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

/**
 * Record the acceptance an organization is created under: the versions its
 * creator accepted, read in this transaction, never the current ones. A
 * creator who has not accepted yet records nothing; the organization is
 * recorded when an owner accepts (`acceptProfessionalUse`). Insert-once,
 * audited in the same transaction.
 */
export const recordOrganizationProfessionalUse = async ({
  tx,
  organizationId,
  userId,
}: RecordOrganizationProfessionalUseOptions): Promise<void> => {
  await lockAccount(tx, userId);
  const creator = await readUserProfessionalUse(tx, userId);
  switch (creator.status) {
    case PROFESSIONAL_USE_STATUS.required:
      return;
    case PROFESSIONAL_USE_STATUS.accepted:
      await insertOrganizationAcceptances({
        tx,
        organizationIds: [organizationId],
        userId,
        versions: {
          statementVersion: creator.statementVersion,
          termsVersion: creator.termsVersion,
        },
      });
      return;
    default:
      creator satisfies never;
      panic("Unhandled professional-use state");
  }
};

type AcceptProfessionalUseOptions = {
  tx: Transaction;
  userId: SafeId<"user">;
};

/**
 * An account's acceptance on the interactive prompt, recorded the way
 * registration records it: the account's row, then the organizations it owns
 * that have none yet (created before it accepted), each carrying the
 * account's accepted versions and audited. Insert-once: a repeated
 * acceptance keeps the first one.
 */
export const acceptProfessionalUse = async ({
  tx,
  userId,
}: AcceptProfessionalUseOptions): Promise<void> => {
  await lockAccount(tx, userId);
  await insertUserAcceptance(tx, {
    userId,
    statementVersion: PROFESSIONAL_USE_STATEMENT_VERSION,
  });
  const accepted = await readUserProfessionalUse(tx, userId);
  if (accepted.status !== PROFESSIONAL_USE_STATUS.accepted) {
    return panic("The professional-use acceptance did not persist");
  }
  // Bounded by the organizations one account owns.
  const pending = await tx
    .select({ organizationId: member.organizationId })
    .from(member)
    .leftJoin(
      organizationProfessionalUseAcceptances,
      eq(
        organizationProfessionalUseAcceptances.organizationId,
        member.organizationId,
      ),
    )
    .where(
      and(
        eq(member.userId, userId),
        eq(member.role, OWNER_ROLE),
        isNull(organizationProfessionalUseAcceptances.organizationId),
      ),
    );
  await insertOrganizationAcceptances({
    tx,
    organizationIds: pending.map((row) =>
      brandPersistedOrganizationId(row.organizationId),
    ),
    userId,
    versions: {
      statementVersion: accepted.statementVersion,
      termsVersion: accepted.termsVersion,
    },
  });
};
