import createStyleSet from "@/api/handlers/style-sets/create";
import deleteStyleSet from "@/api/handlers/style-sets/delete";
import downloadStyleSet from "@/api/handlers/style-sets/download";
import readStyleSetEditor from "@/api/handlers/style-sets/editor/get";
import createStyleSetFromEditor from "@/api/handlers/style-sets/from-editor/create";
import updateStyleSetFromEditor from "@/api/handlers/style-sets/from-editor/update";
import listStyleSets from "@/api/handlers/style-sets/list";
import previewStyleSetFromEditor from "@/api/handlers/style-sets/preview-from-editor";
import replaceStyleSet from "@/api/handlers/style-sets/replace";
import readStellaStyleEditor from "@/api/handlers/style-sets/stella-editor/get";
import updateStyleSet from "@/api/handlers/style-sets/update";
import { mount, routes } from "@/api/http/route";
import { styleSetUploadBudget } from "@/api/lib/rate-limit/dedicated-budgets";

/** Uploads spend the upload budget; reads and edits spend the shared one. */
export const styleSetsRoute = mount(
  [
    routes(
      {
        "/": { PUT: createStyleSet },
        "/editor": { PUT: createStyleSetFromEditor },
        "/:styleSetId/source": { POST: replaceStyleSet },
        "/:styleSetId/editor": { POST: updateStyleSetFromEditor },
      },
      { middleware: [styleSetUploadBudget] },
    ),
    routes({
      "/": { GET: listStyleSets },
      "/editor/stella": { GET: readStellaStyleEditor },
      "/editor/preview": { POST: previewStyleSetFromEditor },
      "/:styleSetId/download": { GET: downloadStyleSet },
      "/:styleSetId": { POST: updateStyleSet, DELETE: deleteStyleSet },
      "/:styleSetId/editor": { GET: readStyleSetEditor },
    }),
  ],
  { prefix: "/style-sets" },
);
