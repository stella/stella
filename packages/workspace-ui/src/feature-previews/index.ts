/**
 * Feature previews: small, static product scenes composed from the same
 * components the app renders (kanban cards, comment cards, court badges,
 * matter icons, task status glyphs, money formatting), for marketing pages,
 * menus and slides that must stay in step with the product.
 *
 * One entry rather than one subpath per scene, because the scenes share one
 * contract: each takes its interface labels and a formatting locale, carries
 * its own untranslated mock data, and fills the box its host gives it.
 */

export type { BillingPreviewLabels } from "./billing-preview";
export { BillingPreview } from "./billing-preview";
export type { ContactsPreviewLabels } from "./contacts-preview";
export { ContactsPreview } from "./contacts-preview";
export type { DocumentsPreviewLabels } from "./documents-preview";
export { DocumentsPreview } from "./documents-preview";
export type { MattersPreviewLabels } from "./matters-preview";
export { MattersPreview } from "./matters-preview";
export type { ResearchPreviewLabels } from "./research-preview";
export { ResearchPreview } from "./research-preview";
export type { FeaturePreviewProps } from "./surface";
export type { TimeTrackingPreviewLabels } from "./time-tracking-preview";
export { TimeTrackingPreview } from "./time-tracking-preview";
