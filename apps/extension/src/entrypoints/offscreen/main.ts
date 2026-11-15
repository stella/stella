import { panic } from "better-result";

import {
  readShownPdf,
  takeShownPdfReaderRequest,
} from "../../lib/shown-pdf-reader";

/**
 * The offscreen document: it fetches a PDF the chat's tab shows and keeps
 * its bytes as a `blob:` address until the worker has had Chrome save it
 * (`shown-pdf-reader`). It answers only this extension's worker and pages,
 * and reads only public HTTPS addresses.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const request = takeShownPdfReaderRequest(message, sender, chrome.runtime.id);
  if (request === null) {
    return false;
  }
  switch (request.type) {
    case "read":
      readShownPdf(request.url, request.maxBytes)
        .then(sendResponse)
        .catch(() => {
          sendResponse(null);
        });
      // Answered once the read settles.
      return true;
    case "release":
      URL.revokeObjectURL(request.downloadUrl);
      sendResponse(null);
      return false;
    default:
      request satisfies never;
      return panic("Unhandled shown PDF reader request");
  }
});
