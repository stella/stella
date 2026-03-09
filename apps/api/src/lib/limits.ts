export const LIMITS = {
  workspacesCount: 1000,
  propertiesCount: 20,
  entitiesCount: 10_000,
  entitiesPageSizeDefault: 50,
  entitiesPageSizeMax: 100,
  entitySummariesPageSize: 200,
  viewsCount: 20,
  templatesCount: 50,
  clauseCategoriesCount: 100,
  templateCategoriesCount: 100,
  clausesPerOrganization: 500,
  clauseVariantsPerClause: 10,
  clauseVersionsPerClause: 50,
  templateClausesPerTemplate: 50,
  templateVersionsPerTemplate: 50,
  rateTablesPerWorkspace: 50,
  rateEntriesPerTable: 200,
  timeEntriesPerWorkspace: 50_000,
  expensesPerWorkspace: 10_000,
  billingCodesPerWorkspace: 500,
  overviewRecentEntities: 10,
  activeTimersPerUser: 1,
  timeEntryMaxAgeDays: 90,
  billingIncrementMinutes: 6,
  invoicesPerWorkspace: 10_000,
  exportRowLimit: 10_000,
  exportPdfRowLimit: 5000,
  contactsCount: 10_000,
  contactRelationshipsCount: 50,
  workspaceContactsCount: 100,
  entityNameMaxLength: 255,
  workspaceContributors: 5,
  searchQueryMaxLength: 500,
  searchPageSizeDefault: 20,
  searchPageSizeMax: 100,
  extractedContentMaxChars: 500_000,
  /** Hard timeout (ms) for the sandboxed extraction subprocess. */
  extractionTimeoutMs: 30_000,
  clauseExportLimit: 500,
  clauseImportBatchLimit: 200,
  analyticsTopTemplatesLimit: 20,
  analyticsFillsByUserLimit: 100,
  analyticsFillsByPeriodLimit: 400,
  templateFillsRetentionDays: 365,
  caseLawMatterLinksPerWorkspace: 1000,
  caseLawSearchPageSizeDefault: 20,
  caseLawSearchPageSizeMax: 100,
  caseLawFacetLimit: 20,
  caseLawPolarityRulesPerLanguage: 500,
  /** Max chat context file attachment size per file. */
  chatContextFileMaxChars: 16_000,
  /** Max total chars across all text attachments per message. */
  chatContextTextMaxChars: 32_000,
  /** Max number of file attachments per chat message. */
  chatContextFilesPerMessage: 5,
  /** Max DOCX size for stamp injection (bytes). */
  docxStampMaxBytes: 50 * 1024 * 1024,
} as const;

/**
 * File upload size limits.
 * Values use Elysia's human-readable format (e.g. "50m" = 50 MB).
 */
export const FILE_SIZE_LIMITS = {
  /** General document uploads (entities, templates). */
  document: "50m",
  /** Structured data imports (clause JSON). */
  dataImport: "10m",
  /** Chat context file attachments. */
  chatContextFile: "10m",
} as const;

/**
 * Rate limits for auth endpoints (better-auth built-in limiter).
 * Window is in seconds, max is the request ceiling per window.
 */
export const AUTH_RATE_LIMITS = {
  global: { window: 60, max: 100 },
  signIn: { window: 60, max: 5 },
  signUp: { window: 60, max: 3 },
  sendOtp: { window: 60, max: 5 },
  verifyOtp: { window: 60, max: 5 },
  forgetPassword: { window: 60, max: 3 },
  resetPassword: { window: 60, max: 5 },
} as const;

/**
 * Max window (seconds) across all auth rate-limit rules.
 * Used as the Redis TTL for better-auth's customStorage,
 * which does not pass per-endpoint window to `set`.
 * The actual window logic is handled by better-auth via
 * `lastRequest` timestamps; the TTL only controls key
 * cleanup.
 */
export const AUTH_RATE_LIMIT_MAX_WINDOW = Math.max(
  ...Object.values(AUTH_RATE_LIMITS).map((r) => r.window),
);

/**
 * Rate limits for API endpoints (elysia-rate-limit).
 * Duration is in milliseconds, max is the request ceiling
 * per duration window.
 */
export const API_RATE_LIMITS = {
  /** REST API: 100 req/min. */
  api: { duration: 60_000, max: 100 },
  /** Rivet actors: 500 req/min. */
  rivet: { duration: 60_000, max: 500 },
} as const;
