import Elysia from "elysia";

import { permissionMacro } from "@/api/lib/auth";

import listWipClients from "./wip/clients/list";
import listWip from "./wip/list";

export const billingRoute = new Elysia({ prefix: "/billing" })
  .use(permissionMacro)
  .get("/wip", listWip.handler, {
    permissions: listWip.config.permissions,
    query: listWip.config.query,
  })
  .get("/wip/clients", listWipClients.handler, {
    permissions: listWipClients.config.permissions,
    query: listWipClients.config.query,
  });
