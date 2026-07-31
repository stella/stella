import type { PDFSearchResult } from "@/lib/pdf/pdf-search";
import type { SearchTextQuery } from "@/lib/search-text";

export type PDFSearchWorkerRequest = {
  bytes: ArrayBuffer;
  password?: string | undefined;
  requestId: number;
  searchText: SearchTextQuery;
};

export type PDFSearchWorkerResponse =
  | { status: "error"; message: string; requestId: number }
  | { status: "success"; requestId: number; result: PDFSearchResult | null };

export const isPDFSearchWorkerResponseForRequest = (
  response: PDFSearchWorkerResponse,
  requestId: number,
): boolean => response.requestId === requestId;
