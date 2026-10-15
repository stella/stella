/** Required inputs shared by canary journeys and their workflow callers. */
export const MCP_CANARY_JOURNEY_CREDENTIALS = {
  reviewAccount: {
    environment: "all",
    env: {
      email: "APP_REVIEW_ACCOUNT_EMAIL",
      // The API environment accepts the review email only together with its
      // organization, and the canary loads that environment.
      organizationId: "APP_REVIEW_ORGANIZATION_ID",
      password: "REVIEW_ACCOUNT_PASSWORD",
      configuredBaseUrl: "MCP_CANARY_CONFIGURED_BASE_URL",
    },
  },
  stagingSession: {
    environment: "staging",
    env: { smokeSecret: "SMOKE_SESSION_SECRET" },
  },
  productionBearer: {
    environment: "production",
    env: { token: "MCP_CANARY_TOKEN" },
  },
} as const;
