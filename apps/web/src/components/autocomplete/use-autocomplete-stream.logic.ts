type RequestAutocompleteStreamOptions = {
  controller: AbortController;
  dispatchStart: () => boolean;
  fetchResponse: () => Promise<Response>;
};

export const requestAutocompleteStream = async ({
  controller,
  dispatchStart,
  fetchResponse,
}: RequestAutocompleteStreamOptions) => {
  if (!dispatchStart()) {
    controller.abort();
    return null;
  }
  return await fetchResponse();
};
