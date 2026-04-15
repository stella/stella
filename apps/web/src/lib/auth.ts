import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import type { BetterFetchError } from "@better-fetch/fetch";
import type {
  BetterAuthClientOptions,
  BetterAuthClientPlugin,
} from "better-auth/client";
import {
  emailOTPClient,
  inferAdditionalFields,
  lastLoginMethodClient,
  organizationClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

import type { PermissionInput } from "@stella/permissions";
import { ac, roles } from "@stella/permissions";
import { toastManager } from "@stella/ui/components/toast";

import { env } from "@/env";
import { getTranslator, useI18nStore } from "@/i18n/i18n-store";

export const HTTP_TOO_MANY_REQUESTS = 429;

const authClientPlugins = [
  emailOTPClient(),
  lastLoginMethodClient(),
  organizationClient({ ac, roles }),
  inferAdditionalFields({
    user: {
      timezoneId: { type: "string" },
    },
  }),
  // SAFETY: the OAuth provider client is a valid Better Auth client plugin
  // at runtime. This narrow cast keeps the oauth2 endpoints available while
  // working around upstream metadata typing friction.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  oauthProviderClient() as BetterAuthClientPlugin &
    ReturnType<typeof oauthProviderClient>,
];

type StellaAuthClientOptions = BetterAuthClientOptions & {
  plugins: typeof authClientPlugins;
};

// ---------------------------------------------------------------------------
// Explicit client type surface
// ---------------------------------------------------------------------------
// better-auth 1.6.x ships deeply recursive conditional types that cause tsgo
// to hang during type-checking.  We declare only the API surface Stella uses
// and cast the runtime client through `unknown`.
// ---------------------------------------------------------------------------

type AuthError = {
  code?: string | undefined;
  message?: string | undefined;
  status: number;
  statusText: string;
};

type AuthResponse<T> =
  | { data: T; error: null }
  | { data: null; error: AuthError };

type AuthSession = {
  session: {
    id: string;
    token: string;
    userId: string;
    expiresAt: Date;
    activeOrganizationId?: string | null;
  };
  user: {
    id: string;
    email: string;
    name: string | null;
    image?: string | null;
    timezoneId: string;
  };
};

type AuthSessionListItem = {
  id: string;
  token: string;
  userAgent: string | null;
  ipAddress: string | null;
  updatedAt: Date;
  createdAt: Date;
};

type AuthOrganization = {
  id: string;
  name: string;
  slug: string;
};

type AuthMember = {
  id: string;
  organizationId: string;
  userId: string;
  role: Role;
  createdAt: Date;
  user: {
    id: string;
    email: string;
    name: string;
    image?: string | null;
  };
};

type InvitationStatus = "accepted" | "canceled" | "pending" | "rejected";

type AuthInvitation = {
  id: string;
  email: string;
  organizationId: string;
  organizationName: string;
  inviterEmail: string;
  role: Role;
  status: InvitationStatus;
  createdAt: Date;
  expiresAt: Date;
};

type HookResult<T> = {
  data: T | null;
  error: BetterFetchError | null;
  isPending: boolean;
  isRefetching: boolean;
  refetch: () => Promise<void>;
};

type StellaAuthClient = {
  // Session
  getSession: () => Promise<AuthResponse<AuthSession>>;
  useSession: () => HookResult<AuthSession>;

  // User
  signOut: () => Promise<AuthResponse<{ success: boolean }>>;
  updateUser: (
    data: Record<string, unknown>,
  ) => Promise<AuthResponse<{ user: AuthSession["user"] }>>;
  listSessions: () => Promise<AuthResponse<AuthSessionListItem[]>>;
  revokeSession: (data: {
    token: string;
  }) => Promise<AuthResponse<{ success: boolean }>>;
  revokeOtherSessions: () => Promise<AuthResponse<{ success: boolean }>>;

  // Login method
  getLastUsedLoginMethod: () => string | null;

  // Sign-in
  signIn: {
    social: (data: {
      provider: string;
      callbackURL: string;
    }) => Promise<AuthResponse<{ url: string }>>;
    emailOtp: (data: {
      email: string;
      otp: string;
    }) => Promise<AuthResponse<AuthSession>>;
  };

  // Email OTP
  emailOtp: {
    sendVerificationOtp: (data: {
      email: string;
      type: string;
    }) => Promise<AuthResponse<{ success: boolean }>>;
  };

  // Organization
  organization: {
    create: (
      data: Record<string, unknown>,
    ) => Promise<AuthResponse<AuthOrganization>>;
    setActive: (data: {
      organizationId: string;
    }) => Promise<AuthResponse<AuthOrganization>>;
    inviteMember: (data: {
      email: string;
      organizationId?: string | undefined;
      role: string;
      resend?: boolean | undefined;
    }) => Promise<AuthResponse<AuthInvitation>>;
    removeMember: (data: {
      memberIdOrEmail: string;
      organizationId?: string;
    }) => Promise<AuthResponse<AuthMember>>;
    cancelInvitation: (data: {
      invitationId: string;
    }) => Promise<AuthResponse<{ success: boolean }>>;
    checkSlug: (data: {
      slug: string;
    }) => Promise<AuthResponse<{ status: boolean }>>;
    getInvitation: (data: {
      query: { id: string };
    }) => Promise<AuthResponse<AuthInvitation>>;
    acceptInvitation: (data: {
      invitationId: string;
    }) => Promise<AuthResponse<AuthMember>>;
    rejectInvitation: (data: {
      invitationId: string;
    }) => Promise<AuthResponse<{ success: boolean }>>;
    getFullOrganization: () => Promise<
      AuthResponse<{
        id: string;
        name: string;
        slug: string;
        members: AuthMember[];
        invitations: AuthInvitation[];
      }>
    >;
    update: (
      data: Record<string, unknown>,
    ) => Promise<AuthResponse<AuthOrganization>>;
    updateMemberRole: (data: {
      memberId: string;
      role: string;
    }) => Promise<AuthResponse<AuthMember>>;
    getActiveMemberRole: () => Promise<
      AuthResponse<{ role: Role; member: AuthMember }>
    >;
    checkRolePermission: (data: {
      role: string;
      permissions: PermissionInput;
    }) => boolean;
  };

  // Hooks
  useListOrganizations: () => HookResult<AuthOrganization[]>;

  // OAuth2
  oauth2: {
    continue: (
      data: Record<string, unknown>,
    ) => Promise<AuthResponse<{ redirectURL: string }>>;
    publicClient: (data: {
      query: { client_id: string };
    }) => Promise<AuthResponse<Record<string, unknown>>>;
    consent: (data: {
      accept: boolean;
    }) => Promise<AuthResponse<{ redirectURL: string }>>;
  };

  // Error codes
  $ERROR_CODES: Record<string, { code: string; message: string }>;
};

// SAFETY: better-auth 1.6.x deeply recursive conditional types cause tsgo to
// hang.  The runtime client is fully functional; we bypass the problematic
// inferred type with an explicit interface that covers Stella's usage.
// eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
export const authClient = createAuthClient<StellaAuthClientOptions>({
  baseURL: env.VITE_API_URL,
  plugins: authClientPlugins,
  fetchOptions: {
    headers: {
      get "Accept-Language"() {
        return useI18nStore.getState().lang;
      },
    },
    onError: (context) => {
      if (context.response.status === HTTP_TOO_MANY_REQUESTS) {
        const t = getTranslator();
        toastManager.add({
          title: t("auth.rateLimitExceeded"),
          type: "error",
        });
      }
    },
  },
}) as unknown as StellaAuthClient;

export type Role = keyof typeof roles;
export type AuthErrorCode = keyof StellaAuthClient["$ERROR_CODES"];
