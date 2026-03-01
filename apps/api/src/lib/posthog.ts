import { PostHog } from "posthog-node";

import { env } from "@/api/env";

let posthogClient: PostHog | null = null;

export const getPostHog = () => {
  if (!posthogClient) {
    posthogClient = new PostHog(env.POSTHOG_KEY, {
      host: env.POSTHOG_HOST,
    });
  }

  return posthogClient;
};

type PosthogIdentifyProps = {
  distinctId: string;
  properties: {
    active_organization_id: string;
  };
};

export const posthogIdentify = ({
  distinctId,
  properties,
}: PosthogIdentifyProps) => {
  const posthog = getPostHog();

  posthog.identify({
    distinctId,
    properties,
  });
};

export const captureError = (error: unknown) => {
  const posthog = getPostHog();

  // biome-ignore lint/suspicious/noConsole: log error
  console.log(error);

  posthog.captureException(error);
};
