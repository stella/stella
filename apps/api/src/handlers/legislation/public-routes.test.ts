import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

import { env } from "@/api/env";
import { publicLegislationRoute } from "@/api/handlers/legislation/public-routes";

const repoRoot = nodePath.resolve(import.meta.dir, "../../../../..");
const readHandlerSource = async (file: string) =>
  await Bun.file(
    nodePath.resolve(repoRoot, `apps/api/src/handlers/legislation/${file}`),
  ).text();

describe("public statute routes", () => {
  test("serves nothing while the public-law feature is off", async () => {
    const previousIsDev = env.isDev;
    const previousFeature = env.FEATURE_PUBLIC_LAW;
    env.isDev = false;
    env.FEATURE_PUBLIC_LAW = false;

    try {
      const response = await publicLegislationRoute.handle(
        new Request("http://localhost/law/statutes?country=CZE"),
      );

      expect(response.status).toBe(404);
    } finally {
      env.isDev = previousIsDev;
      env.FEATURE_PUBLIC_LAW = previousFeature;
    }
  });

  test("rejects a document id that is not a UUID before handler execution", async () => {
    const response = await publicLegislationRoute.handle(
      new Request("http://localhost/law/statutes/not-a-uuid"),
    );

    expect(response.status).toBe(422);
  });

  test("requires the country a statute listing is scoped to", async () => {
    const response = await publicLegislationRoute.handle(
      new Request("http://localhost/law/statutes"),
    );

    expect(response.status).toBe(422);
  });

  test("rejects a point-in-time read with no identifier", async () => {
    const response = await publicLegislationRoute.handle(
      new Request("http://localhost/law/statutes/by-eli"),
    );

    expect(response.status).toBe(422);
  });

  test("rejects an asOf that is not a calendar date", async () => {
    const response = await publicLegislationRoute.handle(
      new Request(
        "http://localhost/law/statutes/by-eli?eli=CZ%2F2012%2F89&asOf=yesterday",
      ),
    );

    expect(response.status).toBe(422);
  });

  test("rejects a provision-history anchor on a non-UUID document", async () => {
    const response = await publicLegislationRoute.handle(
      new Request(
        "http://localhost/law/statutes/not-a-uuid/provisions/p-1/history",
      ),
    );

    expect(response.status).toBe(422);
  });

  test("rejects a list cursor that is not a title/id pair", async () => {
    const response = await publicLegislationRoute.handle(
      new Request(
        "http://localhost/law/statutes?country=CZE&cursor=not-a-cursor",
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: "Invalid cursor" });
  });

  test("authenticated corpus reads use the shared public-law boundary", async () => {
    const [getSource, searchSource] = await Promise.all([
      readHandlerSource("get.ts"),
      readHandlerSource("search.ts"),
    ]);
    const getWrapper = getSource.slice(
      getSource.indexOf("const readLegislation = createSafeRootHandler"),
    );
    const searchWrapper = searchSource.slice(
      searchSource.indexOf("const searchLegislation = createSafeRootHandler"),
    );

    expect(getWrapper).toContain("readPublicLegislationHandler(");
    expect(getWrapper).toContain("legislationPublicReadDb");
    expect(getWrapper).not.toContain("scopedDb");
    expect(searchWrapper).toContain("searchLegislationHandler(");
    expect(searchWrapper).toContain("legislationPublicReadDb");
    expect(searchWrapper).not.toContain("scopedDb");
  });
});
