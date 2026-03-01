const path = require("node:path");

/** @type {import('i18n-unused').Config} */
module.exports = {
  localesPath: path.join("apps/web/src/translations/locales"),
  srcPath: path.join("apps/web/src"),
  srcExtensions: ["ts", "tsx"],
  translationKeyMatcher:
    /(?<!\w)(?:t\(\s*["']([^"']+)["']|i18nKey=["']([^"']+)["'])/gi,
};
