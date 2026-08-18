import Elysia from "elysia";

import businessRegistriesLookup from "@/api/handlers/contacts/business-registries-lookup";
import createContact from "@/api/handlers/contacts/create";
import deleteContactById from "@/api/handlers/contacts/delete";
import exportContacts from "@/api/handlers/contacts/export";
import extractProcuracao from "@/api/handlers/contacts/extract-procuracao";
import readContactById from "@/api/handlers/contacts/get";
import importContacts from "@/api/handlers/contacts/import";
import inspectContactImport from "@/api/handlers/contacts/import-inspect";
import previewContactImport from "@/api/handlers/contacts/import-preview";
import validateContactImport from "@/api/handlers/contacts/import-validate";
import readContacts from "@/api/handlers/contacts/list";
import presignProcuracao from "@/api/handlers/contacts/presign-procuracao";
import searchContacts from "@/api/handlers/contacts/search";
import updateContactById from "@/api/handlers/contacts/update";
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
  .get("/export", exportContacts.handler, {
    permissions: exportContacts.config.permissions,
    query: exportContacts.config.query,
  })
  .post("/import/inspect", inspectContactImport.handler, {
    body: inspectContactImport.config.body,
    permissions: inspectContactImport.config.permissions,
  })
  .post("/import/preview", previewContactImport.handler, {
    body: previewContactImport.config.body,
    permissions: previewContactImport.config.permissions,
  })
  .post("/import/validate", validateContactImport.handler, {
    body: validateContactImport.config.body,
    permissions: validateContactImport.config.permissions,
  })
  .put("/", createContact.handler, {
    body: createContact.config.body,
    permissions: createContact.config.permissions,
  })
  .put("/import", importContacts.handler, {
    body: importContacts.config.body,
    permissions: importContacts.config.permissions,
  })
  .post("/procuracao-upload", presignProcuracao.handler, {
    body: presignProcuracao.config.body,
    permissions: presignProcuracao.config.permissions,
  })
  .post("/extract-from-procuracao", extractProcuracao.handler, {
    body: extractProcuracao.config.body,
    permissions: extractProcuracao.config.permissions,
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
