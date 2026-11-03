/**
 * The web page where a person manages their account, deletion included, on
 * the site that signed them in: the sign-in issuer's origin, where the web
 * app is served. The app opens it rather than deleting the account itself,
 * as an app's token never reaches account control.
 */
export const accountPageUrl = (issuer: string): string =>
  new URL("/settings/account/profile", issuer).href;
