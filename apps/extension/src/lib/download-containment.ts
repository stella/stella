const DOWNLOAD_BLOCK_RULE_ID = 1;

/**
 * Blocks attachment responses in the controlled tab before Chrome creates a
 * download, so an approved click can never write a file to the user's disk.
 * Response-header conditions need Chrome 128, which the manifest requires.
 */
export const containDownloads = async (tabId: number): Promise<void> => {
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [
      {
        action: { type: "block" },
        condition: {
          resourceTypes: ["main_frame", "sub_frame", "other"],
          responseHeaders: [
            { header: "content-disposition", values: ["attachment*"] },
          ],
          tabIds: [tabId],
        },
        id: DOWNLOAD_BLOCK_RULE_ID,
        priority: 1,
      },
    ],
    removeRuleIds: [DOWNLOAD_BLOCK_RULE_ID],
  });
};

export const releaseDownloadContainment = async (): Promise<void> => {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [DOWNLOAD_BLOCK_RULE_ID],
  });
};
