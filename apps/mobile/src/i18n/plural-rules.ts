/**
 * Hermes, the app's JavaScript engine, has no `Intl.PluralRules`, and every
 * ICU plural ("{count, plural, one {# page} other {# pages}}") needs it.
 * Without it use-intl cannot format the message and shows its key instead,
 * so a scan's page count read "scan.pages". This installs the formatjs
 * implementation where the engine has none, with the rules of every UI
 * locale (`pt` also registers `pt-BR`, its default content).
 */
import "@formatjs/intl-pluralrules/polyfill.js";
import "@formatjs/intl-pluralrules/locale-data/ar.js";
import "@formatjs/intl-pluralrules/locale-data/cs.js";
import "@formatjs/intl-pluralrules/locale-data/de.js";
import "@formatjs/intl-pluralrules/locale-data/en.js";
import "@formatjs/intl-pluralrules/locale-data/es.js";
import "@formatjs/intl-pluralrules/locale-data/et.js";
import "@formatjs/intl-pluralrules/locale-data/fr.js";
import "@formatjs/intl-pluralrules/locale-data/hu.js";
import "@formatjs/intl-pluralrules/locale-data/lt.js";
import "@formatjs/intl-pluralrules/locale-data/lv.js";
import "@formatjs/intl-pluralrules/locale-data/pl.js";
import "@formatjs/intl-pluralrules/locale-data/pt.js";
import "@formatjs/intl-pluralrules/locale-data/sk.js";
