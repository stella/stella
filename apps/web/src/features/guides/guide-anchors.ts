// Closed registry of guide tour anchors. A tour step can only target an anchor
// that exists in this union, so removing a feature (and its anchor) turns every
// referencing step into a typecheck error. The values are the `data-guide-anchor`
// attribute strings the runtime resolves at [data-guide-anchor="<value>"].
export const GUIDE_ANCHORS = {
  chatComposer: "chat-composer",
  chatToolsButton: "chat-tools-button",
  // Options inside the composer's (+) menu. They exist only while that menu is
  // open, so a step targeting one must follow a step that reveals it
  // (`interaction: { kind: "open" }` on the trigger).
  chatMenuAttach: "chat-menu-attach",
  chatMenuModels: "chat-menu-models",
  chatMenuSkills: "chat-menu-skills",
  chatMenuContext: "chat-menu-context",
  chatMenuMcp: "chat-menu-mcp",
  chatAnonymize: "chat-anonymize",
  chatSend: "chat-send",
  documentsUpload: "documents-upload",
  documentsList: "documents-list",
  playbooksOverview: "playbooks-overview",
  playbooksCreate: "playbooks-create",
  playbooksBack: "playbooks-back",
  playbooksBasics: "playbooks-basics",
  playbooksAddPosition: "playbooks-add-position",
  workflowsOverview: "workflows-overview",
  workflowsCreate: "workflows-create",
  workflowsBack: "workflows-back",
  workflowsTrigger: "workflows-trigger",
  workflowsSteps: "workflows-steps",
  workflowsReviewGate: "workflows-review-gate",
  tabularReviewTable: "tabular-review-table",
  tabularReviewAddColumn: "tabular-review-add-column",
  tabularReviewAnswerType: "tabular-review-answer-type",
} as const;

export type GuideAnchorId = (typeof GUIDE_ANCHORS)[keyof typeof GUIDE_ANCHORS];

// Anchors whose owning UI is not yet marked with `guideAnchor()`. Tours that
// reference them rely on the runner's graceful skip until wiring lands. The
// structural test (`guides.test.tsx`) requires every non-pending anchor to be
// registered in app source and forbids a pending anchor from already being
// registered: once you wire a pending anchor, remove it from this list or the
// test fails.
export const PENDING_GUIDE_ANCHOR_IDS: readonly GuideAnchorId[] = [];
