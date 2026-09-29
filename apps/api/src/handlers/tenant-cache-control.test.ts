import { describe, expect, test } from "bun:test";
import Elysia from "elysia";

import { catalogueRoute } from "@/api/handlers/catalogue/routes";
import { clausesRoute } from "@/api/handlers/clauses/routes";
import { playbooksRoute } from "@/api/handlers/playbooks/routes";
import { templatesRoute } from "@/api/handlers/templates/routes";

const app = new Elysia()
  .use(templatesRoute)
  .use(playbooksRoute)
  .use(catalogueRoute)
  .use(clausesRoute);

describe("tenant route cache policy", () => {
  test("keeps authentication failures from tenant routes out of caches", async () => {
    const paths = ["/templates/", "/playbooks/", "/catalogue/", "/clauses/"];

    for (const path of paths) {
      const response = await app.handle(new Request(`http://localhost${path}`));

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
  });
});
