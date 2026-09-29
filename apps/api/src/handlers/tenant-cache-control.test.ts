import { describe, expect, test } from "bun:test";
import Elysia from "elysia";

import { env } from "@/api/env";
import { catalogueRoute } from "@/api/handlers/catalogue/routes";
import { clausesRoute } from "@/api/handlers/clauses/routes";
import { playbooksRoute } from "@/api/handlers/playbooks/routes";
import { publicKnowledgeRoute } from "@/api/handlers/public-knowledge/routes";
import { templatesRoute } from "@/api/handlers/templates/routes";

const app = new Elysia()
  .use(templatesRoute)
  .use(playbooksRoute)
  .use(catalogueRoute)
  .use(clausesRoute)
  .use(publicKnowledgeRoute);

describe("tenant route cache policy", () => {
  test("keeps authentication failures from tenant routes out of caches", async () => {
    const paths = ["/templates/", "/playbooks/", "/catalogue/", "/clauses/"];

    for (const path of paths) {
      const response = await app.handle(new Request(`http://localhost${path}`));

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
  });

  test("the public route keeps its shared cache policy when mounted with tenant routes", async () => {
    const previous = env.FEATURE_PUBLIC_KNOWLEDGE;
    env.FEATURE_PUBLIC_KNOWLEDGE = true;
    try {
      const response = await app.handle(
        new Request("http://localhost/public/knowledge/playbook-starters"),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
    } finally {
      env.FEATURE_PUBLIC_KNOWLEDGE = previous;
    }
  });
});
