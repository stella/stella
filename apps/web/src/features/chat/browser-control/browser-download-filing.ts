import { Result } from "better-result";
import * as v from "valibot";

import { BROWSER_CONTROL_LIMITS } from "@stll/api-contract/browser-control";
import { browserDownloadFiledSchema } from "@stll/api-contract/browser-downloads";

import { api } from "@/lib/api";
import { invokeAppOnlyWrite } from "@/lib/capabilities/capability-request";
import { APIError, unwrapApiResponse } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";

import {
  createBrowserDownloadInbox,
  type FileBrowserDownload,
} from "./browser-download-inbox";

const FILE_OPERATION = "chat.threads.browser-downloads.create";

const NOT_FILED_MESSAGE = "The file could not be filed.";

const chatThread = (threadId: string) =>
  api.chat.threads({ threadId: toSafeId<"chatThread">(threadId) });

/**
 * Files a download with its chat through the API, as the member: the API
 * reads the chat's own matter from the thread. What the model is told of a
 * refusal is the API's own message (English, like every browser result).
 * Only the member's own browser hands such a file over, so the write has
 * no automation capability.
 */
export const fileBrowserDownloadWithChat: FileBrowserDownload = async ({
  downloadedAt,
  file,
  pageUrl,
  sourceUrl,
  threadId,
}) => {
  const filed = await Result.tryPromise({
    try: async () =>
      await invokeAppOnlyWrite(FILE_OPERATION, async () =>
        unwrapApiResponse(
          await chatThread(threadId)["browser-downloads"].post({
            downloadedAt,
            file,
            sourceUrl,
            ...(pageUrl === null ? {} : { pageUrl }),
          }),
        ),
      ),
    catch: (cause) => cause,
  });
  const parsed = Result.isOk(filed)
    ? v.safeParse(browserDownloadFiledSchema, filed.value)
    : null;
  if (parsed?.success === true) {
    return { filed: parsed.output, outcome: "filed", sourceUrl };
  }
  const apiMessage =
    Result.isError(filed) && APIError.is(filed.error)
      ? filed.error.rawMessage?.trim()
      : undefined;
  const reason =
    apiMessage === undefined || apiMessage === ""
      ? NOT_FILED_MESSAGE
      : apiMessage;
  return {
    message: reason.slice(0, BROWSER_CONTROL_LIMITS.errorMessageChars),
    name: file.name.slice(0, BROWSER_CONTROL_LIMITS.downloadNameChars),
    outcome: "not-filed",
    sourceUrl,
  };
};

/** This stella tab's downloads, shared by every chat in it. */
export const browserDownloadInbox = createBrowserDownloadInbox({
  file: fileBrowserDownloadWithChat,
});
