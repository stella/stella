import { isPublicToolDownloadPath } from "@/lib/knowledge/public-tools-path";
import { isPublicSsrPath } from "@/lib/public-ssr-paths";

export const isSsrDocumentRequest = (request: Request): boolean => {
  if (request.method !== "GET") {
    return false;
  }
  const { pathname } = new URL(request.url);
  if (isPublicToolDownloadPath(pathname)) {
    return false;
  }
  return (
    isPublicSsrPath(pathname) ||
    request.headers.get("Accept")?.includes("text/html") === true
  );
};
