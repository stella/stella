// Passive regression fixture for
// `no-raw-cloudfront-viewer-header/no-raw-cloudfront-viewer-header`.

const request = new Request("https://api.example.test/");

// oxlint-disable-next-line no-raw-cloudfront-viewer-header/no-raw-cloudfront-viewer-header -- viewer headers are read through their owner
const country = request.headers.get("cloudfront-viewer-country");

// oxlint-disable-next-line no-raw-cloudfront-viewer-header/no-raw-cloudfront-viewer-header -- the check ignores case
const city = request.headers.get("CloudFront-Viewer-City");

const field = "latitude";
// oxlint-disable-next-line no-raw-cloudfront-viewer-header/no-raw-cloudfront-viewer-header -- an interpolated name is still raw
const latitude = request.headers.get(`cloudfront-viewer-${field}`);

// expect-clean: no-raw-cloudfront-viewer-header/no-raw-cloudfront-viewer-header
const forwarded = request.headers.get("x-forwarded-for");
const prose = "the CloudFront viewer country";

export const cloudFrontViewerHeaderFixture = [
  country,
  city,
  latitude,
  forwarded,
  prose,
];
