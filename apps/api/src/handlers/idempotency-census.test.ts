import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";

import { collectIdempotentCreateRoutes } from "@stll/scripts/src/idempotent-create-routes";

import { apiRoutes } from "@/api/api-routes";

import { mountedCreateRouteCensus } from "../../scripts/idempotent-create-routes";

const NON_REPLAY_REASONS = {
  "current-state":
    "The operation evaluates current resource state rather than replaying a retained response.",
  read: "The operation computes a current read result and retains no mutation response.",
  stream:
    "The operation returns a live stream or participates in a streamed execution.",
  "external-effect":
    "The operation owns external effects or durable worker handoff outside a response receipt.",
  credential:
    "The operation handles credentials or expiring authorization state that is not retained in receipts.",
  lifecycle:
    "The operation owns a multi-step lifecycle whose result is not represented by its create response.",
} as const;

type RootMutationDisposition =
  | { type: "replay" }
  | { type: "non-replay"; reason: keyof typeof NON_REPLAY_REASONS };

const ROOT_MUTATION_DISPOSITIONS = {
  "DELETE /v1/case/research/columns/:columnId": {
    type: "non-replay",
    reason: "current-state",
  },
  "DELETE /v1/chat/threads/:threadId": {
    type: "non-replay",
    reason: "current-state",
  },
  "DELETE /v1/chat/tool-grants/:grantId": {
    type: "non-replay",
    reason: "current-state",
  },
  "DELETE /v1/clause-categories/:categoryId": {
    type: "non-replay",
    reason: "current-state",
  },
  "DELETE /v1/clauses/:clauseId": {
    type: "non-replay",
    reason: "current-state",
  },
  "DELETE /v1/clauses/:clauseId/variants/:variantId": {
    type: "non-replay",
    reason: "current-state",
  },
  "DELETE /v1/contacts/:contactId": {
    type: "non-replay",
    reason: "current-state",
  },
  "DELETE /v1/document-types/:documentTypeId": {
    type: "non-replay",
    reason: "current-state",
  },
  "DELETE /v1/entity-views/:viewId": {
    type: "non-replay",
    reason: "current-state",
  },
  "DELETE /v1/flows/:flowId": {
    type: "non-replay",
    reason: "current-state",
  },
  "DELETE /v1/mcp/connections/:connectionId": {
    type: "non-replay",
    reason: "credential",
  },
  "DELETE /v1/mcp/connectors/:slug": {
    type: "non-replay",
    reason: "credential",
  },
  "DELETE /v1/memories/:memoryId": {
    type: "non-replay",
    reason: "current-state",
  },
  "DELETE /v1/organization-settings/ai-config": {
    type: "non-replay",
    reason: "current-state",
  },
  "DELETE /v1/organization-settings/business-registry-credentials": {
    type: "non-replay",
    reason: "current-state",
  },
  "DELETE /v1/organization-settings/correspondence/allowed-senders/:senderId": {
    type: "non-replay",
    reason: "current-state",
  },
  "DELETE /v1/organization-settings/correspondence/allowed-senders/:senderId/scope":
    {
      type: "non-replay",
      reason: "current-state",
    },
  "DELETE /v1/organization-settings/deepl": {
    type: "non-replay",
    reason: "current-state",
  },
  "DELETE /v1/organization-settings/feature-enrolments/:featureId": {
    type: "non-replay",
    reason: "current-state",
  },
  "DELETE /v1/organization-settings/web-search-key": {
    type: "non-replay",
    reason: "current-state",
  },
  "DELETE /v1/playbooks/:playbookId": {
    type: "non-replay",
    reason: "current-state",
  },
  "DELETE /v1/reader/annotations/:annotationId": {
    type: "non-replay",
    reason: "current-state",
  },
  "DELETE /v1/reader/answers/:answerId": {
    type: "non-replay",
    reason: "stream",
  },
  "DELETE /v1/saved-searches/:savedSearchId": {
    type: "non-replay",
    reason: "current-state",
  },
  "DELETE /v1/saved-time-narratives/:id": {
    type: "non-replay",
    reason: "current-state",
  },
  "DELETE /v1/search-history": {
    type: "non-replay",
    reason: "current-state",
  },
  "DELETE /v1/search-history/:entryId": {
    type: "non-replay",
    reason: "current-state",
  },
  "DELETE /v1/sharepoint/connection": {
    type: "non-replay",
    reason: "credential",
  },
  "DELETE /v1/skills/:skillId": {
    type: "non-replay",
    reason: "current-state",
  },
  "DELETE /v1/skills/:skillId/comments/:commentId": {
    type: "non-replay",
    reason: "current-state",
  },
  "DELETE /v1/skills/:skillId/proposals/:proposalId": {
    type: "non-replay",
    reason: "current-state",
  },
  "DELETE /v1/skills/:skillId/resources": {
    type: "non-replay",
    reason: "current-state",
  },
  "DELETE /v1/style-sets/:styleSetId": {
    type: "non-replay",
    reason: "lifecycle",
  },
  "DELETE /v1/template-categories/:categoryId": {
    type: "non-replay",
    reason: "current-state",
  },
  "DELETE /v1/template-recipes/:recipeId": {
    type: "non-replay",
    reason: "current-state",
  },
  "DELETE /v1/templates/:templateId": {
    type: "non-replay",
    reason: "lifecycle",
  },
  "DELETE /v1/templates/:templateId/clauses/:linkId": {
    type: "non-replay",
    reason: "lifecycle",
  },
  "DELETE /v1/templates/lookup-formats/:formatId": {
    type: "non-replay",
    reason: "lifecycle",
  },
  "DELETE /v1/time-timers/:id": {
    type: "non-replay",
    reason: "current-state",
  },
  "DELETE /v1/usage/assignments": {
    type: "non-replay",
    reason: "current-state",
  },
  "PATCH /v1/case/research/columns/:columnId": {
    type: "non-replay",
    reason: "current-state",
  },
  "PATCH /v1/chat/threads/:threadId": {
    type: "non-replay",
    reason: "current-state",
  },
  "PATCH /v1/chat/threads/:threadId/model": {
    type: "non-replay",
    reason: "current-state",
  },
  "PATCH /v1/chat/threads/:threadId/title": {
    type: "non-replay",
    reason: "current-state",
  },
  "PATCH /v1/document-types/:documentTypeId": {
    type: "non-replay",
    reason: "current-state",
  },
  "PATCH /v1/entity-views/:viewId": {
    type: "non-replay",
    reason: "current-state",
  },
  "PATCH /v1/mcp/connections/:connectionId": {
    type: "non-replay",
    reason: "credential",
  },
  "PATCH /v1/mcp/native-tools/:slug": {
    type: "non-replay",
    reason: "credential",
  },
  "PATCH /v1/memories/:memoryId": {
    type: "non-replay",
    reason: "current-state",
  },
  "PATCH /v1/notifications/:notificationId/read": {
    type: "non-replay",
    reason: "current-state",
  },
  "PATCH /v1/number-series/:numberSeriesId": {
    type: "non-replay",
    reason: "current-state",
  },
  "PATCH /v1/reader/annotations/:annotationId": {
    type: "non-replay",
    reason: "current-state",
  },
  "PATCH /v1/reader/answers/:answerId": {
    type: "non-replay",
    reason: "stream",
  },
  "PATCH /v1/saved-searches/:savedSearchId": {
    type: "non-replay",
    reason: "current-state",
  },
  "PATCH /v1/saved-time-narratives/:id": {
    type: "non-replay",
    reason: "current-state",
  },
  "PATCH /v1/seller-profiles/:sellerProfileId": {
    type: "non-replay",
    reason: "current-state",
  },
  "PATCH /v1/skills/:skillId": {
    type: "non-replay",
    reason: "current-state",
  },
  "PATCH /v1/skills/:skillId/comments/:commentId": {
    type: "non-replay",
    reason: "current-state",
  },
  "PATCH /v1/skills/:skillId/proposals/:proposalId": {
    type: "non-replay",
    reason: "current-state",
  },
  "PATCH /v1/skills/:skillId/resources": {
    type: "non-replay",
    reason: "current-state",
  },
  "PATCH /v1/templates/:templateId/clauses/:linkId": {
    type: "non-replay",
    reason: "lifecycle",
  },
  "PATCH /v1/time-timers/:id": {
    type: "non-replay",
    reason: "current-state",
  },
  "PATCH /v1/vat-rates/:vatRateId": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /agent/identity/confirm": {
    type: "non-replay",
    reason: "credential",
  },
  "POST /v1/ai-autocomplete/stream": {
    type: "non-replay",
    reason: "stream",
  },
  "POST /v1/api-keys": {
    type: "non-replay",
    reason: "credential",
  },
  "POST /v1/api-keys/personal": {
    type: "non-replay",
    reason: "credential",
  },
  "POST /v1/api-keys/personal/organization/revoke": {
    type: "non-replay",
    reason: "credential",
  },
  "POST /v1/api-keys/personal/policy": {
    type: "non-replay",
    reason: "credential",
  },
  "POST /v1/api-keys/personal/revoke": {
    type: "non-replay",
    reason: "credential",
  },
  "POST /v1/api-keys/personal/rotate": {
    type: "non-replay",
    reason: "credential",
  },
  "POST /v1/api-keys/revoke": {
    type: "non-replay",
    reason: "credential",
  },
  "POST /v1/api-keys/rotate": {
    type: "non-replay",
    reason: "credential",
  },
  "POST /v1/case/decisions/search/expand": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/case/decisions/search/refine": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/case/research/answers/lookup": {
    type: "non-replay",
    reason: "read",
  },
  "POST /v1/case/research/answers/run": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/case/research/columns": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/case/research/columns/suggest-prompt": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/catalogue/install-skill": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/chat": {
    type: "non-replay",
    reason: "stream",
  },
  "POST /v1/chat/improve-prompt": {
    type: "non-replay",
    reason: "stream",
  },
  "POST /v1/chat/table-chart": {
    type: "non-replay",
    reason: "stream",
  },
  "POST /v1/chat/template-thread": {
    type: "non-replay",
    reason: "stream",
  },
  "POST /v1/chat/template-thread/rotate": {
    type: "non-replay",
    reason: "stream",
  },
  "POST /v1/chat/threads/:threadId/connectors/:toolCallId": {
    type: "non-replay",
    reason: "credential",
  },
  "POST /v1/chat/threads/:threadId/export": {
    type: "non-replay",
    reason: "stream",
  },
  "POST /v1/chat/threads/:threadId/fork": {
    type: "non-replay",
    reason: "stream",
  },
  "POST /v1/chat/threads/:threadId/messages/:messageId/revisions": {
    type: "non-replay",
    reason: "stream",
  },
  "POST /v1/chat/threads/:threadId/messages/:messageId/revisions/:revision/revert":
    {
      type: "non-replay",
      reason: "stream",
    },
  "POST /v1/chat/threads/:threadId/messages/:messageId/span-edit": {
    type: "non-replay",
    reason: "read",
  },
  "POST /v1/chat/threads/:threadId/recap": {
    type: "non-replay",
    reason: "stream",
  },
  "POST /v1/chat/threads/:threadId/secrets/:toolCallId": {
    type: "non-replay",
    reason: "credential",
  },
  "POST /v1/chat/threads/:threadId/suggested-prompts": {
    type: "non-replay",
    reason: "stream",
  },
  "POST /v1/chat/threads/:threadId/title/suggest": {
    type: "non-replay",
    reason: "stream",
  },
  "POST /v1/chat/threads/:threadId/turns/:turnId/cancel": {
    type: "non-replay",
    reason: "stream",
  },
  "POST /v1/chat/tool-grants": {
    type: "non-replay",
    reason: "stream",
  },
  "POST /v1/clause-categories/:categoryId": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/clauses/:clauseId": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/clauses/:clauseId/variants/:variantId": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/clauses/:clauseId/versions/:versionId/restore": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/clauses/:clauseId/versions/:versionId/summarize": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/clauses/ai-rewrite": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/clauses/import": {
    type: "non-replay",
    reason: "external-effect",
  },
  "POST /v1/contacts/:contactId": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/contacts/:contactId/sanctions/monitoring": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/contacts/:contactId/sanctions/reviews": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/contacts/business-registries/checks": {
    type: "non-replay",
    reason: "read",
  },
  "POST /v1/contacts/extract-from-procuracao": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/contacts/import/inspect": {
    type: "non-replay",
    reason: "external-effect",
  },
  "POST /v1/contacts/import/preview": {
    type: "non-replay",
    reason: "external-effect",
  },
  "POST /v1/contacts/import/validate": {
    type: "non-replay",
    reason: "external-effect",
  },
  "POST /v1/contacts/procuracao-upload": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/desktop-registry/grant": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/dev/clean": {
    type: "non-replay",
    reason: "external-effect",
  },
  "POST /v1/dev/clear-cache": {
    type: "non-replay",
    reason: "external-effect",
  },
  "POST /v1/dev/public-law-connection": {
    type: "non-replay",
    reason: "external-effect",
  },
  "POST /v1/dev/rebuild-search": {
    type: "non-replay",
    reason: "external-effect",
  },
  "POST /v1/dev/seed": {
    type: "non-replay",
    reason: "external-effect",
  },
  "POST /v1/dev/seed-firm-knowledge": {
    type: "non-replay",
    reason: "external-effect",
  },
  "POST /v1/document-reviews/passages": {
    type: "non-replay",
    reason: "read",
  },
  "POST /v1/document-types": {
    type: "replay",
  },
  "POST /v1/document-types/reorder": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/entity-views/query-window": {
    type: "non-replay",
    reason: "read",
  },
  "POST /v1/entity-views/reorder": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/feedback": {
    type: "non-replay",
    reason: "external-effect",
  },
  "POST /v1/flows": {
    type: "non-replay",
    reason: "lifecycle",
  },
  "POST /v1/legislation/corpus/search": {
    type: "non-replay",
    reason: "read",
  },
  "POST /v1/mcp/connections": {
    type: "non-replay",
    reason: "credential",
  },
  "POST /v1/mcp/connectors": {
    type: "non-replay",
    reason: "credential",
  },
  "POST /v1/mcp/connectors/:slug/approve-authorization": {
    type: "non-replay",
    reason: "credential",
  },
  "POST /v1/mcp/connectors/:slug/connect": {
    type: "non-replay",
    reason: "credential",
  },
  "POST /v1/mcp/connectors/probe": {
    type: "non-replay",
    reason: "credential",
  },
  "POST /v1/memories": {
    type: "replay",
  },
  "POST /v1/memories/firm": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/notifications/announcements": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/notifications/read-all": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/number-series": {
    type: "replay",
  },
  "POST /v1/number-series/:numberSeriesId/archive": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/number-series/:numberSeriesId/default": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/organization-settings": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/organization-settings/ai-config": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/organization-settings/ai-config/defaults-preview": {
    type: "non-replay",
    reason: "read",
  },
  "POST /v1/organization-settings/business-registry-credentials": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/organization-settings/correspondence/allowed-senders": {
    type: "replay",
  },
  "POST /v1/organization-settings/correspondence/allowed-senders/:senderId/scope":
    {
      type: "non-replay",
      reason: "current-state",
    },
  "POST /v1/organization-settings/deepl": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/organization-settings/practice-jurisdictions": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/organization-settings/preview": {
    type: "non-replay",
    reason: "read",
  },
  "POST /v1/organization-settings/sanctions-monitoring": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/organization-settings/web-search-key": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/playbooks": {
    type: "replay",
  },
  "POST /v1/playbooks/:playbookId/approve": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/playbooks/:playbookId/versions/:version/restore": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/playbooks/from-run": {
    type: "replay",
  },
  "POST /v1/playbooks/from-starter": {
    type: "replay",
  },
  "POST /v1/reader/annotations": {
    type: "replay",
  },
  "POST /v1/reader/answers": {
    type: "non-replay",
    reason: "stream",
  },
  "POST /v1/reader/answers/:answerId/messages": {
    type: "non-replay",
    reason: "stream",
  },
  "POST /v1/reader/answers/:answerId/regenerate": {
    type: "non-replay",
    reason: "stream",
  },
  "POST /v1/saved-searches": {
    type: "replay",
  },
  "POST /v1/saved-time-narratives": {
    type: "replay",
  },
  "POST /v1/search": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/search-history": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/search-history/import": {
    type: "non-replay",
    reason: "external-effect",
  },
  "POST /v1/search/facets": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/search/preview": {
    type: "non-replay",
    reason: "read",
  },
  "POST /v1/search/refine": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/search/summary": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/search/summary/chat": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/seller-profiles": {
    type: "replay",
  },
  "POST /v1/seller-profiles/:sellerProfileId/archive": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/seller-profiles/:sellerProfileId/default": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/sharepoint/connect": {
    type: "non-replay",
    reason: "credential",
  },
  "POST /v1/signals/:signalId/acceptances": {
    type: "replay",
  },
  "POST /v1/signals/:signalId/assignments": {
    type: "replay",
  },
  "POST /v1/signals/:signalId/dismissals": {
    type: "replay",
  },
  "POST /v1/signals/:signalId/snoozes": {
    type: "replay",
  },
  "POST /v1/signals/requests": {
    type: "replay",
  },
  "POST /v1/skills": {
    type: "replay",
  },
  "POST /v1/skills/:skillId/comments": {
    type: "replay",
  },
  "POST /v1/skills/:skillId/proposals": {
    type: "replay",
  },
  "POST /v1/skills/:skillId/proposals/:proposalId/review": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/skills/:skillId/proposals/from-comments": {
    type: "replay",
  },
  "POST /v1/skills/:skillId/resources": {
    type: "replay",
  },
  "POST /v1/skills/:skillId/resources/rename": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/skills/:skillId/resources/rewrite": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/skills/:skillId/resources/upload": {
    type: "non-replay",
    reason: "external-effect",
  },
  "POST /v1/skills/discover-url": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/skills/from-blueprint": {
    type: "replay",
  },
  "POST /v1/skills/generate-draft": {
    type: "non-replay",
    reason: "external-effect",
  },
  "POST /v1/skills/import-url": {
    type: "non-replay",
    reason: "external-effect",
  },
  "POST /v1/skills/import-urls": {
    type: "non-replay",
    reason: "external-effect",
  },
  "POST /v1/skills/upload": {
    type: "non-replay",
    reason: "external-effect",
  },
  "POST /v1/style-sets/:styleSetId": {
    type: "non-replay",
    reason: "lifecycle",
  },
  "POST /v1/style-sets/:styleSetId/editor": {
    type: "non-replay",
    reason: "lifecycle",
  },
  "POST /v1/style-sets/:styleSetId/source": {
    type: "non-replay",
    reason: "lifecycle",
  },
  "POST /v1/style-sets/editor/preview": {
    type: "non-replay",
    reason: "read",
  },
  "POST /v1/template-categories/:categoryId": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/template-packs/:packId/install": {
    type: "non-replay",
    reason: "lifecycle",
  },
  "POST /v1/template-packs/visibility": {
    type: "non-replay",
    reason: "lifecycle",
  },
  "POST /v1/templates/:templateId": {
    type: "non-replay",
    reason: "lifecycle",
  },
  "POST /v1/templates/:templateId/clauses/:linkId/sync": {
    type: "non-replay",
    reason: "lifecycle",
  },
  "POST /v1/templates/:templateId/clauses/sync": {
    type: "non-replay",
    reason: "lifecycle",
  },
  "POST /v1/templates/:templateId/decide-conditions": {
    type: "non-replay",
    reason: "read",
  },
  "POST /v1/templates/:templateId/document": {
    type: "non-replay",
    reason: "lifecycle",
  },
  "POST /v1/templates/:templateId/fill": {
    type: "non-replay",
    reason: "lifecycle",
  },
  "POST /v1/templates/:templateId/fill-preview": {
    type: "non-replay",
    reason: "read",
  },
  "POST /v1/templates/:templateId/prefill": {
    type: "non-replay",
    reason: "lifecycle",
  },
  "POST /v1/templates/:templateId/versions/:versionId/summarize": {
    type: "non-replay",
    reason: "lifecycle",
  },
  "POST /v1/templates/discover": {
    type: "non-replay",
    reason: "read",
  },
  "POST /v1/templates/fill": {
    type: "non-replay",
    reason: "lifecycle",
  },
  "POST /v1/templates/lookup-formats": {
    type: "replay",
  },
  "POST /v1/templates/lookup-formats/default": {
    type: "non-replay",
    reason: "lifecycle",
  },
  "POST /v1/templates/lookup-formats/my-default": {
    type: "non-replay",
    reason: "lifecycle",
  },
  "POST /v1/templates/lookup-preview": {
    type: "non-replay",
    reason: "read",
  },
  "POST /v1/templates/prepare": {
    type: "non-replay",
    reason: "lifecycle",
  },
  "POST /v1/templates/suggest-fields": {
    type: "non-replay",
    reason: "lifecycle",
  },
  "POST /v1/time-entries/approval-queue/return": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/time-entries/approve": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/time-entries/internal": {
    type: "replay",
  },
  "POST /v1/time-entries/me/submissions": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/time-timers/:id/confirm": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/time-timers/:id/pause": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/time-timers/:id/resume": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/time-timers/admin/:id/stop": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/time-timers/start": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/usage/assignments": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/usage/hosted/management": {
    type: "non-replay",
    reason: "external-effect",
  },
  "POST /v1/usage/hosted/setup": {
    type: "non-replay",
    reason: "external-effect",
  },
  "POST /v1/vat-rates": {
    type: "replay",
  },
  "POST /v1/vat-rates/:vatRateId/archive": {
    type: "non-replay",
    reason: "current-state",
  },
  "POST /v1/vat-rates/apply-preset": {
    type: "replay",
  },
  "PUT /v1/case/research/columns/order": {
    type: "non-replay",
    reason: "current-state",
  },
  "PUT /v1/clause-categories": {
    type: "replay",
  },
  "PUT /v1/clauses": {
    type: "replay",
  },
  "PUT /v1/clauses/:clauseId/variants": {
    type: "replay",
  },
  "PUT /v1/clauses/import": {
    type: "non-replay",
    reason: "external-effect",
  },
  "PUT /v1/client-invoices/:clientId": {
    type: "replay",
  },
  "PUT /v1/contacts": {
    type: "non-replay",
    reason: "lifecycle",
  },
  "PUT /v1/contacts/import": {
    type: "non-replay",
    reason: "lifecycle",
  },
  "PUT /v1/entity-views": {
    type: "replay",
  },
  "PUT /v1/flows/:flowId": {
    type: "non-replay",
    reason: "current-state",
  },
  "PUT /v1/organization-settings/anonymization-blacklist": {
    type: "non-replay",
    reason: "current-state",
  },
  "PUT /v1/organization-settings/feature-enrolments/:featureId": {
    type: "non-replay",
    reason: "current-state",
  },
  "PUT /v1/playbooks/:playbookId": {
    type: "non-replay",
    reason: "current-state",
  },
  "PUT /v1/sharepoint/enablement": {
    type: "non-replay",
    reason: "credential",
  },
  "PUT /v1/style-sets": {
    type: "non-replay",
    reason: "lifecycle",
  },
  "PUT /v1/style-sets/editor": {
    type: "non-replay",
    reason: "lifecycle",
  },
  "PUT /v1/template-categories": {
    type: "replay",
  },
  "PUT /v1/template-recipes": {
    type: "replay",
  },
  "PUT /v1/templates": {
    type: "non-replay",
    reason: "lifecycle",
  },
  "PUT /v1/templates/:templateId/clauses": {
    type: "non-replay",
    reason: "lifecycle",
  },
  "PUT /v1/templates/blank": {
    type: "non-replay",
    reason: "lifecycle",
  },
  "PUT /v1/templates/style-set": {
    type: "non-replay",
    reason: "lifecycle",
  },
  "PUT /v1/templates/styles": {
    type: "non-replay",
    reason: "lifecycle",
  },
  "PUT /v1/time-entries/me/daily-target": {
    type: "non-replay",
    reason: "current-state",
  },
  "PUT /v1/time-entries/members/:userId/daily-target": {
    type: "non-replay",
    reason: "current-state",
  },
  "PUT /v1/workspaces": {
    type: "non-replay",
    reason: "lifecycle",
  },
} as const satisfies Record<string, RootMutationDisposition>;

const CREATE_MUTATION_DISPOSITIONS = {
  "src/handlers/invoices/payments/create.ts": {
    type: "non-replay",
    reason:
      "Money movement keeps its current payment transaction and is never replayed.",
  },
} as const satisfies Record<string, { type: "non-replay"; reason: string }>;

const ROOT_MUTATION_DISPOSITIONS_ENTRIES = new Map<
  string,
  RootMutationDisposition
>(Object.entries(ROOT_MUTATION_DISPOSITIONS));

const apiRoot = path.resolve(import.meta.dir, "../..");

// These lifecycle boundaries cannot retain a scoped JSON replay receipt.
const IDEMPOTENCY_EXCEPTIONS = {
  "src/handlers/contacts/create.ts":
    "Contact creation is followed by matter-client assignment and uses caller-generated IDs outside the create receipt.",
  "src/handlers/entities/create.ts":
    "Folder reservations, file uploads and file organization require lifecycle work beyond the create response.",
  "src/handlers/invoices/create.ts":
    "The create response is one step of create, finalize and read workflows; replaying it does not replay their completion.",
  "src/handlers/lists/items/sources/create.ts":
    "The source form resolves a live document version before creation, so a manual retry can submit a different version for the same user intent.",
  "src/handlers/properties/create.ts":
    "Property creation participates in upload task chains whose completion is outside this create operation.",
  "src/handlers/tasks/create.ts":
    "Task creation is followed by field writes, so the create response does not represent the completed task workflow.",
  "src/handlers/views/create.ts":
    "View selection and template workflows generate fresh caller IDs, so a create receipt cannot represent the complete selection intent.",
  "src/handlers/workspaces/create.ts":
    "Matter creation uses a browser-generated identity derived from its workflow key, outside this request receipt.",

  "src/handlers/account-exports/create.ts":
    "Retains native account-scoped request serialization and durable queue handoff.",
  "src/handlers/api-keys/create.ts":
    "The one-time response contains credential material that must not be retained.",
  "src/handlers/api-keys/personal/create.ts":
    "The one-time response contains credential material that must not be retained.",
  "src/handlers/chat/export/create.ts":
    "Writes an export object to S3 outside the database transaction.",
  "src/handlers/chat/fork/create.ts":
    "Copies S3 objects and retains its native fork deduplication and cleanup lifecycle.",
  "src/handlers/chat/tool-grants/create.ts":
    "Retains native grant deduplication by subject and scope.",
  "src/handlers/document-translations/runs/create.ts":
    "Retains durable run admission and worker handoff outside the request transaction.",
  "src/handlers/entities/bilingual/create.ts":
    "Creates stored document bytes through the durable upload lifecycle.",
  "src/handlers/entities/blank-document/create.ts":
    "Creates stored document bytes through the durable upload lifecycle.",
  "src/handlers/entities/from-legal-source/create.ts":
    "Creates stored document bytes through the durable upload lifecycle.",
  "src/handlers/entities/ocr/create.ts":
    "Retains native processing-run deduplication by source version.",
  "src/handlers/feedback/create.ts":
    "Submits to the detached feedback store outside the organization transaction.",
  "src/handlers/files/email-attachment/create.ts":
    "Saves attachment bytes through the durable upload lifecycle.",
  "src/handlers/flows/create.ts":
    "Synchronizes the scheduled trigger after the database mutation.",
  "src/handlers/lists/items/comments/create.ts":
    "Fans out mention notifications after the comment transaction commits.",
  "src/handlers/lists/sample-case/create.ts":
    "Retains its native sample deduplication and durable document upload lifecycle.",
  "src/handlers/lists/verifications/create.ts":
    "Retains durable run admission and queue handoff outside the request transaction.",
  "src/handlers/style-sets/create.ts":
    "Stores a style package through the durable upload lifecycle.",
  "src/handlers/style-sets/from-editor/create.ts":
    "Stores generated style-package bytes through the durable upload lifecycle.",
  "src/handlers/template-packs/installs/create.ts":
    "Retains native install deduplication while storing templates through durable uploads.",
  "src/handlers/templates/blank/create.ts":
    "Stores generated template bytes through the durable upload lifecycle.",
  "src/handlers/templates/create.ts":
    "Stores template bytes through the durable upload lifecycle.",
  "src/handlers/templates/fills/create.ts":
    "Creates filled document bytes through the durable upload lifecycle.",
  "src/handlers/templates/from-style-set/create.ts":
    "Stores generated template bytes through the durable upload lifecycle.",
  "src/handlers/templates/from-styles/create.ts":
    "Stores generated template bytes through the durable upload lifecycle.",
  "src/handlers/desktop-time-entries/create.ts":
    "Public desktop authentication establishes its organization inside the handler.",
  "src/handlers/legal-reader/answers/create.ts":
    "The response is a realtime stream, not a JSON document.",
  "src/handlers/uploads/create.ts":
    "Creates expiring entity-create or entity-version upload intents; signed URLs expire and abort removes the intent, while resource identity is established by finalization.",
  "src/handlers/workspaces/correspondence/address/create.ts":
    "Rotates an inbound address containing a generated credential that must not be retained in replay receipts.",
} as const satisfies Record<string, string>;

const parse = (source: string) =>
  ts.createSourceFile("fixture.ts", source, ts.ScriptTarget.Latest, true);

const walk = (node: ts.Node, visit: (node: ts.Node) => void) => {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
};

const resolveImport = (file: string, specifier: string) => {
  if (specifier.startsWith("@/api/")) {
    return `src/${specifier.slice("@/api/".length)}.ts`;
  }
  if (specifier.startsWith(".")) {
    return path.posix.normalize(
      path.posix.join(path.posix.dirname(file), `${specifier}.ts`),
    );
  }
  return undefined;
};

const collectCreateCapabilities = (source: string) => {
  const tree = parse(source);
  const handlers = new Set<string>();
  walk(tree, (node) => {
    if (
      !ts.isPropertyAssignment(node) ||
      !ts.isStringLiteral(node.name) ||
      !node.name.text.endsWith(".create")
    ) {
      return;
    }
    walk(node.initializer, (child) => {
      if (
        !ts.isCallExpression(child) ||
        child.expression.kind !== ts.SyntaxKind.ImportKeyword
      ) {
        return;
      }
      const target = child.arguments.at(0);
      if (target && ts.isStringLiteral(target)) {
        const resolved = resolveImport("", target.text);
        if (resolved) {
          handlers.add(resolved);
        }
      }
    });
  });
  return handlers;
};

const property = (object: ts.ObjectLiteralExpression, name: string) =>
  object.properties.find(
    (entry): entry is ts.PropertyAssignment =>
      ts.isPropertyAssignment(entry) &&
      (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)) &&
      entry.name.text === name,
  )?.initializer;

const hasReplayConfig = (source: string) => {
  const tree = parse(source);
  const declarations = new Map<string, ts.Expression>();
  walk(tree, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      declarations.set(node.name.text, node.initializer);
    }
  });
  const resolve = (
    expression: ts.Expression,
    seen = new Set<string>(),
  ): ts.ObjectLiteralExpression | undefined => {
    if (ts.isObjectLiteralExpression(expression)) {
      return expression;
    }
    if (
      ts.isSatisfiesExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isParenthesizedExpression(expression)
    ) {
      return resolve(expression.expression, seen);
    }
    if (!ts.isIdentifier(expression) || seen.has(expression.text)) {
      return undefined;
    }
    seen.add(expression.text);
    const initializer = declarations.get(expression.text);
    return initializer ? resolve(initializer, seen) : undefined;
  };
  const nonJsonConstructs: ts.Node[] = [];
  walk(tree, (node) => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ["Response", "ReadableStream", "Blob", "File"].includes(
        node.expression.text,
      )
    ) {
      nonJsonConstructs.push(node);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "stream"
    ) {
      nonJsonConstructs.push(node);
    }
  });
  const eligible: boolean[] = [];
  walk(tree, (node) => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isIdentifier(node.expression) ||
      !/^createSafe(?:Root)?Handler$/u.test(node.expression.text)
    ) {
      return;
    }
    const configExpression = node.arguments.at(0);
    const config = configExpression ? resolve(configExpression) : undefined;
    const idempotency = config ? property(config, "idempotency") : undefined;
    const replay = idempotency ? resolve(idempotency) : undefined;
    const type = replay ? property(replay, "type") : undefined;
    const declaresReplay =
      type !== undefined && ts.isStringLiteral(type) && type.text === "replay";
    const mcpExpression = config ? property(config, "mcp") : undefined;
    const mcp = mcpExpression ? resolve(mcpExpression) : undefined;
    const reason = mcp ? property(mcp, "reason") : undefined;
    if (
      declaresReplay &&
      reason !== undefined &&
      ts.isStringLiteral(reason) &&
      reason.text === "provider_secret"
    ) {
      throw new TypeError(
        "Credential-bearing handlers cannot retain replay receipts",
      );
    }
    eligible.push(declaresReplay);
  });
  return (
    nonJsonConstructs.length === 0 &&
    eligible.length > 0 &&
    eligible.every(Boolean)
  );
};

test("every create route and capability declares JSON request replay or a reasoned exception", async () => {
  const mounted = await mountedCreateRouteCensus();
  expect(mounted.length).toBeGreaterThan(75);
  const served = new Set(
    apiRoutes.map(({ method, path: routePath }) => `${method} ${routePath}`),
  );
  for (const route of mounted) {
    expect(served.has(`${route.method} ${route.path}`)).toBe(true);
  }
  expect(mounted).toContainEqual({
    method: "POST",
    path: "/v1/api-keys",
    file: "src/handlers/api-keys/create.ts",
    replay: false,
  });
  const creates = new Set(mounted.map(({ file }) => file));
  for (const file of new Bun.Glob(
    "src/mcp/generated/capability-dispatch/*.ts",
  ).scanSync({ cwd: apiRoot })) {
    for (const handler of collectCreateCapabilities(
      readFileSync(path.join(apiRoot, file), "utf-8"),
    )) {
      creates.add(handler);
    }
  }
  expect(creates.size).toBeGreaterThan(80);
  const withoutReplay = [...creates]
    .filter(
      (file) =>
        !hasReplayConfig(readFileSync(path.join(apiRoot, file), "utf-8")),
    )
    .toSorted();
  const rootNonReplayFiles = new Set(
    mounted
      .filter(
        ({ method, path: routePath }) =>
          ROOT_MUTATION_DISPOSITIONS_ENTRIES.get(`${method} ${routePath}`)
            ?.type === "non-replay",
      )
      .map(({ file }) => file),
  );
  expect(
    withoutReplay.filter(
      (file) =>
        !rootNonReplayFiles.has(file) &&
        !Object.hasOwn(CREATE_MUTATION_DISPOSITIONS, file),
    ),
  ).toEqual(
    Object.keys(IDEMPOTENCY_EXCEPTIONS)
      .filter(
        (file) =>
          !rootNonReplayFiles.has(file) &&
          !Object.hasOwn(CREATE_MUTATION_DISPOSITIONS, file),
      )
      .toSorted(),
  );
  for (const [file, disposition] of Object.entries(
    CREATE_MUTATION_DISPOSITIONS,
  )) {
    expect(creates.has(file)).toBe(true);
    expect(withoutReplay).toContain(file);
    expect(disposition.reason.length).toBeGreaterThan(20);
  }
  for (const reason of Object.values(IDEMPOTENCY_EXCEPTIONS)) {
    expect(reason.length).toBeGreaterThan(20);
  }
});

test("the create census follows mounted handler identities and capability owners", () => {
  const create = { config: { idempotency: { type: "replay" } } };
  const update = { config: {} };
  expect(
    collectIdempotentCreateRoutes({
      routes: [
        { method: "POST", path: "/v1/items", definition: create },
        { method: "PUT", path: "/v1/items/new", definition: create },
        { method: "GET", path: "/v1/items", definition: create },
        { method: "POST", path: "/v1/items/update", definition: update },
      ],
      endpoints: [
        {
          file: "src/handlers/items/create.ts",
          definition: create,
          create: true,
        },
        {
          file: "src/handlers/items/update.ts",
          definition: update,
          create: false,
        },
      ],
    }),
  ).toEqual([
    {
      method: "POST",
      path: "/v1/items",
      file: "src/handlers/items/create.ts",
      replay: true,
    },
    {
      method: "PUT",
      path: "/v1/items/new",
      file: "src/handlers/items/create.ts",
      replay: true,
    },
  ]);
  expect([
    ...collectCreateCapabilities(`
    export const dispatch = {
      "example.create": { load: () => import("@/api/handlers/example/save") },
      "example.update": { load: () => import("@/api/handlers/example/update") }
    };
  `),
  ]).toEqual(["src/handlers/example/save.ts"]);
});

test("the create census rejects missing, unrelated and disabled replay declarations", () => {
  for (const config of ["{}", '{ idempotency: { type: "disabled" } }']) {
    expect(
      hasReplayConfig(`
      const unrelated = { idempotency: { type: "replay" } };
      createSafeHandler(${config}, handler);
    `),
    ).toBe(false);
  }
  expect(
    hasReplayConfig(`
    const config = { idempotency: { type: "replay" } } satisfies HandlerConfig;
    createSafeRootHandler(config, handler);
  `),
  ).toBe(true);
});

test("the create census rejects direct response and stream replay", () => {
  for (const result of [
    "new Response(body)",
    "new ReadableStream()",
    "request.stream(body)",
  ]) {
    expect(
      hasReplayConfig(`
      createSafeRootHandler({ idempotency: { type: "replay" } }, () => ${result});
    `),
    ).toBe(false);
  }
});

test("the create census rejects replay of generated credentials", () => {
  for (const handler of ["createSafeHandler", "createSafeRootHandler"]) {
    expect(() =>
      hasReplayConfig(`
      const access = { type: "internal", reason: "provider_secret" };
      const config = {
        idempotency: { type: "replay" },
        mcp: access,
      } satisfies HandlerConfig;
      ${handler}(config, () => Result.ok({ credential: "generated" }));
    `),
    ).toThrow("Credential-bearing handlers cannot retain replay receipts");
  }
});

const exceptionKeys = (source: string) => {
  let keys: string[] | undefined;
  walk(parse(source), (node) => {
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isIdentifier(node.name) ||
      node.name.text !== "IDEMPOTENCY_EXCEPTIONS" ||
      !node.initializer
    ) {
      return;
    }
    let object = node.initializer;
    while (ts.isSatisfiesExpression(object) || ts.isAsExpression(object)) {
      object = object.expression;
    }
    if (!ts.isObjectLiteralExpression(object)) {
      return;
    }
    keys = object.properties.flatMap((entry) =>
      ts.isPropertyAssignment(entry) && ts.isStringLiteral(entry.name)
        ? [entry.name.text]
        : [],
    );
  });
  return keys;
};

const addedExceptions = (base: string, current: readonly string[]) => {
  const previous = exceptionKeys(base);
  if (previous === undefined) {
    throw new TypeError("Base idempotency exception inventory is missing");
  }
  return current.filter((key) => !previous.includes(key));
};

// Compare one pinned tree rather than walking commit history. The first guard
// lands with the explicitly reasoned inventory above; subsequent changes shrink it.
test("the create replay exception inventory only shrinks", () => {
  const git = (args: string[]) =>
    Bun.spawnSync(["git", ...args], {
      cwd: path.resolve(apiRoot, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    });
  const base = git(["merge-base", "origin/main", "HEAD"]);
  expect(base.exitCode).toBe(0);
  const sha = base.stdout.toString().trim();
  const file = "apps/api/src/handlers/idempotency-census.test.ts";
  const exists = git(["ls-tree", "--name-only", sha, "--", file]);
  expect(exists.exitCode).toBe(0);
  if (exists.stdout.toString().trim() === "") {
    return;
  }
  const previous = git(["show", `${sha}:${file}`]);
  expect(previous.exitCode).toBe(0);
  expect(
    addedExceptions(
      previous.stdout.toString(),
      Object.keys(IDEMPOTENCY_EXCEPTIONS),
    ),
  ).toEqual([]);
});

test("the exception shrink guard detects new and substituted handlers", () => {
  const base =
    'const IDEMPOTENCY_EXCEPTIONS = { "one": "Written reason" } as const satisfies Record<string, string>;';
  expect(addedExceptions(base, [])).toEqual([]);
  expect(addedExceptions(base, ["one"])).toEqual([]);
  expect(addedExceptions(base, ["one", "two"])).toEqual(["two"]);
  expect(addedExceptions(base, ["two"])).toEqual(["two"]);
  expect(() => addedExceptions("export {};", [])).toThrow(
    "Base idempotency exception inventory is missing",
  );
});

test("every mounted root mutation has an explicit replay disposition", () => {
  const mutations = apiRoutes.filter(
    ({ method, definition }) =>
      definition.access === "member" &&
      method !== "GET" &&
      method !== "OPTIONS",
  );
  expect(mutations.length).toBeGreaterThan(0);
  expect(
    mutations
      .map(({ method, path: routePath }) => `${method} ${routePath}`)
      .toSorted(),
  ).toEqual(Object.keys(ROOT_MUTATION_DISPOSITIONS).toSorted());
  const dispositions = ROOT_MUTATION_DISPOSITIONS_ENTRIES;
  for (const { method, path: routePath, definition } of mutations) {
    const disposition = dispositions.get(`${method} ${routePath}`);
    expect(disposition).toBeDefined();
    expect(disposition?.type === "replay").toBe(
      definition.config["idempotency"] !== undefined,
    );
  }
});
