import { withExceptionScope } from "./exception-scope";

export const exceptionOwnerScopeContracts = () => {
  // @ts-expect-error Every owner must provide an execution scope.
  withExceptionScope(undefined, () => undefined);
  // @ts-expect-error An ingestion scope must identify its adapter.
  withExceptionScope({ type: "ingestion" }, () => undefined);
  // @ts-expect-error A scheduled job scope must identify the persisted job definition.
  withExceptionScope({ type: "job", task: "repair" }, () => undefined);
  withExceptionScope(
    { type: "ingestion", adapterKey: "cz-ns" },
    () => undefined,
  );
  withExceptionScope(
    { type: "job", jobId: "nightly", task: "repair" },
    () => undefined,
  );
};
