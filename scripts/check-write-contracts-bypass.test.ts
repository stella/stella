import { describe, expect, test } from "bun:test";

import {
  checkWriteContracts,
  enumerateWriteContracts,
} from "./check-write-contracts";

const handler = "apps/api/src/handlers/example/update.ts";
const check = (before: string, imports = "") => {
  const sources = new Map([
    [
      "apps/api/src/server.ts",
      'import { routes } from "@/api/handlers/example/routes"; new Elysia().use(routes);',
    ],
    [
      "apps/api/src/handlers/example/routes.ts",
      'import update from "./update"; export const routes = new Elysia().post("/existing", update.handler);',
    ],
    [
      handler,
      `
      import { createSafeHandler } from '@/api/lib/api-handlers';
      import { enforceWritePrecondition } from '@/api/lib/write-contract';
      import { Result } from 'better-result';
      import { HandlerError } from '@/api/lib/errors/tagged-errors';
      ${imports}
      export default createSafeHandler({
        contract: 'replace', precondition: {type: 'updatedAt', field: 'expectedUpdatedAt'},
      }, async function* ({body}) {
        ${before}
        const conflict = enforceWritePrecondition({type: 'updatedAt', field: 'expectedUpdatedAt'});
        if (conflict) return conflict;
        return {};
      });`,
    ],
  ]);
  const registrations = enumerateWriteContracts((file) => sources.get(file));
  expect(registrations).toHaveLength(1);
  return checkWriteContracts({
    registrations,
    baseline: [],
    previous: [],
    previousRegistrations: [],
  });
};

describe("a later comparison cannot cover a prior successful exit", () => {
  for (const before of [
    "if (body.skipCheck) return replace();",
    "if (body.skipCheck) { return Result.ok(replace()); }",
    "if (body.skipCheck) return;",
    "{ if (body.skipCheck) return replace(); }",
    "switch (body.mode) { case 'skip': return replace(); }",
    "for (const item of body.items) { if (item.skip) return replace(); }",
    "try { if (body.skipCheck) return replace(); } catch {}",
    "try { replace(); } catch { return {}; }",
    "try { replace(); } finally { if (body.skipCheck) return {}; }",
    "if (body.skipCheck) { const conflict = {}; return conflict; }",
    "if (body.skipCheck) { const Result = {err: () => ({})}; return Result.err(); }",
    "try { replace(); } catch (Result) { return Result.err(); }",
  ]) {
    test(`rejects bypass: ${before}`, () => {
      expect(check(before)).toContainEqual(
        expect.stringContaining("Replacement must reach owner enforcement"),
      );
    });
  }

  for (const before of [
    "if (!body.visible) return Result.err(new HandlerError({status: 404, message: 'Missing'}));",
    "if (!body.visible) return yield* Result.err(new HandlerError({status: 404, message: 'Missing'}));",
    "if (!body.visible) return await Result.err(new HandlerError({status: 404, message: 'Missing'}));",
    "if (!body.visible) return new HandlerError({status: 404, message: 'Missing'});",
    "if (body.invalid || !body.visible) { return Result.err(new HandlerError({status: 400, message: 'Invalid'})); }",
    "const prior = enforceWritePrecondition({type: 'updatedAt', field: 'expectedUpdatedAt'}); if (prior) return prior;",
    "const missing = new HandlerError({status: 404, message: 'Missing'}); if (!body.visible) return missing;",
    "const unrelated = () => { if (body.skipCheck) return replace(); };",
    "function unrelated() { if (body.skipCheck) return replace(); }",
  ]) {
    test(`preserves refusal or uninvoked function: ${before}`, () => {
      expect(check(before)).toEqual([]);
    });
  }

  test("lookalike refusal imports cannot authorize a bypass", () => {
    expect(
      check(
        "if (body.skipCheck) return FakeResult.err();",
        "import {Result as FakeResult} from './lookalike';",
      ),
    ).toContainEqual(
      expect.stringContaining("Replacement must reach owner enforcement"),
    );
    expect(
      check(
        "if (body.skipCheck) return new FakeError();",
        "import {HandlerError as FakeError} from './lookalike';",
      ),
    ).toContainEqual(
      expect.stringContaining("Replacement must reach owner enforcement"),
    );
  });
});
