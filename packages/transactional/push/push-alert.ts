import { NOTIFICATION_KIND } from "@stll/api-contract/notifications";
import type { NotificationKind } from "@stll/api-contract/notifications";

import { getTranslator } from "../i18n/translate";
import type { SupportedLang } from "../i18n/translate";

/**
 * One fixed sentence per notification kind. A push alert is shown on a lock
 * screen and passes through Apple, so its text takes no parameters at all: no
 * matter, client, document, workflow or person is ever named in it.
 */
const PUSH_ALERT_KEYS = {
  [NOTIFICATION_KIND.MENTION]: "pushAlert.mention",
  [NOTIFICATION_KIND.REPORT_EXPORT_SUCCEEDED]:
    "pushAlert.reportExportSucceeded",
  [NOTIFICATION_KIND.REPORT_EXPORT_FAILED]: "pushAlert.reportExportFailed",
  [NOTIFICATION_KIND.FLOW_RUN_COMPLETED]: "pushAlert.flowRunCompleted",
  [NOTIFICATION_KIND.FLOW_RUN_FAILED]: "pushAlert.flowRunFailed",
  [NOTIFICATION_KIND.FLOW_RUN_AWAITING_APPROVAL]:
    "pushAlert.flowRunAwaitingApproval",
  [NOTIFICATION_KIND.ANNOUNCEMENT]: "pushAlert.announcement",
} as const satisfies Record<NotificationKind, `pushAlert.${string}`>;

/** The alert text for a notification of `kind`, in `lang`. */
export const pushAlertBody = (
  lang: SupportedLang,
  kind: NotificationKind,
): string => getTranslator(lang)(PUSH_ALERT_KEYS[kind]);
