import Elysia from "elysia";

import businessRegistriesLookup from "@/api/handlers/contacts/business-registries-lookup";
import createContact from "@/api/handlers/contacts/create";
import deleteContactById from "@/api/handlers/contacts/delete-by-id";
import readContacts from "@/api/handlers/contacts/read";
import readContactById from "@/api/handlers/contacts/read-by-id";
import searchContacts from "@/api/handlers/contacts/search";
import updateContactById from "@/api/handlers/contacts/update-by-id";
import { authMacro, permissionMacro } from "@/api/lib/auth";

const contactIdParams = readContactById.config.params;

export const contactsRoute = new Elysia({ prefix: "/contacts" })
  .use(authMacro)
  .use(permissionMacro)
  .guard({
    validateAuth: true,
  })
  .get("/", readContacts.handler, {
    permissions: readContacts.config.permissions,
    query: readContacts.config.query,
  })
  .get("/search", searchContacts.handler, {
    permissions: searchContacts.config.permissions,
    query: searchContacts.config.query,
  })
  .get("/business-registries", businessRegistriesLookup.handler, {
    permissions: businessRegistriesLookup.config.permissions,
    query: businessRegistriesLookup.config.query,
  })
  .put("/", createContact.handler, {
    body: createContact.config.body,
    permissions: createContact.config.permissions,
  })
  .group(
    "/:contactId",
    {
      params: contactIdParams,
    },
    (app) =>
      app
        .get("/", readContactById.handler, {
          permissions: readContactById.config.permissions,
        })
        .post("/", updateContactById.handler, {
          body: updateContactById.config.body,
          permissions: updateContactById.config.permissions,
        })
        .delete("/", deleteContactById.handler, {
          permissions: deleteContactById.config.permissions,
        }),
  );
