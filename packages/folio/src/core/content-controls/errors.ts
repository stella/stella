/**
 * Tagged errors for the content-controls API. Every write helper that
 * refuses a mutation throws one of these; consumers can either bubble the
 * error or retry with `{ force: true }`.
 */

import { TaggedError } from "better-result";

import type { SdtProperties } from "../types/document";

/**
 * Refused because the target control's `w:lock` forbids the requested
 * mutation. Caller can override with `{ force: true }` if they understand
 * the consequences (overrides apply per call, not per document).
 */
export class ContentControlLockedError extends TaggedError(
  "ContentControlLockedError",
)<{
  message: string;
  lock: NonNullable<SdtProperties["lock"]>;
  tag?: string;
  alias?: string;
}>() {}

/**
 * Refused because the target control is bound to a `<w:dataBinding>`.
 *
 * Word regenerates the SDT body from the bound XML on every open, so a
 * direct write to `<w:t>` is silently overwritten and the caller's edit
 * disappears on next open. Aspose.Words handles this by requiring an
 * explicit `XmlMapping.Delete()` before write; folio mirrors that
 * pattern: throw by default, accept `{ force: true }` as an opt-in that
 * strips the binding inline (the same destructive choice the caller
 * would have made explicitly via Aspose's API).
 *
 * Reference: python-docx #965, Aspose forum thread on removing custom
 * XML mapping before content updates.
 */
export class ContentControlBoundError extends TaggedError(
  "ContentControlBoundError",
)<{
  message: string;
  xpath: string;
  storeItemID?: string;
  tag?: string;
  alias?: string;
}>() {}

/**
 * Refused because the requested operation does not make sense for the
 * control's type — e.g. setting free text on a checkbox, or unwrapping a
 * `w15:repeatingSection` (which would orphan its row items).
 */
export class ContentControlTypeError extends TaggedError(
  "ContentControlTypeError",
)<{
  message: string;
  sdtType: SdtProperties["sdtType"];
  reason: string;
  tag?: string;
  alias?: string;
}>() {}
