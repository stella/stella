import { PDF_MIME_TYPE } from "@/consts";
import { apiUrl } from "@/lib/api-url";
import { APIError } from "@/lib/errors/api";
import { fetchWithTimeout } from "@/lib/fetch";

const PRINT_IFRAME_CLEANUP_MS = 5 * 60 * 1000;

export const printPdfBuffer = (buffer: ArrayBuffer) => {
  const blob = new Blob([buffer], {
    type: PDF_MIME_TYPE,
  });
  const url = URL.createObjectURL(blob);
  const frame = document.createElement("iframe");
  frame.style.display = "none";
  frame.src = url;
  document.body.append(frame);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    frame.remove();
    URL.revokeObjectURL(url);
  };
  setTimeout(cleanup, PRINT_IFRAME_CLEANUP_MS);

  frame.addEventListener("load", () => {
    if (!frame.contentWindow) {
      cleanup();
      return;
    }
    frame.contentWindow.addEventListener("afterprint", cleanup, { once: true });
    frame.contentWindow.print();
  });
};

export const fetchPrintPdf = async ({
  workspaceId,
  fieldId,
  signal,
}: {
  workspaceId: string;
  fieldId: string;
  signal?: AbortSignal | undefined;
}) => {
  const response = await fetchWithTimeout(
    apiUrl(`/files/${workspaceId}/print-pdf/${fieldId}`),
    { credentials: "include", signal, timeoutMs: 30_000 },
  );

  if (!response.ok) {
    throw new APIError({
      status: response.status,
      message: "Failed to prepare printable PDF",
    });
  }

  return await response.arrayBuffer();
};
