import { panic } from "better-result";
import { AsyncLocalStorage } from "node:async_hooks";

import {
  buildContentSecurityPolicy,
  type ContentSecurityPolicyEnvironment,
  createContentSecurityPolicyNonce,
} from "./content-security-policy";

const requestNonce = new AsyncLocalStorage<string>();

export const getRequestNonce = (): string =>
  requestNonce.getStore() ?? panic("SSR requires a request CSP nonce");

type WithContentSecurityPolicyOptions = {
  environment: ContentSecurityPolicyEnvironment;
  fetchResponse: () => Promise<Response>;
};

export const withContentSecurityPolicy = async ({
  environment,
  fetchResponse,
}: WithContentSecurityPolicyOptions): Promise<Response> => {
  const nonce = createContentSecurityPolicyNonce();
  return await requestNonce.run(nonce, async () => {
    const response = await fetchResponse();
    if (
      response.headers
        .get("Content-Type")
        ?.split(";")
        .at(0)
        ?.trim()
        .toLowerCase() !== "text/html"
    ) {
      return response;
    }
    const headers = new Headers(response.headers);
    headers.set(
      "Content-Security-Policy",
      buildContentSecurityPolicy(nonce, environment),
    );
    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  });
};
