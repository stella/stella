declare const __brand: unique symbol;

export type SafeIdType =
  | "billingCode"
  | "caseLawCitation"
  | "caseLawCourtWeight"
  | "caseLawDecision"
  | "caseLawIngestionEvent"
  | "caseLawIngestionFailure"
  | "caseLawMatterLink"
  | "caseLawPolarityRule"
  | "caseLawSource"
  | "chatMessage"
  | "chatThread"
  | "clause"
  | "clauseCategory"
  | "clauseVariant"
  | "clauseVersion"
  | "contact"
  | "contactRelationship"
  | "desktopEditSession"
  | "document"
  | "documentCounter"
  | "entity"
  | "entityVersion"
  | "expense"
  | "field"
  | "folder"
  | "invoice"
  | "justification"
  | "matter"
  | "matterCounter"
  | "organization"
  | "organizationSettings"
  | "property"
  | "propertyDependency"
  | "rateEntry"
  | "rateTable"
  | "taskAssignee"
  | "task"
  | "template"
  | "templateCategory"
  | "templateClause"
  | "templateFill"
  | "templateVersion"
  | "timeEntry"
  | "user"
  | "userFile"
  | "workspace"
  | "workspaceContact"
  | "workspaceMember"
  | "workspaceView"
  | "entityLink";

export type SafeId<T extends SafeIdType> = string & {
  readonly [__brand]: T;
};

// SAFETY: SafeId is a nominal brand; runtime validation happens at call sites
export const toSafeId = <T extends SafeIdType>(value: string): SafeId<T> =>
  // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
  value as SafeId<T>;

export const createSafeId = <T extends SafeIdType>(): SafeId<T> =>
  toSafeId<T>(Bun.randomUUIDv7());
