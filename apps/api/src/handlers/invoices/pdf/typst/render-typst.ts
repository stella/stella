import { Result } from "better-result";

import type { RenderInvoicePdfOptions } from "../render";
import { buildInvoiceTemplateData } from "./data";
import defaultTemplatePath from "./invoice.typ" with { type: "file" };
import type { PdfA3Attachment } from "./pdfa";
import { toPdfA3 } from "./pdfa";
import type { TypstRenderOutcome, TypstSession } from "./session";

export const loadDefaultInvoiceTemplate = () =>
  Bun.file(defaultTemplatePath).text();

type RenderInvoiceWithTypstOptions = {
  invoice: RenderInvoicePdfOptions;
  session: TypstSession;
  /** Typst source; the default template when omitted. */
  template?: string;
  attachments?: PdfA3Attachment[];
  createdAt: Date;
};

type TypstInvoiceRender =
  | { status: "rendered"; pdf: Uint8Array; compileMs: number }
  | Extract<TypstRenderOutcome, { status: "rejected" }>;

/**
 * Spike renderer: lays the invoice out with a Typst template in a sandboxed
 * WASM worker, then post-processes it into a PDF/A-3b candidate with the
 * given attachments. Not wired to any route; `render.ts` stays the live path.
 */
export const renderInvoiceWithTypst = async ({
  invoice,
  session,
  template,
  attachments = [],
  createdAt,
}: RenderInvoiceWithTypstOptions) => {
  const data = buildInvoiceTemplateData(invoice);
  if (data.isErr()) {
    return Result.err(data.error);
  }
  const outcome = await session.render({
    template: template ?? (await loadDefaultInvoiceTemplate()),
    inputs: { invoice: JSON.stringify(data.value) },
    format: "pdf",
  });
  if (outcome.status === "rejected") {
    return Result.ok(outcome satisfies TypstInvoiceRender);
  }
  const pdf = await toPdfA3(outcome.bytes, {
    title: data.value.title,
    lang: data.value.lang,
    createdAt,
    attachments,
  });
  return Result.ok({
    status: "rendered",
    pdf,
    compileMs: outcome.compileMs,
  } satisfies TypstInvoiceRender);
};
