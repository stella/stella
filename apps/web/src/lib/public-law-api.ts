import { ClientOperationError } from "@/lib/errors";

type DisabledPublicLawData = {
  readonly error: "Not Found";
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isDisabledPublicLawData = (
  value: unknown,
): value is DisabledPublicLawData =>
  isRecord(value) && value["error"] === "Not Found";

export function assertPublicLawApiData<T>(
  data: T,
  action: string,
): asserts data is Exclude<T, DisabledPublicLawData> {
  if (!isDisabledPublicLawData(data)) {
    return;
  }

  throw new ClientOperationError({
    action,
    message: "Public law is not available.",
  });
}
