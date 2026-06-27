export type SelfHostConnectDeepLinkInput = {
  apiBaseUrl: string;
  webOrigin: string;
};

export const buildSelfHostConnectDeepLink = ({
  apiBaseUrl,
  webOrigin,
}: SelfHostConnectDeepLinkInput) => {
  const params = new URLSearchParams({
    apiBaseUrl,
    webOrigin,
  });
  return `stella://self-host/connect?${params.toString()}`;
};
