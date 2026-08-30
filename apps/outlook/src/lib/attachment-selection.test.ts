import { expect, test } from "bun:test";

import {
  attachmentsForIngestion,
  selectedOrdinaryAttachmentIds,
} from "@/lib/attachment-selection";
import type { OutlookAttachment } from "@/types";

const attachment = (id: string): OutlookAttachment => ({
  contentType: "application/pdf",
  id,
  isInline: false,
  name: `${id}.pdf`,
  size: 100,
});

test("new attachments remain selected after an earlier attachment was excluded", () => {
  const excluded = new Set(["attachment-a"]);
  const refreshed = [attachment("attachment-a"), attachment("attachment-b")];

  expect(selectedOrdinaryAttachmentIds(refreshed, excluded)).toEqual(
    new Set(["attachment-b"]),
  );
  expect(
    attachmentsForIngestion(refreshed, excluded).map(({ id }) => id),
  ).toEqual(["attachment-b"]);
});
