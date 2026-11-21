declare const response: Response;

// expect-clean: no-fetch-response-body-replacement/no-fetch-response-body-replacement
export const preserveUnderlyingResponse = () => response;

// oxlint-disable-next-line no-fetch-response-body-replacement/no-fetch-response-body-replacement -- fixture proves replacement Responses are rejected
export const replaceResponse = () => new Response("replacement");

// oxlint-disable-next-line no-fetch-response-body-replacement/no-fetch-response-body-replacement -- fixture proves script streams are rejected
export const replaceBody = () => new ReadableStream();
