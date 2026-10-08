import type { Transaction } from "@/api/db/root";
import {
  maybeStartUploadTriggeredFlows as dispatchRecordedUpload,
  recordUploadTriggeredFlowIntents as recordUpload,
} from "@/api/lib/flows/maybe-start-upload-triggered-flows";
import type { MaybeStartUploadTriggeredFlowsArgs } from "@/api/lib/flows/maybe-start-upload-triggered-flows";

/** The upload transaction records delivery intent without exposing flow data. */
export const recordUploadTriggeredFlowIntents = async (
  tx: Pick<Transaction, "select" | "insert">,
  options: MaybeStartUploadTriggeredFlowsArgs,
): Promise<void> => {
  await recordUpload(tx, options);
};

/** Recovery admission owns execution; the upload receives no feature result. */
export const maybeStartUploadTriggeredFlows = async (
  options: MaybeStartUploadTriggeredFlowsArgs,
): Promise<void> => {
  await dispatchRecordedUpload(options);
};
