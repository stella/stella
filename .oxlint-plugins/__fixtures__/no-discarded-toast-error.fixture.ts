import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { notifyUserError } from "@/lib/errors/user-toast";

export const discarded = (error: unknown) => {
  // oxlint-disable-next-line no-discarded-toast-error/no-discarded-toast-error -- fixture proves flattening loses typed error identity
  notifyUserError(userErrorFromThrown(error, "Failed"), "Failed");
  // expect-clean: no-discarded-toast-error/no-discarded-toast-error
  notifyUserError(error, "Failed");
};

export const callbacks = {
  onError: () => {
    // oxlint-disable-next-line no-discarded-toast-error/no-discarded-toast-error -- fixture proves error callbacks must preserve their error
    notifyUserError(undefined, "Failed");
  },
};

const extractedOnError = () => {
  // oxlint-disable-next-line no-discarded-toast-error/no-discarded-toast-error -- fixture proves extracted mutation callbacks preserve their error
  notifyUserError(undefined, "Failed");
};
export const extractedCallbacks = { onError: extractedOnError };

const extractedRejection = () => {
  // oxlint-disable-next-line no-discarded-toast-error/no-discarded-toast-error -- fixture proves extracted rejection callbacks preserve their error
  notifyUserError(undefined, "Failed");
};
export const catchExtractedRejection = (promise: Promise<unknown>) =>
  promise.catch(extractedRejection);

const preserveError = (error: unknown) => {
  // expect-clean: no-discarded-toast-error/no-discarded-toast-error
  notifyUserError(error, "Failed");
};
export const preservedCallbacks = { onError: preserveError };
export const catchPreservedRejection = (promise: Promise<unknown>) =>
  promise.catch(preserveError);
