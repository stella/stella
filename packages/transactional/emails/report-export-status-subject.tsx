import { getTranslator } from "../i18n/translate";
import type { SupportedLang } from "../i18n/translate";
import type { ReportExportEmailStatus } from "./report-export-status";

const SUBJECT_KEYS = {
  completed: "reportExportStatus.completedSubject",
  failed: "reportExportStatus.failedSubject",
} as const;

export const subject = (lang: SupportedLang, status: ReportExportEmailStatus) =>
  getTranslator(lang)(SUBJECT_KEYS[status]);
