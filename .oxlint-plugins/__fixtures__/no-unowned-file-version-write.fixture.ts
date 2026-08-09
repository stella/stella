// Passive regression fixture for
// no-unowned-file-version-write/no-unowned-file-version-write.

import {
  // oxlint-disable-next-line no-unowned-file-version-write/no-unowned-file-version-write -- fixture: field cloning outside a reviewed owner must be rejected
  cloneFieldsForRevision as cloneRevisionFields,
  // oxlint-disable-next-line no-unowned-file-version-write/no-unowned-file-version-write -- fixture: version numbering outside a reviewed owner must be rejected
  nextEntityVersionNumber,
} from "@/api/lib/entity-versions/version-utils";

declare const tx: Parameters<typeof nextEntityVersionNumber>[0];
declare const entityId: Parameters<
  typeof nextEntityVersionNumber
>[1]["entityId"];
declare const workspaceId: Parameters<
  typeof nextEntityVersionNumber
>[1]["workspaceId"];

await nextEntityVersionNumber(tx, { entityId, workspaceId });
void cloneRevisionFields;
