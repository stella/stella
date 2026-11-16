import { expect, test } from "bun:test";

import { DOCUMENT_OCR_AVAILABILITY } from "@stll/api-contract/document-ocr-availability";

import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";

import { createGetDocumentOcrAvailability } from "./get";

test.each(Object.values(DOCUMENT_OCR_AVAILABILITY))(
  "reports the $type document OCR status as read",
  async (status) => {
    const handler = createGetDocumentOcrAvailability(async () => status);

    const result = await handler.handler(
      createTestHandlerContext<Parameters<typeof handler.handler>[0]>({
        audit: NO_AUDIT,
        safeDb: NO_DB,
        scopedDb: NO_DB,
      }),
    );

    expect(result).toEqual(status);
  },
);
