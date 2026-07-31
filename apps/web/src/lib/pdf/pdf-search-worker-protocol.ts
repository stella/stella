import type { PDFSearchResult } from "@/lib/pdf/pdf-search";

export type PDFSearchWorkerRequest = {
  bytes: ArrayBuffer;
  password?: string | undefined;
  requestId: number;
  searchText: string;
};

export type PDFSearchWorkerResponse =
  | { status: "error"; message: string; requestId: number }
  | { status: "success"; requestId: number; result: PDFSearchResult | null };

export const isPDFSearchWorkerResponseForRequest = (
  response: PDFSearchWorkerResponse,
  requestId: number,
): boolean => response.requestId === requestId;
