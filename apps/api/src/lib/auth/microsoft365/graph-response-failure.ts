export const graphResponseFailureReason = (status: number) => {
  if (status >= 500 || status === 429) {
    return "upstream_unavailable";
  }
  if (status === 401 || status === 403) {
    return "provider_credentials_rejected";
  }
  return "provider_request_rejected";
};
