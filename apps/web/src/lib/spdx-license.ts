/** Canonical SPDX license landing page for a license identifier. */
export const spdxLicenseUrl = (license: string): string =>
  `https://spdx.org/licenses/${encodeURIComponent(license)}.html`;
