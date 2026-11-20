import * as v from "valibot";

import {
  EMAIL_DELIVERY_STATUS_FIELD,
  emailCodeRequestResponseSchema,
  type EmailDeliveryStatus,
} from "@stll/api-contract/email-delivery";

/**
 * What a code request's response says about mail to the requested address.
 * `undefined` means the server sent no status (one released before the
 * field), which the sign-in screen treats like `unknown`.
 */
export const readEmailDeliveryStatus = (
  data: unknown,
): EmailDeliveryStatus | undefined => {
  const parsed = v.safeParse(emailCodeRequestResponseSchema, data);
  return parsed.success
    ? parsed.output[EMAIL_DELIVERY_STATUS_FIELD]
    : undefined;
};

/** The domain part of an address, as a recipient's mail server serves it. */
export const emailDomain = (email: string): string =>
  email.slice(email.lastIndexOf("@") + 1);
