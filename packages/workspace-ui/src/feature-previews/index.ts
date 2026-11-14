/**
 * Feature previews: small, static product scenes composed from the same
 * components the app renders (kanban cards, comment cards, court badges,
 * matter icons, task status glyphs, money formatting), for marketing pages,
 * menus and slides that must stay in step with the product.
 *
 * One entry rather than one subpath per scene, because the scenes share one
 * contract: each takes its interface labels, a formatting locale and,
 * optionally, its content (a fictional English set by default), and fills the
 * box its host gives it.
 */

export type {
  BillingPreviewData,
  BillingPreviewEntry,
  BillingPreviewLabels,
} from "./billing-preview";
export { BillingPreview } from "./billing-preview";
export type {
  ContactsPreviewData,
  ContactsPreviewLabels,
} from "./contacts-preview";
export { ContactsPreview } from "./contacts-preview";
export type {
  DocumentsPreviewComment,
  DocumentsPreviewData,
  DocumentsPreviewLabels,
} from "./documents-preview";
export { DocumentsPreview } from "./documents-preview";
export type {
  MattersPreviewData,
  MattersPreviewLabels,
  MattersPreviewTask,
  MattersPreviewTaskStatus,
} from "./matters-preview";
export { MattersPreview } from "./matters-preview";
export type { PreviewMatter, PreviewPerson } from "./mock-data";
export type {
  ResearchPreviewData,
  ResearchPreviewDecision,
  ResearchPreviewLabels,
} from "./research-preview";
export { ResearchPreview } from "./research-preview";
export type { FeaturePreviewProps } from "./surface";
export type {
  TimeTrackingPreviewData,
  TimeTrackingPreviewEntry,
  TimeTrackingPreviewLabels,
} from "./time-tracking-preview";
export { TimeTrackingPreview } from "./time-tracking-preview";
