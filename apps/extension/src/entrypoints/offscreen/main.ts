import { panic } from "better-result";

import {
  answerShownPdfRead,
  SHOWN_PDF_READER_PORT,
  takeShownPdfReaderRequest,
} from "../../lib/shown-pdf-reader";

/**
 * The offscreen document: it fetches a PDF the chat's tab shows and keeps
 * its bytes as a `blob:` address until the worker has had Chrome save it
 * (`shown-pdf-reader`). Each request comes over a port of its own; only
 * this extension's worker and pages are answered, and only public HTTPS
 * addresses are read. Anything else closes the port unanswered.
 */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== SHOWN_PDF_READER_PORT) {
    return;
  }
  port.onMessage.addListener((message: unknown) => {
    const request = takeShownPdfReaderRequest(
      message,
      port.sender,
      chrome.runtime.id,
    );
    if (request === null) {
      port.disconnect();
      return;
    }
    switch (request.type) {
      case "read":
        // A worker that stopped waiting closed the port; then the answer's
        // bytes are freed.
        answerShownPdfRead(request, (answer) => {
          port.postMessage(answer);
        }).catch(() => {
          port.disconnect();
        });
        return;
      case "release":
        URL.revokeObjectURL(request.downloadUrl);
        port.disconnect();
        return;
      default:
        request satisfies never;
        panic("Unhandled shown PDF reader request");
    }
  });
});
