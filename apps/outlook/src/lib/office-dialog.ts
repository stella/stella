import { SignInError } from "@/lib/oauth/errors";
import {
  getOfficeDialogApi,
  getOfficeRuntime,
  supportsOfficeRequirement,
} from "@/lib/office";
import type { OpenSignInDialog } from "@/lib/outlook-auth";

/** Office's code for a dialog the person closed. */
const DIALOG_CLOSED_BY_USER = 12_006;

const DIALOG_SIZE = { height: 60, width: 40 } as const;

/**
 * Opens the sign-in dialog and settles with its first message. The dialog
 * is closed as soon as it answers or fails. DialogOrigin 1.1 is required so
 * Office reports the sender origin and the callback page can name its target
 * origin.
 */
export const openOfficeSignInDialog: OpenSignInDialog = async ({
  promptBeforeOpen,
  startUrl,
}) =>
  await new Promise((resolve, reject) => {
    const office = getOfficeRuntime();
    const ui = getOfficeDialogApi();
    if (!office || !ui) {
      reject(
        new SignInError({
          message: "Sign-in dialogs are available only inside Outlook",
          failure: "unsupported",
        }),
      );
      return;
    }
    if (
      !supportsOfficeRequirement({
        name: "DialogOrigin",
        requirements: office.context.requirements,
        version: "1.1",
      })
    ) {
      reject(
        new SignInError({
          message: "This Outlook host cannot open a secure sign-in dialog",
          failure: "unsupported",
        }),
      );
      return;
    }

    ui.displayDialogAsync(
      startUrl,
      { ...DIALOG_SIZE, promptBeforeOpen },
      (result) => {
        if (result.status !== office.AsyncResultStatus.Succeeded) {
          reject(
            new SignInError({
              message: result.error.message,
              failure: "unavailable",
            }),
          );
          return;
        }
        const dialog = result.value;
        dialog.addEventHandler(
          office.EventType.DialogMessageReceived,
          (event) => {
            if (!("message" in event)) {
              return;
            }
            dialog.close();
            resolve({ message: event.message, origin: event.origin });
          },
        );
        dialog.addEventHandler(
          office.EventType.DialogEventReceived,
          (event) => {
            if (!("error" in event)) {
              return;
            }
            dialog.close();
            reject(
              new SignInError({
                message: `Sign-in dialog closed (code ${event.error})`,
                failure:
                  event.error === DIALOG_CLOSED_BY_USER
                    ? "cancelled"
                    : "unavailable",
              }),
            );
          },
        );
      },
    );
  });
