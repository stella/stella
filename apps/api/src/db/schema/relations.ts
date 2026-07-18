import {
  billingCodes,
  expenses,
  invoices,
  rateEntries,
  rateTables,
  timeEntries,
} from "./billing";
import {
  caseLawCitations,
  caseLawCourtWeights,
  caseLawDecisions,
  caseLawFtsConfigs,
  caseLawIngestionEvents,
  caseLawIngestionFailures,
  caseLawMatterLinks,
  caseLawPolarityRules,
  caseLawSearchDocuments,
  caseLawSources,
} from "./case-law";
import {
  chatMessageSearchDocuments,
  chatMessages,
  chatThreadCompactions,
  chatThreadSearchDocuments,
  chatThreads,
  fileChatThreads,
  templateChatThreads,
} from "./chat";
import {
  clauseCategories,
  clauseVariants,
  clauseVersions,
  clauses,
  templateClauses,
  templateFills,
  templateRecipes,
} from "./clauses";
import { defineRelations, user } from "./common";
import {
  auditLogs,
  contactRelationships,
  contacts,
  infoSoudTrackedCases,
  schedulerJobRuns,
  schedulerJobs,
  workspaceContacts,
  workspaceMembers,
  workspaces,
} from "./contacts";
import {
  desktopEditHandoffs,
  desktopEditSessions,
  entities,
  entityLinks,
  entityVersionAiSummaries,
  entityVersions,
  fields,
  folioCollabSessionTokens,
  folioCollabSessions,
  justifications,
  pendingUploads,
  taskAssignees,
} from "./entities";
import {
  userFiles,
  workspaceViewTemplates,
  workspaceViews,
} from "./files-views";
import { flowDefinitions, flowRunSteps, flowRuns } from "./flows";
import {
  mcpConnectors,
  mcpOAuthClients,
  mcpOAuthState,
  mcpUserConnections,
} from "./mcp";
import {
  documentTypes,
  playbookDefinitionVersions,
  playbookDefinitions,
  properties,
  propertyDependencies,
} from "./properties";
import { reportExports } from "./reports";
import { agentSkillResources, agentSkills } from "./skills";
import { styleSets } from "./style-sets";
import {
  extractedContent,
  searchDocuments,
  templateCategories,
  templateVersions,
  templates,
} from "./templates";
import {
  anonymizationAllowlistEntries,
  anonymizationBlacklistEntries,
  documentCounters,
  matterCounters,
  organizationSettings,
} from "./workspace-admin";

export const relations = defineRelations(
  {
    agentSkills,
    agentSkillResources,
    styleSets,
    user,
    contacts,
    contactRelationships,
    workspaces,
    workspaceMembers,
    workspaceContacts,
    auditLogs,
    schedulerJobs,
    schedulerJobRuns,
    infoSoudTrackedCases,
    properties,
    propertyDependencies,
    playbookDefinitions,
    playbookDefinitionVersions,
    documentTypes,
    flowDefinitions,
    flowRuns,
    flowRunSteps,
    entities,
    taskAssignees,
    entityLinks,
    entityVersions,
    entityVersionAiSummaries,
    desktopEditSessions,
    desktopEditHandoffs,
    folioCollabSessions,
    folioCollabSessionTokens,
    pendingUploads,
    fields,
    justifications,
    templates,
    templateVersions,
    reportExports,
    timeEntries,
    billingCodes,
    rateTables,
    rateEntries,
    expenses,
    invoices,
    matterCounters,
    documentCounters,
    organizationSettings,
    anonymizationAllowlistEntries,
    anonymizationBlacklistEntries,
    clauseCategories,
    clauses,
    clauseVariants,
    clauseVersions,
    templateCategories,
    templateClauses,
    templateRecipes,
    templateFills,
    searchDocuments,
    extractedContent,
    caseLawSources,
    caseLawDecisions,
    caseLawCitations,
    caseLawPolarityRules,
    caseLawCourtWeights,
    caseLawFtsConfigs,
    caseLawMatterLinks,
    caseLawSearchDocuments,
    caseLawIngestionEvents,
    caseLawIngestionFailures,
    chatThreads,
    chatMessages,
    chatMessageSearchDocuments,
    chatThreadCompactions,
    chatThreadSearchDocuments,
    fileChatThreads,
    templateChatThreads,
    mcpConnectors,
    mcpOAuthClients,
    mcpUserConnections,
    mcpOAuthState,
    userFiles,
    workspaceViews,
    workspaceViewTemplates,
  },
  (r) => ({
    contacts: {
      workspacesAsClient: r.many.workspaces({
        from: r.contacts.id,
        to: r.workspaces.clientId,
      }),
      workspaceContacts: r.many.workspaceContacts({
        from: r.contacts.id,
        to: r.workspaceContacts.contactId,
      }),
      relationshipsAsPerson: r.many.contactRelationships({
        from: r.contacts.id,
        to: r.contactRelationships.personId,
        alias: "contactRelPerson",
      }),
      relationshipsAsRelated: r.many.contactRelationships({
        from: r.contacts.id,
        to: r.contactRelationships.relatedContactId,
        alias: "contactRelRelated",
      }),
      originatingAttorney: r.one.user({
        from: r.contacts.originatingAttorneyId,
        to: r.user.id,
        alias: "contactOrigAttorney",
      }),
      responsibleAttorney: r.one.user({
        from: r.contacts.responsibleAttorneyId,
        to: r.user.id,
        alias: "contactRespAttorney",
      }),
    },
    schedulerJobs: {
      runs: r.many.schedulerJobRuns({
        from: r.schedulerJobs.id,
        to: r.schedulerJobRuns.jobId,
      }),
    },
    schedulerJobRuns: {
      job: r.one.schedulerJobs({
        from: r.schedulerJobRuns.jobId,
        to: r.schedulerJobs.id,
      }),
    },
    infoSoudTrackedCases: {
      workspace: r.one.workspaces({
        from: r.infoSoudTrackedCases.workspaceId,
        to: r.workspaces.id,
      }),
      createdByUser: r.one.user({
        from: r.infoSoudTrackedCases.createdBy,
        to: r.user.id,
      }),
    },
    flowDefinitions: {
      createdByUser: r.one.user({
        from: r.flowDefinitions.createdByUserId,
        to: r.user.id,
      }),
      runs: r.many.flowRuns({
        from: r.flowDefinitions.id,
        to: r.flowRuns.definitionId,
      }),
    },
    flowRuns: {
      definition: r.one.flowDefinitions({
        from: r.flowRuns.definitionId,
        to: r.flowDefinitions.id,
      }),
      workspace: r.one.workspaces({
        from: r.flowRuns.workspaceId,
        to: r.workspaces.id,
      }),
      steps: r.many.flowRunSteps({
        from: r.flowRuns.id,
        to: r.flowRunSteps.runId,
      }),
    },
    flowRunSteps: {
      run: r.one.flowRuns({
        from: r.flowRunSteps.runId,
        to: r.flowRuns.id,
      }),
    },
    contactRelationships: {
      person: r.one.contacts({
        from: r.contactRelationships.personId,
        to: r.contacts.id,
        alias: "contactRelPerson",
      }),
      relatedContact: r.one.contacts({
        from: r.contactRelationships.relatedContactId,
        to: r.contacts.id,
        alias: "contactRelRelated",
      }),
    },
    userFiles: {
      user: r.one.user({
        from: r.userFiles.userId,
        to: r.user.id,
      }),
      thread: r.one.chatThreads({
        from: r.userFiles.threadId,
        to: r.chatThreads.id,
      }),
    },
    workspaces: {
      client: r.one.contacts({
        from: r.workspaces.clientId,
        to: r.contacts.id,
      }),
      properties: r.many.properties({
        from: r.workspaces.id,
        to: r.properties.workspaceId,
      }),
      entities: r.many.entities({
        from: r.workspaces.id,
        to: r.entities.workspaceId,
      }),
      timeEntries: r.many.timeEntries({
        from: r.workspaces.id,
        to: r.timeEntries.workspaceId,
      }),
      billingCodes: r.many.billingCodes({
        from: r.workspaces.id,
        to: r.billingCodes.workspaceId,
      }),
      rateTables: r.many.rateTables({
        from: r.workspaces.id,
        to: r.rateTables.workspaceId,
      }),
      expenses: r.many.expenses({
        from: r.workspaces.id,
        to: r.expenses.workspaceId,
      }),
      workspaceContacts: r.many.workspaceContacts({
        from: r.workspaces.id,
        to: r.workspaceContacts.workspaceId,
      }),
      members: r.many.workspaceMembers({
        from: r.workspaces.id,
        to: r.workspaceMembers.workspaceId,
      }),
      views: r.many.workspaceViews({
        from: r.workspaces.id,
        to: r.workspaceViews.workspaceId,
      }),
      folioCollabSessions: r.many.folioCollabSessions({
        from: r.workspaces.id,
        to: r.folioCollabSessions.workspaceId,
      }),
    },
    workspaceMembers: {
      workspace: r.one.workspaces({
        from: r.workspaceMembers.workspaceId,
        to: r.workspaces.id,
      }),
      user: r.one.user({
        from: r.workspaceMembers.userId,
        to: r.user.id,
      }),
    },
    workspaceContacts: {
      workspace: r.one.workspaces({
        from: r.workspaceContacts.workspaceId,
        to: r.workspaces.id,
      }),
      contact: r.one.contacts({
        from: r.workspaceContacts.contactId,
        to: r.contacts.id,
      }),
    },
    properties: {
      workspace: r.one.workspaces({
        from: r.properties.workspaceId,
        to: r.workspaces.id,
      }),
      dependencies: r.many.propertyDependencies({
        from: r.properties.id,
        to: r.propertyDependencies.propertyId,
      }),
      fields: r.many.fields({
        from: r.properties.id,
        to: r.fields.propertyId,
      }),
    },
    propertyDependencies: {
      property: r.one.properties({
        from: r.propertyDependencies.propertyId,
        to: r.properties.id,
      }),
      dependsOnProperty: r.one.properties({
        from: r.propertyDependencies.dependsOnPropertyId,
        to: r.properties.id,
      }),
    },
    playbookDefinitions: {
      versions: r.many.playbookDefinitionVersions({
        from: r.playbookDefinitions.id,
        to: r.playbookDefinitionVersions.playbookDefinitionId,
      }),
    },
    playbookDefinitionVersions: {
      playbookDefinition: r.one.playbookDefinitions({
        from: r.playbookDefinitionVersions.playbookDefinitionId,
        to: r.playbookDefinitions.id,
      }),
      createdByUser: r.one.user({
        from: r.playbookDefinitionVersions.createdBy,
        to: r.user.id,
      }),
    },
    entities: {
      workspace: r.one.workspaces({
        from: r.entities.workspaceId,
        to: r.workspaces.id,
      }),
      parent: r.one.entities({
        from: r.entities.parentId,
        to: r.entities.id,
        alias: "entityParent",
      }),
      children: r.many.entities({
        from: r.entities.id,
        to: r.entities.parentId,
        alias: "entityParent",
      }),
      versions: r.many.entityVersions({
        from: r.entities.id,
        to: r.entityVersions.entityId,
      }),
      desktopEditSessions: r.many.desktopEditSessions({
        from: r.entities.id,
        to: r.desktopEditSessions.entityId,
      }),
      folioCollabSessions: r.many.folioCollabSessions({
        from: r.entities.id,
        to: r.folioCollabSessions.entityId,
      }),
      currentVersion: r.one.entityVersions({
        from: r.entities.currentVersionId,
        to: r.entityVersions.id,
      }),
      createdByUser: r.one.user({
        from: r.entities.createdBy,
        to: r.user.id,
      }),
      lastEditedByUser: r.one.user({
        from: r.entities.lastEditedBy,
        to: r.user.id,
      }),
      searchDocument: r.one.searchDocuments({
        from: r.entities.id,
        to: r.searchDocuments.entityId,
      }),
      extractedContent: r.one.extractedContent({
        from: r.entities.id,
        to: r.extractedContent.entityId,
      }),
      assignees: r.many.taskAssignees({
        from: r.entities.id,
        to: r.taskAssignees.entityId,
      }),
      linksAsSource: r.many.entityLinks({
        from: r.entities.id,
        to: r.entityLinks.sourceEntityId,
        alias: "entityLinkSource",
      }),
      linksAsTarget: r.many.entityLinks({
        from: r.entities.id,
        to: r.entityLinks.targetEntityId,
        alias: "entityLinkTarget",
      }),
    },
    taskAssignees: {
      entity: r.one.entities({
        from: r.taskAssignees.entityId,
        to: r.entities.id,
      }),
      user: r.one.user({
        from: r.taskAssignees.userId,
        to: r.user.id,
      }),
    },
    entityLinks: {
      workspace: r.one.workspaces({
        from: r.entityLinks.workspaceId,
        to: r.workspaces.id,
      }),
      sourceEntity: r.one.entities({
        from: r.entityLinks.sourceEntityId,
        to: r.entities.id,
        alias: "entityLinkSource",
      }),
      targetEntity: r.one.entities({
        from: r.entityLinks.targetEntityId,
        to: r.entities.id,
        alias: "entityLinkTarget",
      }),
    },
    entityVersions: {
      entity: r.one.entities({
        from: r.entityVersions.entityId,
        to: r.entities.id,
      }),
      fields: r.many.fields({
        from: r.entityVersions.id,
        to: r.fields.entityVersionId,
      }),
      aiSummary: r.one.entityVersionAiSummaries({
        from: r.entityVersions.id,
        to: r.entityVersionAiSummaries.entityVersionId,
      }),
    },
    entityVersionAiSummaries: {
      entity: r.one.entities({
        from: r.entityVersionAiSummaries.entityId,
        to: r.entities.id,
      }),
      entityVersion: r.one.entityVersions({
        from: r.entityVersionAiSummaries.entityVersionId,
        to: r.entityVersions.id,
      }),
      workspace: r.one.workspaces({
        from: r.entityVersionAiSummaries.workspaceId,
        to: r.workspaces.id,
      }),
    },
    desktopEditSessions: {
      workspace: r.one.workspaces({
        from: r.desktopEditSessions.workspaceId,
        to: r.workspaces.id,
      }),
      entity: r.one.entities({
        from: r.desktopEditSessions.entityId,
        to: r.entities.id,
      }),
      property: r.one.properties({
        from: r.desktopEditSessions.propertyId,
        to: r.properties.id,
      }),
      baseVersion: r.one.entityVersions({
        from: r.desktopEditSessions.baseVersionId,
        to: r.entityVersions.id,
        alias: "desktopEditSessionBaseVersion",
      }),
      finalizedVersion: r.one.entityVersions({
        from: r.desktopEditSessions.finalizedVersionId,
        to: r.entityVersions.id,
        alias: "desktopEditSessionFinalizedVersion",
      }),
      createdByUser: r.one.user({
        from: r.desktopEditSessions.createdBy,
        to: r.user.id,
      }),
    },
    desktopEditHandoffs: {
      workspace: r.one.workspaces({
        from: r.desktopEditHandoffs.workspaceId,
        to: r.workspaces.id,
      }),
      entity: r.one.entities({
        from: r.desktopEditHandoffs.entityId,
        to: r.entities.id,
      }),
      property: r.one.properties({
        from: r.desktopEditHandoffs.propertyId,
        to: r.properties.id,
      }),
      createdByUser: r.one.user({
        from: r.desktopEditHandoffs.createdBy,
        to: r.user.id,
      }),
    },
    folioCollabSessions: {
      workspace: r.one.workspaces({
        from: r.folioCollabSessions.workspaceId,
        to: r.workspaces.id,
      }),
      entity: r.one.entities({
        from: r.folioCollabSessions.entityId,
        to: r.entities.id,
      }),
      property: r.one.properties({
        from: r.folioCollabSessions.propertyId,
        to: r.properties.id,
      }),
      baseVersion: r.one.entityVersions({
        from: r.folioCollabSessions.baseVersionId,
        to: r.entityVersions.id,
        alias: "folioCollabSessionBaseVersion",
      }),
      finalizedVersion: r.one.entityVersions({
        from: r.folioCollabSessions.finalizedVersionId,
        to: r.entityVersions.id,
        alias: "folioCollabSessionFinalizedVersion",
      }),
      createdByUser: r.one.user({
        from: r.folioCollabSessions.createdBy,
        to: r.user.id,
      }),
      tokens: r.many.folioCollabSessionTokens({
        from: r.folioCollabSessions.id,
        to: r.folioCollabSessionTokens.sessionId,
      }),
    },
    folioCollabSessionTokens: {
      session: r.one.folioCollabSessions({
        from: r.folioCollabSessionTokens.sessionId,
        to: r.folioCollabSessions.id,
      }),
      workspace: r.one.workspaces({
        from: r.folioCollabSessionTokens.workspaceId,
        to: r.workspaces.id,
      }),
      user: r.one.user({
        from: r.folioCollabSessionTokens.userId,
        to: r.user.id,
      }),
    },
    fields: {
      entityVersion: r.one.entityVersions({
        from: r.fields.entityVersionId,
        to: r.entityVersions.id,
      }),
      property: r.one.properties({
        from: r.fields.propertyId,
        to: r.properties.id,
      }),
      justification: r.one.justifications({
        from: r.fields.id,
        to: r.justifications.fieldId,
      }),
    },
    justifications: {
      field: r.one.fields({
        from: r.justifications.fieldId,
        to: r.fields.id,
      }),
    },
    templates: {
      category: r.one.templateCategories({
        from: r.templates.categoryId,
        to: r.templateCategories.id,
      }),
      templateClauses: r.many.templateClauses({
        from: r.templates.id,
        to: r.templateClauses.templateId,
      }),
      versions: r.many.templateVersions({
        from: r.templates.id,
        to: r.templateVersions.templateId,
      }),
    },
    templateVersions: {
      template: r.one.templates({
        from: r.templateVersions.templateId,
        to: r.templates.id,
      }),
    },
    billingCodes: {
      workspace: r.one.workspaces({
        from: r.billingCodes.workspaceId,
        to: r.workspaces.id,
      }),
    },
    timeEntries: {
      workspace: r.one.workspaces({
        from: r.timeEntries.workspaceId,
        to: r.workspaces.id,
      }),
      matter: r.one.entities({
        from: r.timeEntries.matterId,
        to: r.entities.id,
      }),
      invoice: r.one.invoices({
        from: r.timeEntries.invoiceId,
        to: r.invoices.id,
      }),
    },
    rateTables: {
      workspace: r.one.workspaces({
        from: r.rateTables.workspaceId,
        to: r.workspaces.id,
      }),
      entries: r.many.rateEntries({
        from: r.rateTables.id,
        to: r.rateEntries.rateTableId,
      }),
    },
    rateEntries: {
      rateTable: r.one.rateTables({
        from: r.rateEntries.rateTableId,
        to: r.rateTables.id,
      }),
    },
    expenses: {
      workspace: r.one.workspaces({
        from: r.expenses.workspaceId,
        to: r.workspaces.id,
      }),
      matter: r.one.entities({
        from: r.expenses.matterId,
        to: r.entities.id,
      }),
      invoice: r.one.invoices({
        from: r.expenses.invoiceId,
        to: r.invoices.id,
      }),
    },
    invoices: {
      workspace: r.one.workspaces({
        from: r.invoices.workspaceId,
        to: r.workspaces.id,
      }),
      timeEntries: r.many.timeEntries({
        from: r.invoices.id,
        to: r.timeEntries.invoiceId,
      }),
      expenses: r.many.expenses({
        from: r.invoices.id,
        to: r.expenses.invoiceId,
      }),
    },
    matterCounters: {},
    documentCounters: {},
    organizationSettings: {},
    anonymizationAllowlistEntries: {},
    anonymizationBlacklistEntries: {},
    clauseCategories: {
      parent: r.one.clauseCategories({
        from: r.clauseCategories.parentId,
        to: r.clauseCategories.id,
        alias: "categoryParent",
      }),
      children: r.many.clauseCategories({
        from: r.clauseCategories.id,
        to: r.clauseCategories.parentId,
        alias: "categoryParent",
      }),
      clauses: r.many.clauses({
        from: r.clauseCategories.id,
        to: r.clauses.categoryId,
      }),
    },
    clauses: {
      category: r.one.clauseCategories({
        from: r.clauses.categoryId,
        to: r.clauseCategories.id,
      }),
      variants: r.many.clauseVariants({
        from: r.clauses.id,
        to: r.clauseVariants.clauseId,
      }),
      versions: r.many.clauseVersions({
        from: r.clauses.id,
        to: r.clauseVersions.clauseId,
      }),
      createdByUser: r.one.user({
        from: r.clauses.createdBy,
        to: r.user.id,
      }),
    },
    clauseVariants: {
      clause: r.one.clauses({
        from: r.clauseVariants.clauseId,
        to: r.clauses.id,
      }),
    },
    clauseVersions: {
      clause: r.one.clauses({
        from: r.clauseVersions.clauseId,
        to: r.clauses.id,
      }),
    },
    templateCategories: {
      parent: r.one.templateCategories({
        from: r.templateCategories.parentId,
        to: r.templateCategories.id,
        alias: "templateCategoryParent",
      }),
      children: r.many.templateCategories({
        from: r.templateCategories.id,
        to: r.templateCategories.parentId,
        alias: "templateCategoryParent",
      }),
      templates: r.many.templates({
        from: r.templateCategories.id,
        to: r.templates.categoryId,
      }),
    },
    templateFills: {
      template: r.one.templates({
        from: r.templateFills.templateId,
        to: r.templates.id,
      }),
      user: r.one.user({
        from: r.templateFills.userId,
        to: r.user.id,
      }),
    },
    templateClauses: {
      template: r.one.templates({
        from: r.templateClauses.templateId,
        to: r.templates.id,
      }),
      clause: r.one.clauses({
        from: r.templateClauses.clauseId,
        to: r.clauses.id,
      }),
      clauseVariant: r.one.clauseVariants({
        from: r.templateClauses.clauseVariantId,
        to: r.clauseVariants.id,
      }),
      clauseVersion: r.one.clauseVersions({
        from: r.templateClauses.clauseVersionId,
        to: r.clauseVersions.id,
      }),
    },
    searchDocuments: {
      entity: r.one.entities({
        from: r.searchDocuments.entityId,
        to: r.entities.id,
      }),
      workspace: r.one.workspaces({
        from: r.searchDocuments.workspaceId,
        to: r.workspaces.id,
      }),
    },
    extractedContent: {
      entity: r.one.entities({
        from: r.extractedContent.entityId,
        to: r.entities.id,
      }),
    },
    caseLawSources: {},
    caseLawDecisions: {
      source: r.one.caseLawSources({
        from: r.caseLawDecisions.sourceId,
        to: r.caseLawSources.id,
      }),
      citationsFrom: r.many.caseLawCitations({
        from: r.caseLawDecisions.id,
        to: r.caseLawCitations.citingDecisionId,
      }),
      citationsTo: r.many.caseLawCitations({
        from: r.caseLawDecisions.id,
        to: r.caseLawCitations.citedDecisionId,
      }),
      searchDocument: r.one.caseLawSearchDocuments({
        from: r.caseLawDecisions.id,
        to: r.caseLawSearchDocuments.decisionId,
      }),
    },
    caseLawCitations: {
      citingDecision: r.one.caseLawDecisions({
        from: r.caseLawCitations.citingDecisionId,
        to: r.caseLawDecisions.id,
      }),
      citedDecision: r.one.caseLawDecisions({
        from: r.caseLawCitations.citedDecisionId,
        to: r.caseLawDecisions.id,
      }),
      polarityRule: r.one.caseLawPolarityRules({
        from: r.caseLawCitations.polarityRuleId,
        to: r.caseLawPolarityRules.id,
      }),
    },
    caseLawPolarityRules: {},
    caseLawCourtWeights: {},
    caseLawFtsConfigs: {},
    caseLawMatterLinks: {
      decision: r.one.caseLawDecisions({
        from: r.caseLawMatterLinks.decisionId,
        to: r.caseLawDecisions.id,
      }),
      workspace: r.one.workspaces({
        from: r.caseLawMatterLinks.workspaceId,
        to: r.workspaces.id,
      }),
      linkedByUser: r.one.user({
        from: r.caseLawMatterLinks.linkedBy,
        to: r.user.id,
      }),
    },
    caseLawSearchDocuments: {
      decision: r.one.caseLawDecisions({
        from: r.caseLawSearchDocuments.decisionId,
        to: r.caseLawDecisions.id,
      }),
    },
    caseLawIngestionEvents: {
      source: r.one.caseLawSources({
        from: r.caseLawIngestionEvents.sourceId,
        to: r.caseLawSources.id,
      }),
    },
    caseLawIngestionFailures: {
      source: r.one.caseLawSources({
        from: r.caseLawIngestionFailures.sourceId,
        to: r.caseLawSources.id,
      }),
    },
    chatThreads: {
      workspace: r.one.workspaces({
        from: r.chatThreads.workspaceId,
        to: r.workspaces.id,
      }),
      messages: r.many.chatMessages({
        from: r.chatThreads.id,
        to: r.chatMessages.threadId,
      }),
      compactions: r.many.chatThreadCompactions({
        from: r.chatThreads.id,
        to: r.chatThreadCompactions.threadId,
      }),
      fileChatThread: r.one.fileChatThreads({
        from: r.chatThreads.id,
        to: r.fileChatThreads.chatThreadId,
      }),
      messageSearchDocuments: r.many.chatMessageSearchDocuments({
        from: r.chatThreads.id,
        to: r.chatMessageSearchDocuments.threadId,
      }),
      searchDocument: r.one.chatThreadSearchDocuments({
        from: r.chatThreads.id,
        to: r.chatThreadSearchDocuments.threadId,
      }),
      userFiles: r.many.userFiles({
        from: r.chatThreads.id,
        to: r.userFiles.threadId,
      }),
    },
    chatMessages: {
      thread: r.one.chatThreads({
        from: r.chatMessages.threadId,
        to: r.chatThreads.id,
      }),
      workspace: r.one.workspaces({
        from: r.chatMessages.workspaceId,
        to: r.workspaces.id,
      }),
      searchDocument: r.one.chatMessageSearchDocuments({
        from: r.chatMessages.id,
        to: r.chatMessageSearchDocuments.messageId,
      }),
    },
    chatMessageSearchDocuments: {
      message: r.one.chatMessages({
        from: r.chatMessageSearchDocuments.messageId,
        to: r.chatMessages.id,
      }),
      thread: r.one.chatThreads({
        from: r.chatMessageSearchDocuments.threadId,
        to: r.chatThreads.id,
      }),
    },
    chatThreadCompactions: {
      thread: r.one.chatThreads({
        from: r.chatThreadCompactions.threadId,
        to: r.chatThreads.id,
      }),
    },
    chatThreadSearchDocuments: {
      thread: r.one.chatThreads({
        from: r.chatThreadSearchDocuments.threadId,
        to: r.chatThreads.id,
      }),
    },
    fileChatThreads: {
      thread: r.one.chatThreads({
        from: r.fileChatThreads.chatThreadId,
        to: r.chatThreads.id,
      }),
      workspace: r.one.workspaces({
        from: r.fileChatThreads.workspaceId,
        to: r.workspaces.id,
      }),
      entity: r.one.entities({
        from: r.fileChatThreads.entityId,
        to: r.entities.id,
      }),
      field: r.one.fields({
        from: r.fileChatThreads.fieldId,
        to: r.fields.id,
      }),
    },
    templateChatThreads: {
      thread: r.one.chatThreads({
        from: r.templateChatThreads.chatThreadId,
        to: r.chatThreads.id,
      }),
      template: r.one.templates({
        from: r.templateChatThreads.templateId,
        to: r.templates.id,
      }),
    },
    mcpConnectors: {
      oauthClients: r.many.mcpOAuthClients({
        from: r.mcpConnectors.id,
        to: r.mcpOAuthClients.connectorId,
      }),
      userConnections: r.many.mcpUserConnections({
        from: r.mcpConnectors.id,
        to: r.mcpUserConnections.connectorId,
      }),
      oauthStates: r.many.mcpOAuthState({
        from: r.mcpConnectors.id,
        to: r.mcpOAuthState.connectorId,
      }),
    },
    mcpOAuthClients: {
      connector: r.one.mcpConnectors({
        from: r.mcpOAuthClients.connectorId,
        to: r.mcpConnectors.id,
      }),
    },
    mcpUserConnections: {
      connector: r.one.mcpConnectors({
        from: r.mcpUserConnections.connectorId,
        to: r.mcpConnectors.id,
      }),
      user: r.one.user({
        from: r.mcpUserConnections.userId,
        to: r.user.id,
      }),
    },
    mcpOAuthState: {
      connector: r.one.mcpConnectors({
        from: r.mcpOAuthState.connectorId,
        to: r.mcpConnectors.id,
      }),
      user: r.one.user({
        from: r.mcpOAuthState.userId,
        to: r.user.id,
      }),
    },
    workspaceViews: {
      workspace: r.one.workspaces({
        from: r.workspaceViews.workspaceId,
        to: r.workspaces.id,
      }),
    },
    workspaceViewTemplates: {
      user: r.one.user({
        from: r.workspaceViewTemplates.userId,
        to: r.user.id,
      }),
    },
    agentSkills: {
      user: r.one.user({
        from: r.agentSkills.userId,
        to: r.user.id,
      }),
      resources: r.many.agentSkillResources({
        from: r.agentSkills.id,
        to: r.agentSkillResources.skillId,
      }),
    },
    agentSkillResources: {
      skill: r.one.agentSkills({
        from: r.agentSkillResources.skillId,
        to: r.agentSkills.id,
      }),
    },
  }),
);
