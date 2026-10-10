import type { buildReportData } from "@/api/handlers/reports/build-report-data";
import type { resolveDocumentReviewRunInputs } from "@/api/lib/document-review/run-inputs";
import type {
  loadEntityVersionDocxBuffer,
  resolveEntityVersionFile,
} from "@/api/lib/entity-versions/load-entity-version-file-buffer";
import type { ContentReadDb, RootRunActor } from "@/api/lib/root-scoped-db";

declare const actor: RootRunActor<"documentTranslationRun">;
declare const pinned: RootRunActor<"documentTranslationRun">["writeSafeDb"];

type ReviewInputDb = Parameters<typeof resolveDocumentReviewRunInputs>[0];
type FileReadDb = Parameters<typeof resolveEntityVersionFile>[0]["safeDb"];
type DocxReadDb = Parameters<typeof loadEntityVersionDocxBuffer>[0]["safeDb"];
type ReportReadDb = Parameters<typeof buildReportData>[0]["safeDb"];

// A run reads what it works on through its membership scope.
export const reviewInput: ReviewInputDb = actor.inputDb;
export const fileInput: FileReadDb = actor.inputSafeDb;
export const docxInput: DocxReadDb = actor.inputSafeDb;
export const reportInput: ReportReadDb = actor.inputSafeDb;
export const contentInput: ContentReadDb = actor.inputSafeDb;

// Never through the handle it writes its own rows with.
// @ts-expect-error Run inputs are read through `inputDb`.
export const reviewPinned: ReviewInputDb = actor.writeDb;
// @ts-expect-error Run inputs are read through `inputSafeDb`.
export const filePinned: FileReadDb = actor.writeSafeDb;
// @ts-expect-error Run inputs are read through `inputSafeDb`.
export const docxPinned: DocxReadDb = actor.writeSafeDb;
// @ts-expect-error Run inputs are read through `inputSafeDb`.
export const reportPinned: ReportReadDb = actor.writeSafeDb;
// @ts-expect-error A pinned handle is not a content reader's handle.
export const contentPinned: ContentReadDb = pinned;
