import { panic } from "better-result";

import type { RateLimitBudgetConfiguration } from "@/api/lib/rate-limit/budget-config-schema";

let budgetReader: (() => RateLimitBudgetConfiguration) | null = null;

export const bindRateLimitBudgetReader = (
  reader: () => RateLimitBudgetConfiguration,
): void => {
  if (budgetReader !== null) {
    panic("Rate-limit budget environment reader is already bound.");
  }
  budgetReader = reader;
};

const readConfiguredBudgets = (): RateLimitBudgetConfiguration => {
  if (budgetReader === null) {
    return panic("Rate-limit budget environment reader is not bound.");
  }
  return budgetReader();
};

const createAuthBudgets = (
  getConfiguration: () => RateLimitBudgetConfiguration,
) => ({
  AUTH_RATE_LIMITS: {
    defaultSensitive: {
      get max() {
        return getConfiguration().RATE_LIMIT_AUTH_DEFAULT_SENSITIVE_MAX;
      },
      get window() {
        return getConfiguration()
          .RATE_LIMIT_AUTH_DEFAULT_SENSITIVE_WINDOW_SECONDS;
      },
    },
    defaultEmail: {
      get max() {
        return getConfiguration().RATE_LIMIT_AUTH_DEFAULT_EMAIL_MAX;
      },
      get window() {
        return getConfiguration().RATE_LIMIT_AUTH_DEFAULT_EMAIL_WINDOW_SECONDS;
      },
    },
    twoFactor: {
      get max() {
        return getConfiguration().RATE_LIMIT_AUTH_TWO_FACTOR_MAX;
      },
      get window() {
        return getConfiguration().RATE_LIMIT_AUTH_TWO_FACTOR_WINDOW_SECONDS;
      },
    },
    global: {
      get max() {
        return getConfiguration().RATE_LIMIT_AUTH_GLOBAL_MAX;
      },
      get window() {
        return getConfiguration().RATE_LIMIT_AUTH_GLOBAL_WINDOW_SECONDS;
      },
    },
    signIn: {
      get max() {
        return getConfiguration().RATE_LIMIT_AUTH_SIGN_IN_MAX;
      },
      get window() {
        return getConfiguration().RATE_LIMIT_AUTH_SIGN_IN_WINDOW_SECONDS;
      },
    },
    signUp: {
      get max() {
        return getConfiguration().RATE_LIMIT_AUTH_SIGN_UP_MAX;
      },
      get window() {
        return getConfiguration().RATE_LIMIT_AUTH_SIGN_UP_WINDOW_SECONDS;
      },
    },
    sendOtp: {
      get max() {
        return getConfiguration().RATE_LIMIT_AUTH_SEND_OTP_MAX;
      },
      get window() {
        return getConfiguration().RATE_LIMIT_AUTH_SEND_OTP_WINDOW_SECONDS;
      },
    },
    verifyOtp: {
      get max() {
        return getConfiguration().RATE_LIMIT_AUTH_VERIFY_OTP_MAX;
      },
      get window() {
        return getConfiguration().RATE_LIMIT_AUTH_VERIFY_OTP_WINDOW_SECONDS;
      },
    },
    forgetPassword: {
      get max() {
        return getConfiguration().RATE_LIMIT_AUTH_FORGET_PASSWORD_MAX;
      },
      get window() {
        return getConfiguration()
          .RATE_LIMIT_AUTH_FORGET_PASSWORD_WINDOW_SECONDS;
      },
    },
    resetPassword: {
      get max() {
        return getConfiguration().RATE_LIMIT_AUTH_RESET_PASSWORD_MAX;
      },
      get window() {
        return getConfiguration().RATE_LIMIT_AUTH_RESET_PASSWORD_WINDOW_SECONDS;
      },
    },
    oauthToken: {
      get max() {
        return getConfiguration().RATE_LIMIT_AUTH_OAUTH_TOKEN_MAX;
      },
      get window() {
        return getConfiguration().RATE_LIMIT_AUTH_OAUTH_TOKEN_WINDOW_SECONDS;
      },
    },
    oauthAuthorization: {
      get max() {
        return getConfiguration().RATE_LIMIT_AUTH_OAUTH_AUTHORIZATION_MAX;
      },
      get window() {
        return getConfiguration()
          .RATE_LIMIT_AUTH_OAUTH_AUTHORIZATION_WINDOW_SECONDS;
      },
    },
    oauthClientRegistration: {
      get max() {
        return getConfiguration().RATE_LIMIT_AUTH_OAUTH_CLIENT_REGISTRATION_MAX;
      },
      get window() {
        return getConfiguration()
          .RATE_LIMIT_AUTH_OAUTH_CLIENT_REGISTRATION_WINDOW_SECONDS;
      },
    },
    authSharedAddress: {
      get max() {
        return getConfiguration().RATE_LIMIT_AUTH_AUTH_SHARED_ADDRESS_MAX;
      },
      get window() {
        return getConfiguration()
          .RATE_LIMIT_AUTH_AUTH_SHARED_ADDRESS_WINDOW_SECONDS;
      },
    },
    oauthAnonymousClientRegistration: {
      get max() {
        return getConfiguration()
          .RATE_LIMIT_AUTH_OAUTH_ANONYMOUS_CLIENT_REGISTRATION_MAX;
      },
      get window() {
        return getConfiguration()
          .RATE_LIMIT_AUTH_OAUTH_ANONYMOUS_CLIENT_REGISTRATION_WINDOW_SECONDS;
      },
    },
    oauthAnonymousAddress: {
      get max() {
        return getConfiguration().RATE_LIMIT_AUTH_OAUTH_ANONYMOUS_ADDRESS_MAX;
      },
      get window() {
        return getConfiguration()
          .RATE_LIMIT_AUTH_OAUTH_ANONYMOUS_ADDRESS_WINDOW_SECONDS;
      },
    },
  },
});

const createApiBudgets = (
  getConfiguration: () => RateLimitBudgetConfiguration,
) => ({
  API_RATE_LIMITS: {
    api: {
      get max() {
        return getConfiguration().RATE_LIMIT_API_API_MAX;
      },
      get duration() {
        return getConfiguration().RATE_LIMIT_API_API_DURATION_MS;
      },
    },
    legalResolve: {
      get max() {
        return getConfiguration().RATE_LIMIT_API_LEGAL_RESOLVE_MAX;
      },
      get duration() {
        return getConfiguration().RATE_LIMIT_API_LEGAL_RESOLVE_DURATION_MS;
      },
    },
    publicSanctionsSearch: {
      get max() {
        return getConfiguration().RATE_LIMIT_API_PUBLIC_SANCTIONS_SEARCH_MAX;
      },
      get duration() {
        return getConfiguration()
          .RATE_LIMIT_API_PUBLIC_SANCTIONS_SEARCH_DURATION_MS;
      },
      get maxConcurrent() {
        return getConfiguration()
          .RATE_LIMIT_API_PUBLIC_SANCTIONS_SEARCH_MAX_CONCURRENT;
      },
    },
    skillSource: {
      get max() {
        return getConfiguration().RATE_LIMIT_API_SKILL_SOURCE_MAX;
      },
      get duration() {
        return getConfiguration().RATE_LIMIT_API_SKILL_SOURCE_DURATION_MS;
      },
    },
    upload: {
      get max() {
        return getConfiguration().RATE_LIMIT_API_UPLOAD_MAX;
      },
      get duration() {
        return getConfiguration().RATE_LIMIT_API_UPLOAD_DURATION_MS;
      },
    },
    mcpTransport: {
      get max() {
        return getConfiguration().RATE_LIMIT_API_MCP_TRANSPORT_MAX;
      },
      get duration() {
        return getConfiguration().RATE_LIMIT_API_MCP_TRANSPORT_DURATION_MS;
      },
    },
    mcpTransportAddress: {
      get max() {
        return getConfiguration().RATE_LIMIT_API_MCP_TRANSPORT_ADDRESS_MAX;
      },
      get duration() {
        return getConfiguration()
          .RATE_LIMIT_API_MCP_TRANSPORT_ADDRESS_DURATION_MS;
      },
    },
    folioCollab: {
      get max() {
        return getConfiguration().RATE_LIMIT_API_FOLIO_COLLAB_MAX;
      },
      get duration() {
        return getConfiguration().RATE_LIMIT_API_FOLIO_COLLAB_DURATION_MS;
      },
    },
    agentAuth: {
      get max() {
        return getConfiguration().RATE_LIMIT_API_AGENT_AUTH_MAX;
      },
      get duration() {
        return getConfiguration().RATE_LIMIT_API_AGENT_AUTH_DURATION_MS;
      },
    },
    translate: {
      get max() {
        return getConfiguration().RATE_LIMIT_API_TRANSLATE_MAX;
      },
      get duration() {
        return getConfiguration().RATE_LIMIT_API_TRANSLATE_DURATION_MS;
      },
    },
    hostedUsageWebhook: {
      get max() {
        return getConfiguration().RATE_LIMIT_API_HOSTED_USAGE_WEBHOOK_MAX;
      },
      get duration() {
        return getConfiguration()
          .RATE_LIMIT_API_HOSTED_USAGE_WEBHOOK_DURATION_MS;
      },
    },
    deleteAccountOtp: {
      get max() {
        return getConfiguration().RATE_LIMIT_API_DELETE_ACCOUNT_OTP_MAX;
      },
      get duration() {
        return getConfiguration().RATE_LIMIT_API_DELETE_ACCOUNT_OTP_DURATION_MS;
      },
    },
    twoFactorManageOtp: {
      get max() {
        return getConfiguration().RATE_LIMIT_API_TWO_FACTOR_MANAGE_OTP_MAX;
      },
      get duration() {
        return getConfiguration()
          .RATE_LIMIT_API_TWO_FACTOR_MANAGE_OTP_DURATION_MS;
      },
    },
  },
});

const createAdditionalBudgets = (
  getConfiguration: () => RateLimitBudgetConfiguration,
) => ({
  ACCOUNT_ATTEMPT_RATE_LIMITS: {
    otp: {
      get max() {
        return getConfiguration().RATE_LIMIT_ACCOUNT_OTP_MAX;
      },
      get durationMs() {
        return getConfiguration().RATE_LIMIT_ACCOUNT_OTP_DURATION_MS;
      },
    },
    demoOtp: {
      get max() {
        return getConfiguration().RATE_LIMIT_ACCOUNT_DEMO_OTP_MAX;
      },
      get durationMs() {
        return getConfiguration().RATE_LIMIT_ACCOUNT_DEMO_OTP_DURATION_MS;
      },
    },
    password: {
      get max() {
        return getConfiguration().RATE_LIMIT_ACCOUNT_PASSWORD_MAX;
      },
      get durationMs() {
        return getConfiguration().RATE_LIMIT_ACCOUNT_PASSWORD_DURATION_MS;
      },
    },
  },
  MCP_RATE_LIMITS: {
    capability: {
      get max() {
        return getConfiguration().RATE_LIMIT_MCP_CAPABILITY_MAX;
      },
      get windowMs() {
        return getConfiguration().RATE_LIMIT_MCP_CAPABILITY_WINDOW_MS;
      },
    },
    gateway: {
      get max() {
        return getConfiguration().RATE_LIMIT_MCP_GATEWAY_MAX;
      },
      get windowMs() {
        return getConfiguration().RATE_LIMIT_MCP_GATEWAY_WINDOW_MS;
      },
    },
  },
  API_KEY_RATE_LIMITS: {
    machine: {
      enabled: true,
      get maxRequests() {
        return getConfiguration().RATE_LIMIT_API_KEY_MACHINE_MAX;
      },
      get timeWindow() {
        return getConfiguration().RATE_LIMIT_API_KEY_MACHINE_WINDOW_MS;
      },
    },
    desktop: {
      enabled: true,
      get maxRequests() {
        return getConfiguration().RATE_LIMIT_API_KEY_DESKTOP_MAX;
      },
      get timeWindow() {
        return getConfiguration().RATE_LIMIT_API_KEY_DESKTOP_WINDOW_MS;
      },
    },
  },
  DEMO_ACTION_RATE_LIMITS: {
    get max() {
      return getConfiguration().RATE_LIMIT_DEMO_ACTION_MAX;
    },
    get durationMs() {
      return getConfiguration().RATE_LIMIT_DEMO_ACTION_DURATION_MS;
    },
  },
  OTP_DELIVERY_RATE_LIMITS: {
    newAccountEmail: {
      get max() {
        return getConfiguration().RATE_LIMIT_OTP_DELIVERY_NEW_ACCOUNT_EMAIL_MAX;
      },
      get duration() {
        return getConfiguration()
          .RATE_LIMIT_OTP_DELIVERY_NEW_ACCOUNT_EMAIL_DURATION_MS;
      },
    },
    newAccountAddress: {
      get max() {
        return getConfiguration()
          .RATE_LIMIT_OTP_DELIVERY_NEW_ACCOUNT_ADDRESS_MAX;
      },
      get duration() {
        return getConfiguration()
          .RATE_LIMIT_OTP_DELIVERY_NEW_ACCOUNT_ADDRESS_DURATION_MS;
      },
    },
    get existingAccountEmailMax() {
      return getConfiguration()
        .RATE_LIMIT_OTP_DELIVERY_EXISTING_ACCOUNT_EMAIL_MAX;
    },
  },
});

/** Stable budget objects defer environment reads until a numeric limit is used. */
export const createRateLimitBudgetConfig = (
  getConfiguration: () => RateLimitBudgetConfiguration,
) => ({
  ...createAuthBudgets(getConfiguration),
  ...createApiBudgets(getConfiguration),
  ...createAdditionalBudgets(getConfiguration),
});

export const {
  AUTH_RATE_LIMITS,
  API_RATE_LIMITS,
  ACCOUNT_ATTEMPT_RATE_LIMITS,
  MCP_RATE_LIMITS,
  DEMO_ACTION_RATE_LIMITS,
  API_KEY_RATE_LIMITS,
  OTP_DELIVERY_RATE_LIMITS,
} = createRateLimitBudgetConfig(readConfiguredBudgets);
