import { expect, test } from "bun:test";

import {
  acceptsDocumentOcrRequests,
  DOCUMENT_OCR_AVAILABILITY,
} from "./document-ocr-availability";

test("document OCR requests are accepted for every status except unconfigured", () => {
  expect(
    Object.values(DOCUMENT_OCR_AVAILABILITY).filter((status) =>
      acceptsDocumentOcrRequests(status),
    ),
  ).toEqual([
    DOCUMENT_OCR_AVAILABILITY.live,
    DOCUMENT_OCR_AVAILABILITY.batched,
  ]);
});
