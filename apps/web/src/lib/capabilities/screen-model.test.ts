import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { RESOURCE_TYPE, resourceRef, toResourceName } from "@stll/api-contract";
import { compareCodeUnit } from "@stll/collation";

import type { ScreenAction } from "@/lib/capabilities/screen-actions";
import {
  deriveScreenModel,
  ROUTE_PARAM_DISPOSITIONS,
} from "@/lib/capabilities/screen-model";
import { toSafeId } from "@/lib/safe-id";

const WORKSPACE_ID = "018f6e4a-0000-7000-8000-000000000001";
const VIEW_ID = "018f6e4a-0000-7000-8000-000000000002";
const ENTITY_ID = "018f6e4a-0000-7000-8000-000000000003";
const FIELD_ID = "018f6e4a-0000-7000-8000-000000000004";
const DOCUMENT_ROUTE = "/_protected/workspaces/$workspaceId/$viewId/document";

const matter = toResourceName(
  resourceRef({
    type: RESOURCE_TYPE.WORKSPACE,
    id: toSafeId<"workspace">(WORKSPACE_ID),
  }),
);
const view = toResourceName(
  resourceRef({
    type: RESOURCE_TYPE.WORKSPACE_VIEW,
    id: toSafeId<"workspaceView">(VIEW_ID),
  }),
);
const entity = toResourceName(
  resourceRef({
    type: RESOURCE_TYPE.ENTITY,
    id: toSafeId<"entity">(ENTITY_ID),
  }),
);
const field = toResourceName(
  resourceRef({ type: RESOURCE_TYPE.FIELD, id: toSafeId<"field">(FIELD_ID) }),
);

describe("screen model", () => {
  test("every route parameter in the route tree has a disposition", () => {
    const routeTree = readFileSync(
      path.join(import.meta.dir, "../../routeTree.gen.ts"),
      "utf-8",
    );
    const params = new Set(
      [...routeTree.matchAll(/\$(?<name>[a-z][A-Za-z]*)/gu)].map(
        (match) => match.groups?.["name"],
      ),
    );

    expect(
      [...params]
        .filter((name) => name !== undefined)
        .toSorted(compareCodeUnit),
    ).toEqual(Object.keys(ROUTE_PARAM_DISPOSITIONS).toSorted(compareCodeUnit));
  });

  test("route parameters that name resources become resources", () => {
    const model = deriveScreenModel({
      routeId: "/_protected/workspaces/$workspaceId/$viewId/",
      pathname: `/workspaces/${WORKSPACE_ID}/${VIEW_ID}/`,
      params: { workspaceId: WORKSPACE_ID, viewId: VIEW_ID, slug: "lease" },
      search: {},
      actions: [],
    });

    expect(model).toEqual({
      route: {
        id: "/_protected/workspaces/$workspaceId/$viewId/",
        pathname: `/workspaces/${WORKSPACE_ID}/${VIEW_ID}/`,
      },
      resources: [matter, view],
      focus: null,
      actions: [],
    });
  });

  // Identifier formats belong to the API boundary that owns them; the screen
  // model drops only values the resource contract rejects.
  test("an identifier the resource contract rejects is not a resource", () => {
    const model = deriveScreenModel({
      routeId: "/_protected/workspaces/$workspaceId",
      pathname: "/workspaces/%ED%A0%80",
      params: { workspaceId: "\uD800" },
      search: {},
      actions: [],
    });

    expect(model.resources).toEqual([]);
  });

  test("the open field takes focus over its document", () => {
    const params = { workspaceId: WORKSPACE_ID, viewId: VIEW_ID };
    const derive = (search: Record<string, unknown>) =>
      deriveScreenModel({
        routeId: DOCUMENT_ROUTE,
        pathname: `/workspaces/${WORKSPACE_ID}/${VIEW_ID}/document`,
        params,
        search,
        actions: [],
      });

    expect(derive({ entity: ENTITY_ID }).focus).toBe(entity);
    expect(derive({ entity: ENTITY_ID, field: FIELD_ID }).focus).toBe(field);
    expect(derive({ entity: ENTITY_ID }).resources).toEqual([
      matter,
      view,
      entity,
    ]);
  });

  test("actions are listed once and their targets count as shown", () => {
    const create = {
      capability: "billing-codes.create",
      resource: matter,
    } satisfies ScreenAction;
    const update = {
      capability: "chat.threads.update",
      resource: entity,
    } satisfies ScreenAction;

    const model = deriveScreenModel({
      routeId: "/_protected/workspaces/$workspaceId/timesheets",
      pathname: `/workspaces/${WORKSPACE_ID}/timesheets`,
      params: { workspaceId: WORKSPACE_ID },
      search: {},
      actions: [create, create, update],
    });

    expect(model.actions).toEqual([create, update]);
    expect(model.resources).toEqual([matter, entity]);
  });
});
