// Canonical list of ISO 639-1 living languages used across the stella
// monorepo. The list is frozen as a readonly tuple so derived literal types
// resolve to a string union, not just `string`.
//
// Each entry is keyed by its ISO 639-1 alpha-2 base code. A language the app
// ships UI translations for carries `uiAvailable: true` and a `uiLocale` tag,
// which is the exact tag the i18n message files are keyed by. The only place
// `uiLocale` diverges from `code` is Portuguese: the base code is `pt` but the
// shipped UI locale is the regional tag `pt-BR`.

export type Language = {
  /** ISO 639-1 alpha-2 base code. */
  readonly code: string;
  /** Name in English. */
  readonly englishName: string;
  /** Native name (autonym). */
  readonly endonym: string;
  /** True for the languages the app ships UI translations for. */
  readonly uiAvailable: boolean;
  /** The i18n message-file tag, present only when `uiAvailable`. Equals
   *  `code` except for Portuguese, where it is the regional tag `pt-BR`. */
  readonly uiLocale?: string;
};

export const LANGUAGES = [
  { code: "aa", englishName: "Afar", endonym: "Afar", uiAvailable: false },
  {
    code: "ab",
    englishName: "Abkhazian",
    endonym: "Аҧсуа",
    uiAvailable: false,
  },
  {
    code: "af",
    englishName: "Afrikaans",
    endonym: "Afrikaans",
    uiAvailable: false,
  },
  { code: "ak", englishName: "Akan", endonym: "Akan", uiAvailable: false },
  { code: "am", englishName: "Amharic", endonym: "አማርኛ", uiAvailable: false },
  { code: "ar", englishName: "Arabic", endonym: "العربية", uiAvailable: false },
  {
    code: "an",
    englishName: "Aragonese",
    endonym: "Aragonés",
    uiAvailable: false,
  },
  { code: "as", englishName: "Assamese", endonym: "অসমীয়া", uiAvailable: false },
  { code: "av", englishName: "Avaric", endonym: "Авар", uiAvailable: false },
  { code: "ae", englishName: "Avestan", endonym: "Avesta", uiAvailable: false },
  {
    code: "ay",
    englishName: "Aymara",
    endonym: "Aymar aru",
    uiAvailable: false,
  },
  {
    code: "az",
    englishName: "Azerbaijani",
    endonym: "Azərbaycan dili",
    uiAvailable: false,
  },
  {
    code: "ba",
    englishName: "Bashkir",
    endonym: "Башҡорт теле",
    uiAvailable: false,
  },
  {
    code: "bm",
    englishName: "Bambara",
    endonym: "Bamanankan",
    uiAvailable: false,
  },
  {
    code: "be",
    englishName: "Belarusian",
    endonym: "Беларуская",
    uiAvailable: false,
  },
  { code: "bn", englishName: "Bengali", endonym: "বাংলা", uiAvailable: false },
  {
    code: "bi",
    englishName: "Bislama",
    endonym: "Bislama",
    uiAvailable: false,
  },
  { code: "bo", englishName: "Tibetan", endonym: "བོད་ཡིག", uiAvailable: false },
  {
    code: "bs",
    englishName: "Bosnian",
    endonym: "Bosanski",
    uiAvailable: false,
  },
  {
    code: "br",
    englishName: "Breton",
    endonym: "Brezhoneg",
    uiAvailable: false,
  },
  {
    code: "bg",
    englishName: "Bulgarian",
    endonym: "Български",
    uiAvailable: false,
  },
  { code: "ca", englishName: "Catalan", endonym: "Català", uiAvailable: false },
  {
    code: "cs",
    englishName: "Czech",
    endonym: "Čeština",
    uiAvailable: true,
    uiLocale: "cs",
  },
  {
    code: "ch",
    englishName: "Chamorro",
    endonym: "Chamoru",
    uiAvailable: false,
  },
  {
    code: "ce",
    englishName: "Chechen",
    endonym: "Нохчийн мотт",
    uiAvailable: false,
  },
  {
    code: "cu",
    englishName: "Church Slavic",
    endonym: "Словѣ́ньскъ",
    uiAvailable: false,
  },
  {
    code: "cv",
    englishName: "Chuvash",
    endonym: "Чӑваш чӗлхи",
    uiAvailable: false,
  },
  {
    code: "kw",
    englishName: "Cornish",
    endonym: "Kernewek",
    uiAvailable: false,
  },
  { code: "co", englishName: "Corsican", endonym: "Corsu", uiAvailable: false },
  { code: "cr", englishName: "Cree", endonym: "ᓀᐦᐃᔭᐍᐏᐣ", uiAvailable: false },
  { code: "cy", englishName: "Welsh", endonym: "Cymraeg", uiAvailable: false },
  { code: "da", englishName: "Danish", endonym: "Dansk", uiAvailable: false },
  {
    code: "de",
    englishName: "German",
    endonym: "Deutsch",
    uiAvailable: true,
    uiLocale: "de",
  },
  { code: "dv", englishName: "Divehi", endonym: "ދިވެހި", uiAvailable: false },
  { code: "dz", englishName: "Dzongkha", endonym: "རྫོང་ཁ", uiAvailable: false },
  { code: "el", englishName: "Greek", endonym: "Ελληνικά", uiAvailable: false },
  {
    code: "en",
    englishName: "English",
    endonym: "English",
    uiAvailable: true,
    uiLocale: "en",
  },
  {
    code: "eo",
    englishName: "Esperanto",
    endonym: "Esperanto",
    uiAvailable: false,
  },
  {
    code: "et",
    englishName: "Estonian",
    endonym: "Eesti",
    uiAvailable: true,
    uiLocale: "et",
  },
  { code: "eu", englishName: "Basque", endonym: "Euskara", uiAvailable: false },
  { code: "ee", englishName: "Ewe", endonym: "Eʋegbe", uiAvailable: false },
  {
    code: "fo",
    englishName: "Faroese",
    endonym: "Føroyskt",
    uiAvailable: false,
  },
  { code: "fa", englishName: "Persian", endonym: "فارسی", uiAvailable: false },
  {
    code: "fj",
    englishName: "Fijian",
    endonym: "Vakaviti",
    uiAvailable: false,
  },
  { code: "fi", englishName: "Finnish", endonym: "Suomi", uiAvailable: false },
  {
    code: "fr",
    englishName: "French",
    endonym: "Français",
    uiAvailable: true,
    uiLocale: "fr",
  },
  {
    code: "fy",
    englishName: "Western Frisian",
    endonym: "Frysk",
    uiAvailable: false,
  },
  { code: "ff", englishName: "Fulah", endonym: "Fulfulde", uiAvailable: false },
  {
    code: "gd",
    englishName: "Gaelic",
    endonym: "Gàidhlig",
    uiAvailable: false,
  },
  { code: "ga", englishName: "Irish", endonym: "Gaeilge", uiAvailable: false },
  {
    code: "gl",
    englishName: "Galician",
    endonym: "Galego",
    uiAvailable: false,
  },
  { code: "gv", englishName: "Manx", endonym: "Gaelg", uiAvailable: false },
  {
    code: "gn",
    englishName: "Guarani",
    endonym: "Avañe'ẽ",
    uiAvailable: false,
  },
  {
    code: "gu",
    englishName: "Gujarati",
    endonym: "ગુજરાતી",
    uiAvailable: false,
  },
  {
    code: "ht",
    englishName: "Haitian",
    endonym: "Kreyòl ayisyen",
    uiAvailable: false,
  },
  { code: "ha", englishName: "Hausa", endonym: "Hausa", uiAvailable: false },
  { code: "he", englishName: "Hebrew", endonym: "עברית", uiAvailable: false },
  {
    code: "hz",
    englishName: "Herero",
    endonym: "Otjiherero",
    uiAvailable: false,
  },
  { code: "hi", englishName: "Hindi", endonym: "हिन्दी", uiAvailable: false },
  {
    code: "ho",
    englishName: "Hiri Motu",
    endonym: "Hiri Motu",
    uiAvailable: false,
  },
  {
    code: "hr",
    englishName: "Croatian",
    endonym: "Hrvatski",
    uiAvailable: false,
  },
  {
    code: "hu",
    englishName: "Hungarian",
    endonym: "Magyar",
    uiAvailable: true,
    uiLocale: "hu",
  },
  {
    code: "hy",
    englishName: "Armenian",
    endonym: "Հայերեն",
    uiAvailable: false,
  },
  { code: "ig", englishName: "Igbo", endonym: "Igbo", uiAvailable: false },
  { code: "io", englishName: "Ido", endonym: "Ido", uiAvailable: false },
  {
    code: "ii",
    englishName: "Sichuan Yi",
    endonym: "ꆈꌠꉙ",
    uiAvailable: false,
  },
  {
    code: "iu",
    englishName: "Inuktitut",
    endonym: "ᐃᓄᒃᑎᑐᑦ",
    uiAvailable: false,
  },
  {
    code: "ie",
    englishName: "Interlingue",
    endonym: "Interlingue",
    uiAvailable: false,
  },
  {
    code: "ia",
    englishName: "Interlingua",
    endonym: "Interlingua",
    uiAvailable: false,
  },
  {
    code: "id",
    englishName: "Indonesian",
    endonym: "Bahasa Indonesia",
    uiAvailable: false,
  },
  {
    code: "ik",
    englishName: "Inupiaq",
    endonym: "Iñupiaq",
    uiAvailable: false,
  },
  {
    code: "is",
    englishName: "Icelandic",
    endonym: "Íslenska",
    uiAvailable: false,
  },
  {
    code: "it",
    englishName: "Italian",
    endonym: "Italiano",
    uiAvailable: false,
  },
  {
    code: "jv",
    englishName: "Javanese",
    endonym: "Basa Jawa",
    uiAvailable: false,
  },
  {
    code: "ja",
    englishName: "Japanese",
    endonym: "日本語",
    uiAvailable: false,
  },
  {
    code: "kl",
    englishName: "Kalaallisut",
    endonym: "Kalaallisut",
    uiAvailable: false,
  },
  { code: "kn", englishName: "Kannada", endonym: "ಕನ್ನಡ", uiAvailable: false },
  { code: "ks", englishName: "Kashmiri", endonym: "कॉशुर", uiAvailable: false },
  {
    code: "ka",
    englishName: "Georgian",
    endonym: "ქართული",
    uiAvailable: false,
  },
  { code: "kr", englishName: "Kanuri", endonym: "Kanuri", uiAvailable: false },
  {
    code: "kk",
    englishName: "Kazakh",
    endonym: "Қазақ тілі",
    uiAvailable: false,
  },
  {
    code: "km",
    englishName: "Central Khmer",
    endonym: "ខ្មែរ",
    uiAvailable: false,
  },
  { code: "ki", englishName: "Kikuyu", endonym: "Gĩkũyũ", uiAvailable: false },
  {
    code: "rw",
    englishName: "Kinyarwanda",
    endonym: "Ikinyarwanda",
    uiAvailable: false,
  },
  {
    code: "ky",
    englishName: "Kirghiz",
    endonym: "Кыргызча",
    uiAvailable: false,
  },
  { code: "kv", englishName: "Komi", endonym: "Коми кыв", uiAvailable: false },
  { code: "kg", englishName: "Kongo", endonym: "Kikongo", uiAvailable: false },
  { code: "ko", englishName: "Korean", endonym: "한국어", uiAvailable: false },
  {
    code: "kj",
    englishName: "Kuanyama",
    endonym: "Kuanyama",
    uiAvailable: false,
  },
  { code: "ku", englishName: "Kurdish", endonym: "Kurdî", uiAvailable: false },
  { code: "lo", englishName: "Lao", endonym: "ລາວ", uiAvailable: false },
  { code: "la", englishName: "Latin", endonym: "Latina", uiAvailable: false },
  {
    code: "lv",
    englishName: "Latvian",
    endonym: "Latviešu",
    uiAvailable: true,
    uiLocale: "lv",
  },
  {
    code: "li",
    englishName: "Limburgan",
    endonym: "Limburgs",
    uiAvailable: false,
  },
  {
    code: "ln",
    englishName: "Lingala",
    endonym: "Lingála",
    uiAvailable: false,
  },
  {
    code: "lt",
    englishName: "Lithuanian",
    endonym: "Lietuvių",
    uiAvailable: true,
    uiLocale: "lt",
  },
  {
    code: "lb",
    englishName: "Luxembourgish",
    endonym: "Lëtzebuergesch",
    uiAvailable: false,
  },
  {
    code: "lu",
    englishName: "Luba-Katanga",
    endonym: "Tshiluba",
    uiAvailable: false,
  },
  { code: "lg", englishName: "Ganda", endonym: "Luganda", uiAvailable: false },
  {
    code: "mh",
    englishName: "Marshallese",
    endonym: "Kajin M̧ajeļ",
    uiAvailable: false,
  },
  {
    code: "ml",
    englishName: "Malayalam",
    endonym: "മലയാളം",
    uiAvailable: false,
  },
  { code: "mr", englishName: "Marathi", endonym: "मराठी", uiAvailable: false },
  {
    code: "mk",
    englishName: "Macedonian",
    endonym: "Македонски",
    uiAvailable: false,
  },
  {
    code: "mg",
    englishName: "Malagasy",
    endonym: "Malagasy",
    uiAvailable: false,
  },
  { code: "mt", englishName: "Maltese", endonym: "Malti", uiAvailable: false },
  {
    code: "mn",
    englishName: "Mongolian",
    endonym: "Монгол",
    uiAvailable: false,
  },
  {
    code: "mi",
    englishName: "Maori",
    endonym: "Te Reo Māori",
    uiAvailable: false,
  },
  {
    code: "ms",
    englishName: "Malay",
    endonym: "Bahasa Melayu",
    uiAvailable: false,
  },
  {
    code: "my",
    englishName: "Burmese",
    endonym: "မြန်မာစာ",
    uiAvailable: false,
  },
  {
    code: "na",
    englishName: "Nauru",
    endonym: "Dorerin Naoero",
    uiAvailable: false,
  },
  {
    code: "nv",
    englishName: "Navajo",
    endonym: "Diné bizaad",
    uiAvailable: false,
  },
  {
    code: "nr",
    englishName: "South Ndebele",
    endonym: "isiNdebele",
    uiAvailable: false,
  },
  {
    code: "nd",
    englishName: "North Ndebele",
    endonym: "isiNdebele",
    uiAvailable: false,
  },
  { code: "ng", englishName: "Ndonga", endonym: "Owambo", uiAvailable: false },
  { code: "ne", englishName: "Nepali", endonym: "नेपाली", uiAvailable: false },
  {
    code: "nl",
    englishName: "Dutch",
    endonym: "Nederlands",
    uiAvailable: false,
  },
  {
    code: "nn",
    englishName: "Norwegian Nynorsk",
    endonym: "Nynorsk",
    uiAvailable: false,
  },
  {
    code: "nb",
    englishName: "Norwegian Bokmål",
    endonym: "Bokmål",
    uiAvailable: false,
  },
  {
    code: "no",
    englishName: "Norwegian",
    endonym: "Norsk",
    uiAvailable: false,
  },
  {
    code: "ny",
    englishName: "Chichewa",
    endonym: "Chichewa",
    uiAvailable: false,
  },
  {
    code: "oc",
    englishName: "Occitan",
    endonym: "Occitan",
    uiAvailable: false,
  },
  {
    code: "oj",
    englishName: "Ojibwa",
    endonym: "ᐊᓂᔑᓈᐯᒧᐎᓐ",
    uiAvailable: false,
  },
  { code: "or", englishName: "Oriya", endonym: "ଓଡ଼ିଆ", uiAvailable: false },
  {
    code: "om",
    englishName: "Oromo",
    endonym: "Afaan Oromoo",
    uiAvailable: false,
  },
  { code: "os", englishName: "Ossetian", endonym: "Ирон", uiAvailable: false },
  { code: "pa", englishName: "Panjabi", endonym: "ਪੰਜਾਬੀ", uiAvailable: false },
  { code: "pi", englishName: "Pali", endonym: "पालि", uiAvailable: false },
  {
    code: "pl",
    englishName: "Polish",
    endonym: "Polski",
    uiAvailable: true,
    uiLocale: "pl",
  },
  {
    code: "pt",
    englishName: "Portuguese",
    endonym: "Português",
    uiAvailable: true,
    uiLocale: "pt-BR",
  },
  { code: "ps", englishName: "Pushto", endonym: "پښتو", uiAvailable: false },
  {
    code: "qu",
    englishName: "Quechua",
    endonym: "Runa Simi",
    uiAvailable: false,
  },
  {
    code: "rm",
    englishName: "Romansh",
    endonym: "Rumantsch",
    uiAvailable: false,
  },
  {
    code: "ro",
    englishName: "Romanian",
    endonym: "Română",
    uiAvailable: false,
  },
  { code: "rn", englishName: "Rundi", endonym: "Ikirundi", uiAvailable: false },
  {
    code: "ru",
    englishName: "Russian",
    endonym: "Русский",
    uiAvailable: false,
  },
  { code: "sg", englishName: "Sango", endonym: "Sängö", uiAvailable: false },
  { code: "sa", englishName: "Sanskrit", endonym: "संस्कृतम्", uiAvailable: false },
  { code: "si", englishName: "Sinhala", endonym: "සිංහල", uiAvailable: false },
  {
    code: "sk",
    englishName: "Slovak",
    endonym: "Slovenčina",
    uiAvailable: true,
    uiLocale: "sk",
  },
  {
    code: "sl",
    englishName: "Slovenian",
    endonym: "Slovenščina",
    uiAvailable: false,
  },
  {
    code: "se",
    englishName: "Northern Sami",
    endonym: "Davvisámegiella",
    uiAvailable: false,
  },
  {
    code: "sm",
    englishName: "Samoan",
    endonym: "Gagana Samoa",
    uiAvailable: false,
  },
  { code: "sn", englishName: "Shona", endonym: "ChiShona", uiAvailable: false },
  { code: "sd", englishName: "Sindhi", endonym: "سنڌي", uiAvailable: false },
  {
    code: "so",
    englishName: "Somali",
    endonym: "Soomaali",
    uiAvailable: false,
  },
  {
    code: "st",
    englishName: "Southern Sotho",
    endonym: "Sesotho",
    uiAvailable: false,
  },
  {
    code: "es",
    englishName: "Spanish",
    endonym: "Español",
    uiAvailable: true,
    uiLocale: "es",
  },
  { code: "sq", englishName: "Albanian", endonym: "Shqip", uiAvailable: false },
  {
    code: "sc",
    englishName: "Sardinian",
    endonym: "Sardu",
    uiAvailable: false,
  },
  { code: "sr", englishName: "Serbian", endonym: "Српски", uiAvailable: false },
  { code: "ss", englishName: "Swati", endonym: "SiSwati", uiAvailable: false },
  {
    code: "su",
    englishName: "Sundanese",
    endonym: "Basa Sunda",
    uiAvailable: false,
  },
  {
    code: "sw",
    englishName: "Swahili",
    endonym: "Kiswahili",
    uiAvailable: false,
  },
  {
    code: "sv",
    englishName: "Swedish",
    endonym: "Svenska",
    uiAvailable: false,
  },
  {
    code: "ty",
    englishName: "Tahitian",
    endonym: "Reo Tahiti",
    uiAvailable: false,
  },
  { code: "ta", englishName: "Tamil", endonym: "தமிழ்", uiAvailable: false },
  {
    code: "tt",
    englishName: "Tatar",
    endonym: "Татар теле",
    uiAvailable: false,
  },
  { code: "te", englishName: "Telugu", endonym: "తెలుగు", uiAvailable: false },
  { code: "tg", englishName: "Tajik", endonym: "Тоҷикӣ", uiAvailable: false },
  {
    code: "tl",
    englishName: "Tagalog",
    endonym: "Tagalog",
    uiAvailable: false,
  },
  { code: "th", englishName: "Thai", endonym: "ไทย", uiAvailable: false },
  { code: "ti", englishName: "Tigrinya", endonym: "ትግርኛ", uiAvailable: false },
  {
    code: "to",
    englishName: "Tonga",
    endonym: "Lea faka-Tonga",
    uiAvailable: false,
  },
  {
    code: "tn",
    englishName: "Tswana",
    endonym: "Setswana",
    uiAvailable: false,
  },
  {
    code: "ts",
    englishName: "Tsonga",
    endonym: "Xitsonga",
    uiAvailable: false,
  },
  {
    code: "tk",
    englishName: "Turkmen",
    endonym: "Türkmen",
    uiAvailable: false,
  },
  { code: "tr", englishName: "Turkish", endonym: "Türkçe", uiAvailable: false },
  { code: "tw", englishName: "Twi", endonym: "Twi", uiAvailable: false },
  {
    code: "ug",
    englishName: "Uighur",
    endonym: "ئۇيغۇرچە",
    uiAvailable: false,
  },
  {
    code: "uk",
    englishName: "Ukrainian",
    endonym: "Українська",
    uiAvailable: false,
  },
  { code: "ur", englishName: "Urdu", endonym: "اردو", uiAvailable: false },
  { code: "uz", englishName: "Uzbek", endonym: "Oʻzbek", uiAvailable: false },
  {
    code: "ve",
    englishName: "Venda",
    endonym: "Tshivenḓa",
    uiAvailable: false,
  },
  {
    code: "vi",
    englishName: "Vietnamese",
    endonym: "Tiếng Việt",
    uiAvailable: false,
  },
  {
    code: "vo",
    englishName: "Volapük",
    endonym: "Volapük",
    uiAvailable: false,
  },
  { code: "wa", englishName: "Walloon", endonym: "Walon", uiAvailable: false },
  { code: "wo", englishName: "Wolof", endonym: "Wolof", uiAvailable: false },
  { code: "xh", englishName: "Xhosa", endonym: "isiXhosa", uiAvailable: false },
  { code: "yi", englishName: "Yiddish", endonym: "ייִדיש", uiAvailable: false },
  { code: "yo", englishName: "Yoruba", endonym: "Yorùbá", uiAvailable: false },
  {
    code: "za",
    englishName: "Zhuang",
    endonym: "Saɯ cueŋƅ",
    uiAvailable: false,
  },
  { code: "zh", englishName: "Chinese", endonym: "中文", uiAvailable: false },
  { code: "zu", englishName: "Zulu", endonym: "isiZulu", uiAvailable: false },
] as const;

// Compile-time conformance check: every entry matches `Language`. Kept off the
// `LANGUAGES` declaration itself so `isolatedDeclarations` can emit its type
// from the literal (a `satisfies` clause there would require an explicit
// annotation and erase the literal narrowing the derived types depend on).
const _languagesConform: readonly Language[] = LANGUAGES;
void _languagesConform;

/** A single canonical-list entry, narrowed to literal values. */
export type LanguageEntry = (typeof LANGUAGES)[number];

/** ISO 639-1 base code, e.g. `"en"`, `"cs"`, `"pt"`. */
export type LanguageCode = LanguageEntry["code"];

const LANGUAGE_CODE_SET: ReadonlySet<string> = new Set(
  LANGUAGES.map((language) => language.code),
);

export const isLanguageCode = (value: unknown): value is LanguageCode =>
  typeof value === "string" && LANGUAGE_CODE_SET.has(value);

/** Entries the app ships UI translations for, narrowed to literal values. */
type UiLanguageEntry = Extract<LanguageEntry, { uiAvailable: true }>;

/** The subset of {@link LANGUAGES} the app ships UI translations for. */
export const UI_LANGUAGES: readonly UiLanguageEntry[] = LANGUAGES.filter(
  (language): language is UiLanguageEntry => language.uiAvailable,
);

/** An i18n message-file tag (the regional `pt-BR`, otherwise a base code). */
export type UiLocale = NonNullable<UiLanguageEntry["uiLocale"]>;

/** The exact i18n message-file tags, in the same order as `UI_LANGUAGES`
 *  (e.g. `"en"`, `"cs"`, …, `"pt-BR"`, `"sk"`). Portuguese contributes the
 *  regional tag `pt-BR`, not the base code `pt`. The `uiAvailable` subtype
 *  guarantees `uiLocale` is present, so the mapping needs no fallback. */
export const UI_LOCALES: readonly UiLocale[] = UI_LANGUAGES.map(
  (language) => language.uiLocale,
);
