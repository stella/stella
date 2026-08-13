// Passive regression fixture for `no-raw-api-url/no-raw-api-url`.

declare const env: { VITE_API_URL: string };
declare const resourceId: string;
declare const apiUrl: (path: string) => string;

// oxlint-disable-next-line no-raw-api-url/no-raw-api-url -- fixture proves relative fetch URLs target the wrong origin
const rawFetch = fetch(`/api/resources/${resourceId}`);
// oxlint-disable-next-line no-raw-api-url/no-raw-api-url -- fixture proves Request constructors are guarded
const rawRequest = new Request("/v1/resources");
// oxlint-disable-next-line no-raw-api-url/no-direct-api-env, no-raw-api-url/no-raw-api-url -- fixture proves a hand-built configured API base is guarded
const rawUrl = new URL(`${env.VITE_API_URL}/v1/resources`);

const safeRequest = new Request(apiUrl(`/resources/${resourceId}`));
// oxlint-disable-next-line no-raw-api-url/no-direct-api-env -- fixture proves even an unversioned direct external-origin read is guarded
const healthUrl = new URL(`${env.VITE_API_URL}/health`);
// oxlint-disable-next-line typescript/dot-notation, no-raw-api-url/no-direct-api-env -- fixture proves bracket access cannot evade the deployment-boundary guard
const computedHealthUrl = new URL(`${env["VITE_API_URL"]}/health`);
const externalUrl = new URL("https://example.test/v1/resources");

export {
  computedHealthUrl,
  externalUrl,
  healthUrl,
  rawFetch,
  rawRequest,
  rawUrl,
  safeRequest,
};
