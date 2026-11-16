// parser-output-unchanged: defines telemetry execution scope identities only; parsed values are unchanged.
import { panic } from "better-result";

export type RequestExceptionScope = {
  readonly type: "request";
  readonly method: string;
  readonly routeTemplate: string;
};

export type HandlerExceptionScope = {
  readonly type: "handler";
  readonly handlerId: string;
};

export type JobExceptionScope = {
  readonly type: "job";
  readonly jobId: string;
  readonly task: string;
};

export type IngestionExceptionScope = {
  readonly type: "ingestion";
  readonly adapterKey: string;
};

export type ExceptionScope =
  | RequestExceptionScope
  | HandlerExceptionScope
  | JobExceptionScope
  | IngestionExceptionScope;

/** Fixed field order keeps scope identity independent of object construction. */
export const exceptionScopeIdentity = (scope: ExceptionScope): string => {
  switch (scope.type) {
    case "request":
      return JSON.stringify([scope.type, scope.method, scope.routeTemplate]);
    case "handler":
      return JSON.stringify([scope.type, scope.handlerId]);
    case "job":
      return JSON.stringify([scope.type, scope.jobId, scope.task]);
    case "ingestion":
      return JSON.stringify([scope.type, scope.adapterKey]);
    default:
      scope satisfies never;
      return panic("Unhandled exception scope");
  }
};
