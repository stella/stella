import type { ValidateFunction } from "ajv";
import { Result } from "better-result";
import { ElysiaCustomStatusResponse, StatusMap } from "elysia";

import { resolveResponseStatus } from "@/api/lib/observability/response-status";
import {
  ResponseConformanceError,
  rethrowResponseConformanceError,
} from "@/api/lib/response-conformance-error";
import { setResponseConformanceObserver } from "@/api/lib/response-conformance-observer";
import { setMcpResponseConformanceObserver } from "@/api/mcp/response-conformance-observer";

import { recordResponseConformanceExecution } from "./response-conformance-execution-collector";
import {
  getResponseConformanceRequestModels,
  recordResponseConformanceFailure,
} from "./response-conformance-request-errors";
import {
  assertHttpResponseConformance,
  assertResponseConformance,
} from "./response-conformance-validation";
import {
  compileWireSchema,
  createWireSchemaValidator,
} from "./wire-json-schema-validator";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const conformanceFailure = (
  route: string,
  status: number | "success",
  issuePath: string,
) =>
  new ResponseConformanceError({
    route,
    status,
    issuePath,
    message: `Response conformance failed: ${route} status ${status} at ${issuePath}`,
  });

/** Installs lightweight observers without importing the server or handler graph. */
export const installHandlerMcpResponseConformance = (): (() => void) => {
  const validator = createWireSchemaValidator();
  const compiled = new WeakMap<object, ValidateFunction>();
  const restoreMcp = setMcpResponseConformanceObserver(
    ({ toolName, schema, result, issuePaths }) => {
      recordResponseConformanceExecution("mcp", toolName);
      const route = `MCP ${toolName}`;
      const issuePath = issuePaths.at(0);
      if (issuePath !== undefined) {
        throw conformanceFailure(route, "success", issuePath);
      }
      const serialized = Result.try(() => {
        const json: unknown = Reflect.apply(JSON.stringify, JSON, [result]);
        if (typeof json !== "string") {
          throw conformanceFailure(route, "success", "(body)");
        }
        const value: unknown = JSON.parse(json);
        return value;
      });
      if (Result.isError(serialized)) {
        throw conformanceFailure(route, "success", "(body)");
      }
      const checked = Result.try(() => {
        let validate = compiled.get(schema);
        if (validate === undefined) {
          validate = compileWireSchema(validator, schema);
          compiled.set(schema, validate);
        }
        if (validate(serialized.value)) {
          return undefined;
        }
        return validate.errors?.at(0)?.instancePath || "(root)";
      });
      if (Result.isError(checked)) {
        throw conformanceFailure(route, "success", "(schema)");
      }
      if (checked.value !== undefined) {
        throw conformanceFailure(route, "success", checked.value);
      }
    },
  );

  const restoreHandler = setResponseConformanceObserver(
    async ({ config, context, result }) => {
      const ctx = isRecord(context) ? context : undefined;
      const request = ctx?.["request"];
      const models =
        request instanceof Request
          ? getResponseConformanceRequestModels(request)
          : undefined;
      const method = request instanceof Request ? request.method : "GET";
      const route =
        typeof ctx?.["route"] === "string" ? ctx["route"] : "(direct handler)";
      if (!(request instanceof Request)) {
        recordResponseConformanceExecution("handler-context", route);
      }
      if (config.response === undefined || config.response === null) {
        return;
      }
      const set = ctx?.["set"];
      const rawStatus = isRecord(set) ? set["status"] : undefined;
      const selectedStatus =
        typeof rawStatus === "number"
          ? rawStatus
          : Object.entries(StatusMap)
              .find(([name]) => name === rawStatus)
              ?.at(1);
      const status = resolveResponseStatus({
        response: result,
        set: {
          headers: {},
          status: typeof selectedStatus === "number" ? selectedStatus : 200,
        },
      });
      let value = result;
      while (value instanceof ElysiaCustomStatusResponse) {
        value = value.response;
      }
      const checked = await Result.tryPromise(async () => {
        if (method === "HEAD" || status === 204 || status === 304) {
          await assertHttpResponseConformance({
            route,
            response: new Response(null, { status }),
            method,
            schema: config.response,
            models,
          });
          return;
        }
        if (value instanceof Response) {
          const clone = value.clone();
          const response =
            clone.status === status
              ? clone
              : new Response(clone.body, {
                  headers: clone.headers,
                  status,
                });
          await assertHttpResponseConformance({
            route,
            response,
            method,
            schema: config.response,
            models,
          });
          return;
        }
        const binary =
          value instanceof Blob ||
          value instanceof ArrayBuffer ||
          ArrayBuffer.isView(value) ||
          value instanceof ReadableStream;
        const serialized = Result.try(() => {
          const json = binary ? undefined : JSON.stringify(value);
          const wireValue: unknown =
            json === undefined ? value : JSON.parse(json);
          return wireValue;
        });
        if (Result.isError(serialized)) {
          throw conformanceFailure(route, status, "(body)");
        }
        await assertResponseConformance({
          route,
          status,
          schema: config.response,
          value: serialized.value,
          models,
        });
      });
      if (Result.isError(checked)) {
        if (request instanceof Request) {
          recordResponseConformanceFailure(request, checked.error);
        }
        rethrowResponseConformanceError(checked.error);
        throw checked.error;
      }
    },
  );
  return () => {
    restoreHandler();
    restoreMcp();
  };
};
