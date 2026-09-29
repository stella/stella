/**
 * Article 1 of the Universal Declaration of Human Rights in the official
 * translations published by the UN Office of the High Commissioner for Human
 * Rights: real text in each language, freely reproducible, and the same
 * sentence everywhere, so no language is tested on easier material than
 * another. Slovenian Article 1 is written in ASCII letters only, so its
 * Article 3 follows it: a sample with nothing to mis-decode tests nothing.
 */
export const UDHR_ARTICLE_1 = {
  cs: "Všichni lidé rodí se svobodní a sobě rovní co do důstojnosti a práv. Jsou nadáni rozumem a svědomím a mají spolu jednat v duchu bratrství.",
  sk: "Všetci ľudia sa rodia slobodní a sú si rovní, čo sa týka ich dôstojnosti a práv. Sú obdarení rozumom a svedomím a majú spolu navzájom jednať v bratskom duchu.",
  pl: "Wszyscy ludzie rodzą się wolni i równi pod względem swej godności i swych praw. Są oni obdarzeni rozumem i sumieniem i powinni postępować wobec innych w duchu braterstwa.",
  hu: "Minden emberi lény szabadon születik és egyenlő méltósága és joga van. Az emberek, ésszel és lelkiismerettel bírván, egymással szemben testvéri szellemben kell hogy viseltessenek.",
  de: "Alle Menschen sind frei und gleich an Würde und Rechten geboren. Sie sind mit Vernunft und Gewissen begabt und sollen einander im Geist der Brüderlichkeit begegnen.",
  sl: "Vsi ljudje se rodijo svobodni in imajo enako dostojanstvo in enake pravice. Obdarjeni so z razumom in vestjo in bi morali ravnati drug z drugim kakor bratje. Vsakdo ima pravico do življenja, prostosti in osebne varnosti.",
  et: "Kõik inimesed sünnivad vabadena ja võrdsetena oma väärikuselt ja õigustelt. Neile on antud mõistus ja südametunnistus ja nende suhtumist üksteisesse peab kandma vendluse vaim.",
  lt: "Visi žmonės gimsta laisvi ir lygūs savo orumu ir teisėmis. Jiems suteiktas protas ir sąžinė ir jie turi elgtis vienas kito atžvilgiu kaip broliai.",
  lv: "Visi cilvēki piedzimst brīvi un vienlīdzīgi savā pašcieņā un tiesībās. Viņi ir apveltīti ar saprātu un sirdsapziņu, un viņiem jāizturas citam pret citu brālības garā.",
  fr: "Tous les êtres humains naissent libres et égaux en dignité et en droits. Ils sont doués de raison et de conscience et doivent agir les uns envers les autres dans un esprit de fraternité.",
  es: "Todos los seres humanos nacen libres e iguales en dignidad y derechos y, dotados como están de razón y conciencia, deben comportarse fraternalmente los unos con los otros.",
  pt: "Todos os seres humanos nascem livres e iguais em dignidade e em direitos. Dotados de razão e de consciência, devem agir uns para com os outros em espírito de fraternidade.",
} as const;

export type UdhrLanguage = keyof typeof UDHR_ARTICLE_1;
