import { Value } from "@sinclair/typebox/value";
import { expect, test } from "bun:test";
import { Elysia, t } from "elysia";

import { searchDecisionsResponseSchema } from "@/api/handlers/case-law/decisions/search-schema";
import { publicSanctionsResponseSchema } from "@/api/handlers/sanctions/search-response";
import {
  elysiaErrorAnswer,
  elysiaErrorBody,
} from "@/api/lib/errors/elysia-error";

const app = new Elysia()
  .onError(({ code, error, set }) => {
    const answer = elysiaErrorAnswer(code, error);
    set.status = answer.status;
    return elysiaErrorBody(answer);
  })
  .post("/validate", () => "ok", {
    body: t.Object({ name: t.String({ minLength: 2, maxLength: 8 }) }),
  });

test.each([{}, { name: "" }, { name: "too long a name" }, { name: 1 }])(
  "public search schemas accept produced validation issues for %j",
  async (body) => {
    const response = await app.handle(
      new Request("http://localhost/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(422);
    const answer = await response.json();
    expect(answer).toHaveProperty("issues.0.field", "name");
    for (const schema of [
      publicSanctionsResponseSchema,
      searchDecisionsResponseSchema,
    ]) {
      expect(Value.Check(schema[422], answer)).toBe(true);
    }
  },
);
