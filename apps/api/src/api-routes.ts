import { STELLA_API_VERSION_PREFIX } from "@stll/api-contract";

import { env } from "@/api/env";
import { accountExportsRoute } from "@/api/handlers/account-exports/routes";
import {
  agentAuthConfirmRoute,
  agentAuthRoute,
} from "@/api/handlers/agent-auth/routes";
import { aiAutocompleteRoute } from "@/api/handlers/ai-autocomplete/routes";
import { aiConfigPublicRoute } from "@/api/handlers/ai-config/routes";
import { apiKeysRoute } from "@/api/handlers/api-keys/routes";
import { auditLogsRoute } from "@/api/handlers/audit-logs/routes";
import {
  authCapabilitiesRoute,
  authMetadataRoute,
} from "@/api/handlers/auth/routes";
import { authUiRoute } from "@/api/handlers/auth/ui-routes";
import { bilingualTranslationsRoute } from "@/api/handlers/bilingual-translations/routes";
import { billingCodesRoute } from "@/api/handlers/billing-codes/routes";
import { caseLawRoute } from "@/api/handlers/case-law/routes";
import { catalogueRoute } from "@/api/handlers/catalogue/routes";
import { chatRoute } from "@/api/handlers/chat/routes";
import {
  clauseCategoriesRoute,
  clausesRoute,
} from "@/api/handlers/clauses/routes";
import { clientInvoicesRoute } from "@/api/handlers/client-invoices/routes";
import { contactsRoute } from "@/api/handlers/contacts/routes";
import { desktopFeatureAccessRoute } from "@/api/handlers/desktop-feature-access/routes";
import { desktopPresenceRoute } from "@/api/handlers/desktop-presence/routes";
import { desktopRegistryRoute } from "@/api/handlers/desktop-registry/routes";
import { desktopRunnerRoute } from "@/api/handlers/desktop-runner/routes";
import { desktopTimeEntriesRoute } from "@/api/handlers/desktop-time-entries/routes";
import { documentReviewPassagesRoute } from "@/api/handlers/document-reviews/passages-routes";
import { documentReviewsRoute } from "@/api/handlers/document-reviews/routes";
import { documentTranslationsRoute } from "@/api/handlers/document-translations/routes";
import { documentTypesRoute } from "@/api/handlers/document-types/routes";
import { documentsRoute } from "@/api/handlers/documents/routes";
import { docxSuggestionsRoute } from "@/api/handlers/docx-suggestions/routes";
import { desktopEditSessionsRoute } from "@/api/handlers/entities/desktop-edit-sessions-route";
import { pdfSigningSessionsRoute } from "@/api/handlers/entities/pdf-signing-sessions-route";
import { entitiesRoute } from "@/api/handlers/entities/routes";
import { entityViewsRoute } from "@/api/handlers/entity-views/routes";
import { expensesRoute } from "@/api/handlers/expenses/routes";
import { externalPreviewRoute } from "@/api/handlers/external-preview/routes";
import {
  feedbackPublicRoute,
  feedbackRoute,
} from "@/api/handlers/feedback/routes";
import { fieldsRoute } from "@/api/handlers/fields/routes";
import { filesRoute } from "@/api/handlers/files/routes";
import { flowsRoute } from "@/api/handlers/flows/routes";
import { flowRunsRoute } from "@/api/handlers/flows/run-route";
import { folioCollabRoute } from "@/api/handlers/folio-collab/routes";
import { healthRoute } from "@/api/handlers/health/routes";
import { hostedUsageWebhookRoute } from "@/api/handlers/hosted-usage-webhook/routes";
import { invoicesRoute } from "@/api/handlers/invoices/routes";
import { legalReaderRoute } from "@/api/handlers/legal-reader/routes";
import { legalResolveRoute } from "@/api/handlers/legal-resolve/routes";
import { legislationCorpusRoute } from "@/api/handlers/legislation/corpus-routes";
import { publicLegislationRoute } from "@/api/handlers/legislation/public-routes";
import { legislationRoute } from "@/api/handlers/legislation/routes";
import { listsRoute } from "@/api/handlers/lists/routes";
import { mcpAppSandboxRoute } from "@/api/handlers/mcp-app-sandbox/routes";
import { mcpConnectorsRoute } from "@/api/handlers/mcp-connectors/routes";
import { mcpRoute } from "@/api/handlers/mcp/routes";
import { meRoute } from "@/api/handlers/me/routes";
import { memoriesRoute } from "@/api/handlers/memories/routes";
import { mobileUpdatesRoute } from "@/api/handlers/mobile-updates/routes";
import { notificationsRoute } from "@/api/handlers/notifications/routes";
import { numberSeriesRoute } from "@/api/handlers/number-series/routes";
import { operatorRoute } from "@/api/handlers/operator/routes";
import { organizationSettingsRoute } from "@/api/handlers/organization-settings/routes";
import { playbooksRoute } from "@/api/handlers/playbooks/routes";
import { playbookRunsRoute } from "@/api/handlers/playbooks/run-route";
import { propertiesRoute } from "@/api/handlers/properties/routes";
import { publicKnowledgeRoute } from "@/api/handlers/public-knowledge/routes";
import { ratesRoute } from "@/api/handlers/rates/routes";
import { reportsRoute } from "@/api/handlers/reports/routes";
import { publicSanctionsRoute } from "@/api/handlers/sanctions/public-routes";
import { savedSearchesRoute } from "@/api/handlers/saved-searches/routes";
import { savedTimeNarrativesRoute } from "@/api/handlers/saved-time-narratives/routes";
import { searchHistoryRoute } from "@/api/handlers/search-history/routes";
import { searchRoute } from "@/api/handlers/search/routes";
import { sellerProfilesRoute } from "@/api/handlers/seller-profiles/routes";
import { sharepointRoute } from "@/api/handlers/sharepoint/routes";
import { signalsRoute } from "@/api/handlers/signals/routes";
import { skillsRoute } from "@/api/handlers/skills/routes";
import { smokeRoute } from "@/api/handlers/smoke/routes";
import { styleSetsRoute } from "@/api/handlers/style-sets/routes";
import { syntheticRoute } from "@/api/handlers/synthetic/routes";
import { myTasksRoute, tasksRoute } from "@/api/handlers/tasks/routes";
import { templatePacksRoute } from "@/api/handlers/template-packs/routes";
import { templateRecipesRoute } from "@/api/handlers/template-recipes/routes";
import {
  templateCategoriesRoute,
  templatesRoute,
} from "@/api/handlers/templates/routes";
import { timeApprovalQueueRoute } from "@/api/handlers/time-entries/approval-queue/routes";
import { internalTimeEntriesRoute } from "@/api/handlers/time-entries/internal/routes";
import { myTimeEntriesRoute } from "@/api/handlers/time-entries/me/routes";
import { memberTimeTargetsRoute } from "@/api/handlers/time-entries/members/routes";
import { timeEntriesRoute } from "@/api/handlers/time-entries/routes";
import { timeTimersRoute } from "@/api/handlers/time-timers/routes";
import { uploadsRoute } from "@/api/handlers/uploads/routes";
import { usageRoute } from "@/api/handlers/usage/routes";
import { userFilesRoute } from "@/api/handlers/user-files/routes";
import { vatRateRoute } from "@/api/handlers/vat-rates/routes";
import { verifyAuthRoute } from "@/api/handlers/verify/routes";
import { viewTemplatesRoute } from "@/api/handlers/view-templates/routes";
import { viewsRoute } from "@/api/handlers/views/routes";
import { visualSandboxRoute } from "@/api/handlers/visual-sandbox/routes";
import { wellKnownRoute } from "@/api/handlers/well-known/routes";
import { myWorkRoute } from "@/api/handlers/work-obligations/my-work-route";
import { workObligationsRoute } from "@/api/handlers/work-obligations/routes";
import { workspaceEventsRoute } from "@/api/handlers/workspaces/events";
import { workspacesRoute } from "@/api/handlers/workspaces/routes";
import { mount, routes, servedIfLoaded } from "@/api/http/route";
import { getAuth } from "@/api/lib/auth";
import { AUTH_API_ROUTE } from "@/api/lib/auth/auth-paths";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { defineEndpoint } from "@/api/lib/endpoints";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import { createPublicCorpusRateLimitComposition } from "@/api/lib/rate-limit/public-corpus-rate-limit-composition";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createRedisRateLimit } from "@/api/lib/rate-limit/redis-context";
import { isLocalDevOpen } from "@/api/runtime-mode";

// Local development routes exist only in an open runtime. The module is
// imported on demand because it loads seeding and search maintenance.
const localDevRoutes = isLocalDevOpen()
  ? await import("@/api/handlers/dev/routes")
  : undefined;

/** Better Auth owns its endpoints, their bodies and their cookies. */
const betterAuthHandler = declareAggregateMutation(
  defineEndpoint.public(
    { bodyMode: "none" },
    async ({ request }) => await getAuth().handler(request),
  ),
  {
    type: "independent",
    reason:
      "Better Auth owns its account, session and organization tables and writes them through its own adapter.",
  },
);

const agentAuthBudget = rateLimit({
  duration: API_RATE_LIMITS.agentAuth.duration,
  max: API_RATE_LIMITS.agentAuth.max,
  budget: { name: "api.agent_auth.address", keyKind: "address" },
  ...createRedisRateLimit({
    failurePolicy: "fail_open_local",
    scope: "agent-auth",
  }),
});

// The session-authed confirm endpoint sits at a fixed root path, outside the
// shared `/v1` budget, so this mutating endpoint has its own.
const agentAuthConfirmBudget = rateLimit({
  duration: API_RATE_LIMITS.api.duration,
  max: API_RATE_LIMITS.api.max,
  budget: { name: "api.agent_auth_confirm.address", keyKind: "address" },
  ...createRedisRateLimit({
    failurePolicy: "fail_open_local",
    scope: "agent-auth-confirm",
  }),
});

/**
 * Every route the API serves, in one table. Composed with `mount()` only, so
 * the group keeps every route's types for the web contract.
 */
export const apiRoutes = mount([
  authUiRoute,
  authMetadataRoute,
  mount([agentAuthRoute], { middleware: [agentAuthBudget] }),
  mount([agentAuthConfirmRoute], { middleware: [agentAuthConfirmBudget] }),
  healthRoute,
  operatorRoute,
  wellKnownRoute,
  hostedUsageWebhookRoute,
  // The MCP transports carry their own budget; discovery and preflight are
  // unmetered.
  mcpRoute,
  mcpAppSandboxRoute,
  visualSandboxRoute,
  aiAutocompleteRoute,
  feedbackPublicRoute,
  memoriesRoute,
  notificationsRoute,
  timeApprovalQueueRoute,
  internalTimeEntriesRoute,
  myTimeEntriesRoute,
  memberTimeTargetsRoute,
  timeTimersRoute,
  servedIfLoaded(localDevRoutes?.devPublicRoute),
  smokeRoute,
  syntheticRoute,
  routes({
    [AUTH_API_ROUTE]: { GET: betterAuthHandler, POST: betterAuthHandler },
  }),
  mount(
    [
      authCapabilitiesRoute,
      workspaceEventsRoute,
      workspacesRoute,
      playbooksRoute,
      playbookRunsRoute,
      documentReviewsRoute,
      documentReviewPassagesRoute,
      documentTranslationsRoute,
      documentsRoute,
      bilingualTranslationsRoute,
      reportsRoute,
      flowsRoute,
      signalsRoute,
      flowRunsRoute,
      documentTypesRoute,
      propertiesRoute,
      filesRoute,
      folioCollabRoute,
      desktopEditSessionsRoute,
      uploadsRoute,
      entitiesRoute,
      docxSuggestionsRoute,
      fieldsRoute,
      templatesRoute,
      styleSetsRoute,
      templateCategoriesRoute,
      templatePacksRoute,
      templateRecipesRoute,
      timeEntriesRoute,
      billingCodesRoute,
      ratesRoute,
      expensesRoute,
      invoicesRoute,
      clientInvoicesRoute,
      sellerProfilesRoute,
      numberSeriesRoute,
      vatRateRoute,
      externalPreviewRoute,
      mcpConnectorsRoute,
      sharepointRoute,
      catalogueRoute,
      organizationSettingsRoute,
      apiKeysRoute,
      desktopRegistryRoute,
      aiConfigPublicRoute,
      clauseCategoriesRoute,
      clausesRoute,
      contactsRoute,
      legislationRoute,
      legislationCorpusRoute,
      publicLegislationRoute,
      publicSanctionsRoute,
      mobileUpdatesRoute,
      publicKnowledgeRoute,
      searchRoute,
      savedSearchesRoute,
      searchHistoryRoute,
      savedTimeNarrativesRoute,
      auditLogsRoute,
      caseLawRoute,
      legalReaderRoute,
      legalResolveRoute,
      chatRoute,
      userFilesRoute,
      skillsRoute,
      usageRoute,
      viewTemplatesRoute,
      viewsRoute,
      entityViewsRoute,
      listsRoute,
      tasksRoute,
      myTasksRoute,
      workObligationsRoute,
      myWorkRoute,
      accountExportsRoute,
      meRoute,
      servedIfLoaded(localDevRoutes?.devRoute),
      verifyAuthRoute,
    ],
    {
      prefix: STELLA_API_VERSION_PREFIX,
      // The shared budget, and the public corpus classes' own buckets. A
      // route with a dedicated budget is charged there instead.
      middleware: createPublicCorpusRateLimitComposition({
        // The dev-only e2e walk measures navigation, not abuse budgets.
        skipShared: () => env.E2E_DISABLE_AUTH_RATE_LIMIT,
      }),
    },
  ),
  feedbackRoute,
  pdfSigningSessionsRoute,
  desktopPresenceRoute,
  desktopFeatureAccessRoute,
  desktopTimeEntriesRoute,
  desktopRunnerRoute,
]);
