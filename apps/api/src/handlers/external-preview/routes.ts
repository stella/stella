import previewExternalSource, {
  previewExternalFile,
} from "@/api/handlers/external-preview/preview";
import { routes } from "@/api/http/route";

export const externalPreviewRoute = routes(
  {
    "/": { GET: previewExternalSource },
    "/file": { GET: previewExternalFile },
  },
  { prefix: "/external-preview" },
);
