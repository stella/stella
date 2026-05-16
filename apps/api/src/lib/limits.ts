export const LIMITS = {
  workspacesCount: 1000,
  propertiesCount: 20,
  entitiesCount: 10_000,
  entitiesPageSizeDefault: 100,
  entitiesPageSizeMax: 500,
  entitiesWindowSizeDefault: 200,
  entitiesWindowSizeMax: 500,
  calendarTasksMax: 200,
  entitySummariesPageSize: 200,
  viewsCount: 20,
  templatesCount: 50,
  clauseCategoriesCount: 100,
  templateCategoriesCount: 100,
  clausesPerOrganization: 500,
  shortcutsPerUser: 100,
  agentSkillsPerUser: 100,
  agentSkillsPageSizeDefault: 100,
  agentSkillsPageSizeMax: 250,
  agentSkillsChatMetadataMax: 200,
  agentSkillDescriptionMaxChars: 1000,
  agentSkillCompatibilityMaxChars: 1000,
  agentSkillLicenseMaxChars: 256,
  agentSkillMetadataEntriesMax: 32,
  agentSkillMetadataKeyMaxChars: 64,
  agentSkillMetadataValueMaxChars: 512,
  agentSkillVersionMaxChars: 64,
  agentSkillBodyMaxChars: 80_000,
  agentSkillArchiveFilesMax: 100,
  agentSkillArchiveUncompressedMaxBytes: 6 * 1024 * 1024,
  agentSkillGithubDirectoriesMax: 100,
  agentSkillResourcesPerSkill: 50,
  agentSkillResourceMaxChars: 100_000,
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
  auditLogPageSizeDefault: 50,
  auditLogPageSizeMax: 200,
  contactsCount: 10_000,
  contactRelationshipsCount: 50,
  workspaceContactsCount: 100,
  workspaceMembersCount: 500,
  practiceJurisdictionsPerOrganization: 12,
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
  templateFillsRetentionDays: 365,
  caseLawMatterLinksPerWorkspace: 1000,
  caseLawSearchPageSizeDefault: 20,
  caseLawSearchPageSizeMax: 100,
  caseLawFacetLimit: 20,
  caseLawPolarityRulesPerLanguage: 500,
  infoSoudEventsMax: 200,
  infoSoudHearingsMax: 50,
  infoSoudRelatedCasesMax: 50,
  infoSoudAgendaImportItemsMax: 1000,
  infoSoudTrackedCasesSyncBatch: 50,
  agendaAttendeesMax: 500,
  /** Max chat context file attachment size per file. */
  chatContextFileMaxChars: 16_000,
  /** Max total chars across all text attachments per message. */
  chatContextTextMaxChars: 32_000,
  /** Max number of file attachments per chat message. */
  chatContextFilesPerMessage: 5,
  /** Default page size for the user's chat thread history. */
  chatThreadListPageSizeDefault: 50,
  /** Max page size for the user's chat thread history. */
  chatThreadListPageSizeMax: 100,
  /** Max characters of TypeScript source the chat run-stella-query tool accepts. */
  chatRunCodeMaxLength: 16_000,
  /** Default page size for readonly chat execute functions. */
  chatExecutePageSizeDefault: 50,
  /** Max page size for readonly chat execute functions. */
  chatExecutePageSizeMax: 500,
  /** Max IDs accepted by readonly chat execute detail functions. */
  chatExecuteDetailIdsMax: 100,
  /** Max entity IDs accepted by readonly chat execute content functions. */
  chatExecuteContentIdsMax: 20,
  /** Max DOCX size for stamp injection (bytes). */
  docxStampMaxBytes: 50 * 1024 * 1024,
  /** Max org-wide custom blacklist terms for anonymization. */
  anonymizationBlacklistEntriesPerOrganization: 1000,
  /** Max variants per org-wide custom blacklist term. */
  anonymizationBlacklistVariantsPerEntry: 20,
} as const;

const CHAT_CONTEXT_FILE_MAX_MEGABYTES = 10;

/**
 * File upload size limits.
 * Values use Elysia's human-readable format (e.g. "50m" = 50 MB).
 */
export const FILE_SIZE_LIMITS = {
  /** General document uploads (entities, templates). */
  document: "50m",
  /** Structured data imports (clause JSON). */
  dataImport: "10m",
  /** Agent skill packs (`SKILL.md` or a ZIP folder). */
  skillPack: "2m",
  /** Chat context file attachments. */
  chatContextFile: `${CHAT_CONTEXT_FILE_MAX_MEGABYTES}m`,
} as const;

/**
 * File upload size limits in bytes for code paths that need to
 * validate before a framework-level t.File() parser runs.
 */
export const FILE_SIZE_LIMIT_BYTES = {
  /** Agent skill packs (`SKILL.md` or a ZIP folder). */
  skillPack: 2 * 1024 * 1024,
  /** Chat context file attachments. */
  chatContextFile: CHAT_CONTEXT_FILE_MAX_MEGABYTES * 1024 * 1024,
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
  /** REST API: 1000 req/min per IP. Covers normal navigation
   *  (5-10 requests per page load × frequent workspace switching). */
  api: { duration: 60_000, max: 1000 },
  /** File uploads: 500 req/min (separate budget). */
  upload: { duration: 60_000, max: 500 },
} as const;
