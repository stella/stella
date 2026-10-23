import businessRegistriesCheck from "@/api/handlers/contacts/business-registries/check";
import businessRegistriesLookup from "@/api/handlers/contacts/business-registries/lookup";
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
import listSanctionsEvents from "@/api/handlers/contacts/sanctions/events/list";
import contactSanctions from "@/api/handlers/contacts/sanctions/get";
import listSanctionsMatches from "@/api/handlers/contacts/sanctions/matches/list";
import updateSanctionsMonitoring from "@/api/handlers/contacts/sanctions/monitoring/update";
import reviewSanctions from "@/api/handlers/contacts/sanctions/reviews/update";
import searchContacts from "@/api/handlers/contacts/search";
import updateContactById from "@/api/handlers/contacts/update";
import { routes } from "@/api/http/route";

// Every `/:contactId` route declares and validates the id in its own config.
export const contactsRoute = routes(
  {
    "/": { GET: readContacts, PUT: createContact },
    "/sanctions/matches": { GET: listSanctionsMatches },
    "/sanctions/events": { GET: listSanctionsEvents },
    "/search": { GET: searchContacts },
    "/business-registries": { GET: businessRegistriesLookup },
    "/business-registries/checks": { POST: businessRegistriesCheck },
    "/export": { GET: exportContacts },
    "/import/inspect": { POST: inspectContactImport },
    "/import/preview": { POST: previewContactImport },
    "/import/validate": { POST: validateContactImport },
    "/import": { PUT: importContacts },
    "/procuracao-upload": { POST: presignProcuracao },
    "/extract-from-procuracao": { POST: extractProcuracao },
    "/:contactId": {
      GET: readContactById,
      POST: updateContactById,
      DELETE: deleteContactById,
    },
    "/:contactId/sanctions": { GET: contactSanctions },
    "/:contactId/sanctions/reviews": { POST: reviewSanctions },
    "/:contactId/sanctions/monitoring": { POST: updateSanctionsMonitoring },
  },
  { prefix: "/contacts" },
);
