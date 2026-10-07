// Each presentation app's rendered data and action handles, pinned by its contract test.
const decisionFields = [
  "decisionId",
  "court",
  "courtAbbreviation",
  "decisionDate",
  "caseNumber",
  "ecli",
  "appUrl",
  "source_url",
] as const;
export const MCP_APP_CONSUMED_FIELDS = {
  search_case_law: [
    ...decisionFields.map((field) => `results[].${field}`),
    "results[].snippet",
    "facets.court[].tierLabel",
    "facets.court[].courts[].value",
    "nextCursor",
    "searches[].warnings[].message",
    "searches[].warnings[].hint",
    "nextStep",
    "message",
    "hint",
  ],
  lookup_case_law: [
    "items[].status",
    ...decisionFields.map((field) => `items[].${field}`),
    ...decisionFields.map((field) => `items[].candidates[].${field}`),
    "items[].message",
    "items[].hint",
    "message",
    "hint",
  ],
} as const;
