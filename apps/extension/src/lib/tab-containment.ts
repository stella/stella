import { NON_PUBLIC_HTTPS_URL_PATTERNS } from "./origin-policy";
import { STELLA_HOSTNAMES } from "./trusted-origin";

const DOWNLOAD_BLOCK_RULE_ID = 1;
const PLAIN_HTTP_BLOCK_RULE_ID = 2;
const STELLA_BLOCK_RULE_ID = 3;
const FIRST_NON_PUBLIC_HOST_RULE_ID = 10;

const NON_PUBLIC_HOST_RULES = NON_PUBLIC_HTTPS_URL_PATTERNS.map(
  (regexFilter, index) => ({
    id: FIRST_NON_PUBLIC_HOST_RULE_ID + index,
    regexFilter,
  }),
);

export const CONTROLLED_TAB_RULE_IDS = [
  DOWNLOAD_BLOCK_RULE_ID,
  PLAIN_HTTP_BLOCK_RULE_ID,
  STELLA_BLOCK_RULE_ID,
  ...NON_PUBLIC_HOST_RULES.map(({ id }) => id),
];

const DOCUMENT_RESOURCE_TYPES = ["main_frame", "sub_frame"] as const;

const controlledTabRules = (
  tabId: number,
): chrome.declarativeNetRequest.Rule[] => [
  // Attachment responses are blocked before Chrome creates a download, so an
  // approved click can never write a file to the user's disk. Response-header
  // conditions need Chrome 128, which the manifest requires.
  {
    action: { type: "block" },
    condition: {
      resourceTypes: [...DOCUMENT_RESOURCE_TYPES, "other"],
      responseHeaders: [
        { header: "content-disposition", values: ["attachment*"] },
      ],
      tabIds: [tabId],
    },
    id: DOWNLOAD_BLOCK_RULE_ID,
    priority: 1,
  },
  // The origin policy holds for every document the tab loads, not only the
  // approved URL: links, form posts, redirects and subframes included.
  {
    action: { type: "block" },
    condition: {
      resourceTypes: [...DOCUMENT_RESOURCE_TYPES],
      tabIds: [tabId],
      urlFilter: "|http:",
    },
    id: PLAIN_HTTP_BLOCK_RULE_ID,
    priority: 1,
  },
  {
    action: { type: "block" },
    condition: {
      requestDomains: STELLA_HOSTNAMES,
      resourceTypes: [...DOCUMENT_RESOURCE_TYPES],
      tabIds: [tabId],
    },
    id: STELLA_BLOCK_RULE_ID,
    priority: 1,
  },
  ...NON_PUBLIC_HOST_RULES.map(
    ({ id, regexFilter }): chrome.declarativeNetRequest.Rule => ({
      action: { type: "block" },
      condition: {
        regexFilter,
        resourceTypes: [...DOCUMENT_RESOURCE_TYPES],
        tabIds: [tabId],
      },
      id,
      priority: 1,
    }),
  ),
];

/**
 * Confines the controlled tab before it loads anything: no downloads, and no
 * top-level or frame document outside the public-HTTPS origin policy. The
 * rules are keyed by fixed ids, so confining a new tab releases the old one.
 */
export const containControlledTab = async (tabId: number): Promise<void> => {
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: controlledTabRules(tabId),
    removeRuleIds: CONTROLLED_TAB_RULE_IDS,
  });
};

export const releaseControlledTab = async (): Promise<void> => {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: CONTROLLED_TAB_RULE_IDS,
  });
};
