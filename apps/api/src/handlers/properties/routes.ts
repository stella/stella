import createPropertiesBatch from "@/api/handlers/properties/batch/create";
import createProperty from "@/api/handlers/properties/create";
import deleteProperty from "@/api/handlers/properties/delete";
import readProperties from "@/api/handlers/properties/list";
import previewProperty from "@/api/handlers/properties/preview";
import suggestPromptProperty from "@/api/handlers/properties/prompt/suggest";
import updateProperty from "@/api/handlers/properties/update";
import { mount, routes } from "@/api/http/route";

export const propertiesRoute = mount(
  [
    routes({
      "/": { PUT: createProperty, GET: readProperties },
      "/batch": { PUT: createPropertiesBatch },
      "/preview": { POST: previewProperty },
      "/suggest-prompt": { POST: suggestPromptProperty },
    }),
    routes(
      {
        "/": { POST: updateProperty, DELETE: deleteProperty },
      },
      { prefix: "/property/:propertyId" },
    ),
  ],
  { prefix: "/properties/:workspaceId" },
);
