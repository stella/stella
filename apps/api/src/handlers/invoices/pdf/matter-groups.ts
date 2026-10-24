import type { RenderInvoicePdfOptions } from "./render-helpers";

type PdfLine = RenderInvoicePdfOptions["invoice"]["lines"][number];

type InvoiceMatterGroup = {
  workspaceId: string;
  workspaceName: string;
  lines: PdfLine[];
  netAmount: number;
  vatAmount: number;
  grossAmount: number;
};

// Preserve the first appearance of each matter and the recorded line order.
// Sum stored line VAT rather than rounding the combined net amount again.
export const groupInvoiceLinesByMatter = (lines: PdfLine[]) => {
  const groups = new Map<string, InvoiceMatterGroup>();
  for (const line of lines) {
    let group = groups.get(line.workspaceId);
    if (group === undefined) {
      group = {
        workspaceId: line.workspaceId,
        workspaceName: line.workspaceName,
        lines: [],
        netAmount: 0,
        vatAmount: 0,
        grossAmount: 0,
      };
      groups.set(line.workspaceId, group);
    }
    group.lines.push(line);
    group.netAmount += line.netAmount;
    group.vatAmount += line.vatAmount;
    group.grossAmount += line.grossAmount;
  }
  return [...groups.values()];
};
