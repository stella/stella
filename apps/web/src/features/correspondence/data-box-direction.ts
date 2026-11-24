import type { DataBoxDirectionBasis } from "@stll/api-contract/data-box";

import type { TranslationKey } from "@/i18n/types";

/**
 * What a data-box message says about its direction, wherever it is shown. A
 * message is incoming by default and needs no label; one sent from one of
 * the organization's boxes says so. When neither box is the organization's,
 * the file does not tell, so nothing is said rather than "unknown".
 */
export const DATA_BOX_DIRECTION_LABEL_KEYS = {
  organization_sender: "correspondence.dataBox.sent",
  organization_recipient: null,
  unknown: null,
} as const satisfies Record<DataBoxDirectionBasis, TranslationKey | null>;
