// The Czech marketing firm, Hartvich & Partneři (Praha): a Czech cast, Czech
// matters under Czech law, and the Czech fixture AI output the cs captures
// film. The document bodies and emails live in ./cs-documents; this file holds
// everything else the pack supplies.
import { MARKETING_LOCALE_MARKERS } from "@stll/playwright-tools/marketing-locales";

import { seedId } from "../seed-utils";
import {
  CS_DOCUMENT_TEXTS,
  CS_EMAILS,
  CS_MATTER_DOCUMENTS,
  CS_SPA_DOCUMENT_NAME,
} from "./cs-documents";
import {
  supplierAgreementBody as body,
  supplierAgreementHeading as heading,
} from "./types";
import type { SeedLocaleContent, SupplierAgreementParagraph } from "./types";

const MARKERS = MARKETING_LOCALE_MARKERS.cs;

// Reviewer identity stamped on the tracked changes and margin comments;
// Klára Nováková is the third seeded colleague (klara.novakova@stella.dev).
const SUPPLIER_AGREEMENT_REVIEWER = {
  author: "Klára Nováková",
  date: "2026-07-16T09:30:00Z",
  initials: "KN",
};

const SUPPLIER_AGREEMENT_COMMENTS = [
  {
    id: 1,
    text:
      "Nad schváleným limitem odpovědnosti: Playbook nákupních smluv " +
      "připouští nejvýše 100 % ročního objemu plnění. Upraveno na pozici " +
      "playbooku; vyžaduje schválení odpovědným partnerem.",
  },
  {
    id: 2,
    text:
      "Playbook nákupních smluv vyžaduje u smluv kritických pro dodávky " +
      "výpovědní dobu nejméně devadesát (90) dnů. Druhá odchylka; předávám " +
      "partnerovi k posouzení.",
  },
];

const SUPPLIER_AGREEMENT_PARAGRAPHS: readonly SupplierAgreementParagraph[] = [
  { runs: [{ kind: "text", text: "Smlouva o dodávkách" }], style: "title" },
  body("PRACOVNÍ VERZE v4 — OBSAHUJE SLEDOVANÉ ZMĚNY"),
  body(
    "Tuto rámcovou kupní smlouvu o dodávkách (dále jen „smlouva“) uzavírají " +
      "podle § 1746 odst. 2 a § 2079 a násl. zákona č. 89/2012 Sb., " +
      "občanský zákoník (dále jen „občanský zákoník“), ke dni 1. 7. 2026 " +
      "(dále jen „den účinnosti“) tyto smluvní strany:",
  ),
  body(
    "(1) Severka Robotics a.s., IČO 08417265, se sídlem Purkyňova 2875/107, " +
      "612 00 Brno, zapsaná v obchodním rejstříku vedeném Krajským soudem " +
      "v Brně, oddíl B, vložka 8417 (dále jen „odběratel“); a",
  ),
  body(
    "(2) Meridian Precision Components GmbH, se sídlem Werkstraße 12, " +
      "80339 Mnichov, Spolková republika Německo, zapsaná v obchodním " +
      "rejstříku vedeném Amtsgericht München pod č. HRB 245781 (dále jen " +
      "„dodavatel“),",
  ),
  body(
    "odběratel a dodavatel dále jednotlivě též „smluvní strana“ a společně " +
      "„smluvní strany“.",
  ),
  body(
    "VZHLEDEM K TOMU, ŽE odběratel vyvíjí a vyrábí autonomní mobilní roboty " +
      "a potřebuje spolehlivé dodávky přesných komponentů pohonů, a " +
      "VZHLEDEM K TOMU, ŽE dodavatel vyrábí harmonické převodovky, pouzdra " +
      "aktuátorů a související komponenty odpovídající specifikacím, " +
      "dohodly se smluvní strany takto:",
  ),
  heading("1. Definice a výklad"),
  body(
    "1.1 Pro účely této smlouvy: „ovládající osoba“ a „ovládaná osoba“ mají " +
      "význam podle § 74 a násl. zákona č. 90/2012 Sb., o obchodních " +
      "korporacích; „roční objem plnění“ znamená souhrn cen uhrazených nebo " +
      "splatných odběratelem podle této smlouvy za dvanáct (12) měsíců " +
      "bezprostředně předcházejících události, z níž nárok vznikl; " +
      "„pracovní den“ znamená den, který není sobotou, nedělí ani svátkem " +
      "v České republice nebo v Bavorsku; „objednávka“ znamená dílčí " +
      "objednávku vystavenou odběratelem podle článku 3; „zboží“ znamená " +
      "komponenty uvedené v příloze č. 1; a „specifikace“ znamenají " +
      "technické specifikace uvedené v příloze č. 1, ve znění změn " +
      "provedených podle odstavce 2.3.",
  ),
  body(
    "1.2 Nadpisy článků slouží pouze pro přehlednost a nemají vliv na výklad " +
      "smlouvy. Odkazy na články a přílohy jsou odkazy na články a přílohy " +
      "této smlouvy.",
  ),
  heading("2. Předmět dodávek"),
  body(
    "2.1 Dodavatel se zavazuje vyrábět a dodávat odběrateli zboží v souladu " +
      "se specifikacemi, sjednanými standardy jakosti a podmínkami této " +
      "smlouvy a převádět na něj vlastnické právo ke zboží; odběratel se " +
      "zavazuje zboží převzít a zaplatit kupní cenu.",
  ),
  body(
    "2.2 Dodavatel udržuje výrobní kapacitu dostatečnou k pokrytí klouzavé " +
      "prognózy odběratele, a to až do výše sto dvaceti procent (120 %) " +
      "objemu podle poslední čtvrtletní prognózy.",
  ),
  body(
    "2.3 Žádná ze smluvních stran nesmí změnit specifikace bez předchozího " +
      "písemného souhlasu druhé smluvní strany. Ukončení výroby kteréhokoli " +
      "zboží oznámí dodavatel odběrateli písemně nejméně dvanáct (12) " +
      "měsíců předem.",
  ),
  heading("3. Prognózy a objednávky"),
  body(
    "3.1 Odběratel předává dodavateli klouzavou prognózu odběru na dvanáct " +
      "(12) měsíců, kterou měsíčně aktualizuje. První tři (3) měsíce každé " +
      "prognózy jsou pro odběratele závazné.",
  ),
  body(
    "3.2 Odběratel objednává zboží objednávkou, v níž uvede množství, " +
      "termíny a místa dodání. Dodavatel objednávku přijme nebo odmítne do " +
      "pěti (5) pracovních dnů; objednávka, kterou dodavatel v této lhůtě " +
      "neodmítne, se považuje za přijatou.",
  ),
  body(
    "3.3 Odběratel je oprávněn přijatou objednávku bezplatně zrušit nebo " +
      "změnit její termín, učiní-li tak více než šedesát (60) dnů před " +
      "sjednaným dnem dodání.",
  ),
  heading("4. Dodání, vlastnické právo a nebezpečí škody"),
  body(
    "4.1 Dodavatel dodává zboží s doložkou DAP (Incoterms 2020) do provozovny " +
      "odběratele uvedené v objednávce. Smluvní strany považují dodržení " +
      "termínů dodání za podstatnou náležitost plnění.",
  ),
  body(
    "4.2 Je-li dodavatel v prodlení s dodáním zboží, je odběratel oprávněn " +
      "požadovat smluvní pokutu ve výši 0,5 % z hodnoty objednávky za každý " +
      "započatý týden prodlení, nejvýše však 5 % z hodnoty objednávky.",
  ),
  body(
    "4.3 Vlastnické právo ke zboží a nebezpečí škody na zboží přecházejí na " +
      "odběratele okamžikem řádného dodání podle odstavce 4.1.",
  ),
  heading("5. Kupní cena a platební podmínky"),
  body(
    "5.1 Kupní ceny jsou uvedeny v příloze č. 2 a jsou pevné do 31. 12. 2026. " +
      "Pozdější změna cen vyžaduje písemné oznámení nejméně devadesát (90) " +
      "dnů předem a písemný souhlas odběratele.",
  ),
  body(
    "5.2 Dodavatel fakturuje měsíčně zpětně. Nesporné faktury jsou splatné " +
      "do čtyřiceti pěti (45) dnů ode dne doručení řádného daňového dokladu.",
  ),
  body(
    "5.3 Smluvní strany jednou ročně v dobré víře projednají ceny s cílem " +
      "dosáhnout zvýšení produktivity o dvě procenta (2 %) ročně.",
  ),
  heading("6. Jakost, kontrola a vadné zboží"),
  body(
    "6.1 Dodavatel udržuje systém řízení jakosti certifikovaný podle ISO 9001 " +
      "nebo rovnocenné normy a uchovává záznamy o jakosti ke každé výrobní " +
      "šarži nejméně deset (10) let.",
  ),
  body(
    "6.2 Odběratel je oprávněn provést vstupní kontrolu zboží do deseti (10) " +
      "pracovních dnů od dodání. Odmítnutím vadného zboží v této lhůtě nejsou " +
      "dotčena práva odběratele ze záruky za jakost.",
  ),
  body(
    "6.3 Při dodání vadného zboží dodavatel podle volby odběratele dodá " +
      "náhradní zboží nebo vrátí kupní cenu, a to vždy do deseti (10) " +
      "pracovních dnů od oznámení vady.",
  ),
  heading("7. Záruka za jakost"),
  body(
    "7.1 Dodavatel poskytuje záruku za jakost v délce dvaceti čtyř (24) " +
      "měsíců od dodání, že zboží odpovídá specifikacím, nemá vady materiálu " +
      "ani zpracování a splňuje požadavky právních předpisů (§ 2113 a násl. " +
      "občanského zákoníku).",
  ),
  body(
    "7.2 Na porušení záruky podle odstavce 7.1 se použijí nároky podle " +
      "odstavce 6.3; tím nejsou dotčena ostatní práva odběratele podle této " +
      "smlouvy.",
  ),
  heading("8. Duševní vlastnictví"),
  body(
    "8.1 Každá smluvní strana si ponechává veškerá práva ke svému " +
      "dosavadnímu duševnímu vlastnictví. Nástroje, výkresy a specifikace " +
      "poskytnuté odběratelem zůstávají ve vlastnictví odběratele a " +
      "dodavatel je smí užít výhradně k plnění této smlouvy.",
  ),
  heading("9. Mlčenlivost"),
  body(
    "9.1 Každá smluvní strana zachovává mlčenlivost o důvěrných informacích " +
      "druhé smluvní strany, užívá je pouze k plnění této smlouvy a " +
      "zpřístupní je jen zaměstnancům a poradcům, kteří je nezbytně " +
      "potřebují a jsou vázáni obdobnou povinností mlčenlivosti. Tato " +
      "povinnost trvá pět (5) let po skončení smlouvy.",
  ),
  heading("10. Ochrana osobních údajů a bezpečnost"),
  body(
    "10.1 Smluvní strany postupují v souladu s nařízením (EU) 2016/679 " +
      "(GDPR) a zákonem č. 110/2019 Sb., o zpracování osobních údajů, a " +
      "přijmou vhodná technická a organizační opatření k ochraně osobních " +
      "údajů, které zpracovávají pro druhou smluvní stranu.",
  ),
  heading("11. Pojištění"),
  body(
    "11.1 Dodavatel je po celou dobu trvání smlouvy pojištěn pro případ " +
      "odpovědnosti za škodu způsobenou vadou výrobku s limitem pojistného " +
      "plnění nejméně 5 000 000 EUR na jednu pojistnou událost a na " +
      "požádání předloží odběrateli pojistný certifikát.",
  ),
  heading("12. Omezení odpovědnosti"),
  body(
    "12.1 Ujednání této smlouvy nevylučují ani neomezují odpovědnost za " +
      "újmu způsobenou člověku na jeho přirozených právech ani za újmu " +
      "způsobenou úmyslně nebo z hrubé nedbalosti (§ 2898 občanského " +
      "zákoníku). Každá smluvní strana odpovídá za plnění svých povinností " +
      "podle této smlouvy.",
  ),
  {
    commentId: 1,
    runs: [
      {
        kind: "text",
        text: "12.2 Celková odpovědnost dodavatele nepřesáhne ",
      },
      { kind: "deleted", text: "300 % ceny" },
      { kind: "inserted", text: "100 % ročního objemu plnění" },
      { kind: "text", text: " podle této smlouvy." },
    ],
    style: "body",
  },
  body(
    "12.3 Žádná ze smluvních stran neodpovídá za ušlý zisk, ztrátu tržeb, " +
      "ztrátu dat ani jinou nepřímou nebo následnou škodu, ať vznikla " +
      "jakkoli.",
  ),
  body(
    "12.4 Ujednání tohoto článku zůstávají v platnosti i po skončení smlouvy.",
  ),
  heading("13. Odškodnění"),
  body(
    "13.1 Dodavatel odškodní odběratele za nároky třetích osob z tvrzeného " +
      "porušení práv duševního vlastnictví dodaným zbožím, pokud jej " +
      "odběratel o nároku bez zbytečného odkladu vyrozumí a přenechá mu " +
      "vedení obrany.",
  ),
  heading("14. Doba trvání a skončení smlouvy"),
  {
    commentId: 2,
    runs: [
      {
        kind: "text",
        text:
          "14.1 Tato smlouva se uzavírá ode dne účinnosti na dobu určitou " +
          "tří (3) let a poté se automaticky prodlužuje vždy o další jeden " +
          "(1) rok. Kterákoli smluvní strana je oprávněna smlouvu vypovědět " +
          "i bez udání důvodu písemnou výpovědí s výpovědní dobou třiceti " +
          "(30) dnů ode dne jejího doručení druhé smluvní straně.",
      },
    ],
    style: "body",
  },
  body(
    "14.2 Kterákoli smluvní strana je oprávněna od smlouvy odstoupit " +
      "s okamžitou účinností, dojde-li u druhé smluvní strany ke změně " +
      "kontroly bez jejího předchozího písemného souhlasu, ocitne-li se " +
      "druhá smluvní strana v úpadku, nebo poruší-li smlouvu podstatným " +
      "způsobem a porušení nenapraví ani do třiceti (30) dnů od doručení " +
      "písemné výzvy.",
  ),
  body(
    "14.3 Skončením smlouvy nejsou dotčena již vzniklá práva. Při skončení " +
      "smlouvy dodavatel vrátí odběrateli jeho nástroje, výkresy a důvěrné " +
      "informace a po dobu až šesti (6) měsíců poskytne součinnost při " +
      "řádném převodu dodávek na jiného dodavatele.",
  ),
  heading("15. Vyšší moc"),
  body(
    "15.1 Žádná ze smluvních stran neodpovídá za prodlení nebo neplnění " +
      "způsobené mimořádnou nepředvídatelnou a nepřekonatelnou překážkou " +
      "vzniklou nezávisle na její vůli (§ 2913 odst. 2 občanského " +
      "zákoníku), pokud druhou smluvní stranu bez zbytečného odkladu " +
      "vyrozumí a vynaloží přiměřené úsilí ke zmírnění následků. Trvá-li " +
      "překážka déle než šedesát (60) dnů, může kterákoli smluvní strana " +
      "dotčené objednávky zrušit.",
  ),
  heading("16. Závěrečná ustanovení"),
  body(
    "16.1 Tato smlouva se řídí právním řádem České republiky, zejména " +
      "občanským zákoníkem. Použití Úmluvy OSN o smlouvách o mezinárodní " +
      "koupi zboží (CISG) smluvní strany vylučují.",
  ),
  body(
    "16.2 Smluvní strany se v souladu s § 89a zákona č. 99/1963 Sb., " +
      "občanský soudní řád, dohodly, že místně příslušným soudem pro spory " +
      "z této smlouvy je Obvodní soud pro Prahu 1, a náleží-li spor do " +
      "věcné příslušnosti krajského soudu, Městský soud v Praze.",
  ),
  body(
    "16.3 Tato smlouva včetně příloh představuje úplnou dohodu smluvních " +
      "stran o jejím předmětu. Změny smlouvy vyžadují písemnou formu a " +
      "podpisy obou smluvních stran; smluvní strany vylučují přijetí nabídky " +
      "s dodatkem nebo odchylkou (§ 1740 odst. 3 občanského zákoníku). " +
      "Oznámení podle smlouvy se doručují písemně na adresy uvedené výše.",
  ),
  body("Za Severka Robotics a.s.:"),
  body("Ing. Tereza Vrbová, předsedkyně představenstva"),
  body("Za Meridian Precision Components GmbH:"),
  body("Katrin Vogel, jednatelka (Geschäftsführerin)"),
];

const ORG_CONTACTS: SeedLocaleContent["orgContacts"] = [
  {
    id: seedId<"contact">("contact-org-kovotech-vysocina"),
    type: "organization",
    displayName: "Kovotech Vysočina a.s.",
    organizationName: "Kovotech Vysočina a.s.",
    registrationNumber: "25319845",
    taxId: "CZ25319845",
    bankAccounts: [
      {
        iban: "CZ6903000000004213424221",
        bic: "CEKOCZPP",
        bankName: "ČSOB",
        currency: "CZK",
      },
    ],
    billingAddress: {
      line1: "Brněnská 5221/48",
      city: "Jihlava",
      postalCode: "586 01",
      country: "Česká republika",
    },
    defaultHourlyRate: 4500,
    currency: "CZK",
    paymentTermDays: 30,
    emails: [
      {
        type: "work",
        address: "pravni@kovotech-vysocina.cz",
        isPrimary: true,
      },
    ],
    phones: [
      {
        type: "office",
        number: "+420 567 123 450",
        isPrimary: true,
      },
    ],
    color: "blue",
  },
  {
    id: seedId<"contact">("contact-org-vltavska-energetika"),
    type: "organization",
    displayName: "Vltavská energetika, a.s.",
    organizationName: "Vltavská energetika, a.s.",
    registrationNumber: "59083018",
    taxId: "CZ59083018",
    bankAccounts: [
      {
        iban: "CZ0901000000009885743949",
        bic: "KOMBCZPP",
        bankName: "Komerční banka",
        currency: "CZK",
      },
      {
        iban: "CZ3455000000000856849392",
        bic: "RZBCCZPP",
        bankName: "Raiffeisenbank",
        currency: "EUR",
      },
    ],
    billingAddress: {
      line1: "Na Pankráci 1683/127",
      city: "Praha",
      state: "Praha 4",
      postalCode: "140 00",
      country: "Česká republika",
    },
    defaultHourlyRate: 5000,
    currency: "CZK",
    paymentTermDays: 14,
    emails: [
      {
        type: "work",
        address: "pravni@vltavska-energetika.cz",
        isPrimary: true,
      },
    ],
    phones: [
      {
        type: "office",
        number: "+420 234 567 890",
        isPrimary: true,
      },
    ],
    color: "green",
  },
  {
    id: seedId<"contact">("contact-org-brnenska-stavebni"),
    type: "organization",
    displayName: "Brněnská stavební společnost, s.r.o.",
    organizationName: "Brněnská stavební společnost, s.r.o.",
    registrationNumber: "46972315",
    taxId: "CZ46972315",
    bankAccounts: [
      {
        iban: "CZ0520100000000748200381",
        bic: "FIOBCZPP",
        bankName: "Fio banka",
        currency: "CZK",
      },
    ],
    billingAddress: {
      line1: "Heršpická 813/5",
      city: "Brno",
      postalCode: "639 00",
      country: "Česká republika",
    },
    defaultHourlyRate: 3500,
    currency: "CZK",
    paymentTermDays: 30,
    emails: [
      {
        type: "work",
        address: "kancelar@brnenska-stavebni.cz",
        isPrimary: true,
      },
    ],
    phones: [
      {
        type: "office",
        number: "+420 545 210 330",
        isPrimary: true,
      },
    ],
    color: "orange",
  },
  {
    id: seedId<"contact">("contact-org-zeleny-horizont"),
    type: "organization",
    displayName: "Zelený horizont investiční fond, SICAV, a.s.",
    organizationName: "Zelený horizont investiční fond, SICAV, a.s.",
    registrationNumber: "96030828",
    taxId: "CZ96030828",
    bankAccounts: [
      {
        iban: "CZ2908000000008192546565",
        bic: "GIBACZPX",
        bankName: "Česká spořitelna",
        currency: "CZK",
      },
    ],
    billingAddress: {
      line1: "Rybná 682/14",
      city: "Praha",
      state: "Praha 1",
      postalCode: "110 00",
      country: "Česká republika",
    },
    defaultHourlyRate: 5500,
    currency: "CZK",
    paymentTermDays: 45,
    emails: [
      {
        type: "work",
        address: "legal@zeleny-horizont.cz",
        isPrimary: true,
      },
    ],
    phones: [
      {
        type: "office",
        number: "+420 222 314 650",
        isPrimary: true,
      },
    ],
    color: "emerald",
  },
  {
    id: seedId<"contact">("contact-org-severka-robotics"),
    type: "organization",
    displayName: "Severka Robotics a.s.",
    organizationName: "Severka Robotics a.s.",
    registrationNumber: "08417265",
    taxId: "CZ08417265",
    bankAccounts: [
      {
        iban: "CZ9227000000009686181750",
        bic: "BACXCZPP",
        bankName: "UniCredit Bank",
        currency: "CZK",
      },
    ],
    billingAddress: {
      line1: "Purkyňova 2875/107",
      city: "Brno",
      postalCode: "612 00",
      country: "Česká republika",
    },
    defaultHourlyRate: 4500,
    currency: "CZK",
    paymentTermDays: 30,
    emails: [
      {
        type: "work",
        address: "legal@severka-robotics.cz",
        isPrimary: true,
      },
    ],
    phones: [
      {
        type: "office",
        number: "+420 541 118 200",
        isPrimary: true,
      },
    ],
    color: "violet",
  },
];

// Further clients for a realistic contacts list. The marker law firm must head
// the list sorted by display name, so no other name starts with "A" or a digit.
const MORE_ORG_CONTACTS: SeedLocaleContent["moreOrgContacts"] = [
  {
    id: seedId<"contact">("contact-org-brazda-kalina"),
    type: "organization",
    displayName: MARKERS.firstContactName,
    organizationName: MARKERS.firstContactName,
    registrationNumber: "82199353",
    taxId: "CZ82199353",
    bankAccounts: [
      {
        iban: "CZ7006000000001102170858",
        bic: "AGBACZPP",
        bankName: "MONETA Money Bank",
        currency: "CZK",
      },
    ],
    billingAddress: {
      line1: "Žitná 562/10",
      city: "Praha",
      state: "Praha 2",
      postalCode: "120 00",
      country: "Česká republika",
    },
    defaultHourlyRate: 4000,
    currency: "CZK",
    paymentTermDays: 30,
    emails: [
      {
        type: "work",
        address: "kancelar@brazdakalina.cz",
        isPrimary: true,
      },
    ],
    color: "indigo",
  },
  {
    id: seedId<"contact">("contact-org-hofmann-seidl"),
    type: "organization",
    displayName: "Hofmann & Seidl Rechtsanwälte PartG mbB",
    organizationName: "Hofmann & Seidl Rechtsanwälte PartG mbB",
    registrationNumber: "PR 2187",
    taxId: "DE287415963",
    billingAddress: {
      line1: "Prinzregentenstraße 54",
      city: "München",
      postalCode: "80538",
      country: "Německo",
    },
    defaultHourlyRate: 380,
    currency: "EUR",
    paymentTermDays: 21,
    emails: [
      {
        type: "work",
        address: "kanzlei@hofmann-seidl.de",
        isPrimary: true,
      },
    ],
    color: "rose",
  },
  {
    id: seedId<"contact">("contact-org-povazska-strojarska"),
    type: "organization",
    displayName: "Považská strojárska, a.s.",
    organizationName: "Považská strojárska, a.s.",
    registrationNumber: "36518742",
    taxId: "SK2021456789",
    billingAddress: {
      line1: "Priemyselná 12",
      city: "Žilina",
      postalCode: "010 01",
      country: "Slovensko",
    },
    defaultHourlyRate: 180,
    currency: "EUR",
    paymentTermDays: 45,
    emails: [
      {
        type: "work",
        address: "pravne@povazska-strojarska.sk",
        isPrimary: true,
      },
    ],
    color: "slate",
  },
  {
    id: seedId<"contact">("contact-org-karlinska-banka"),
    type: "organization",
    displayName: "Karlínská banka, a.s.",
    organizationName: "Karlínská banka, a.s.",
    registrationNumber: "18190936",
    taxId: "CZ18190936",
    billingAddress: {
      line1: "Sokolovská 394/17",
      city: "Praha",
      state: "Praha 8",
      postalCode: "186 00",
      country: "Česká republika",
    },
    defaultHourlyRate: 5500,
    currency: "CZK",
    paymentTermDays: 14,
    emails: [
      {
        type: "work",
        address: "pravni@karlinska-banka.cz",
        isPrimary: true,
      },
    ],
    color: "lime",
  },
  {
    id: seedId<"contact">("contact-org-hanacka-farmaceutika"),
    type: "organization",
    displayName: "Hanácká farmaceutika, s.r.o.",
    organizationName: "Hanácká farmaceutika, s.r.o.",
    registrationNumber: "78657971",
    taxId: "CZ78657971",
    billingAddress: {
      line1: "Šlechtitelů 813/21",
      city: "Olomouc",
      postalCode: "779 00",
      country: "Česká republika",
    },
    defaultHourlyRate: 4200,
    currency: "CZK",
    paymentTermDays: 30,
    emails: [
      {
        type: "work",
        address: "legal@hanacka-farmaceutika.cz",
        isPrimary: true,
      },
    ],
    color: "pink",
  },
  {
    id: seedId<"contact">("contact-org-donauwerk-energie"),
    type: "organization",
    displayName: "Donauwerk Energie GmbH",
    organizationName: "Donauwerk Energie GmbH",
    registrationNumber: "FN 412873 k",
    taxId: "ATU68421937",
    billingAddress: {
      line1: "Handelskai 94",
      city: "Wien",
      postalCode: "1200",
      country: "Rakousko",
    },
    defaultHourlyRate: 320,
    currency: "EUR",
    paymentTermDays: 30,
    emails: [
      {
        type: "work",
        address: "recht@donauwerk-energie.at",
        isPrimary: true,
      },
    ],
    color: "yellow",
  },
  {
    id: seedId<"contact">("contact-org-slezske-tezebni"),
    type: "organization",
    displayName: "Slezské těžební závody, a.s.",
    organizationName: "Slezské těžební závody, a.s.",
    registrationNumber: "54323193",
    taxId: "CZ54323193",
    billingAddress: {
      line1: "Nádražní 88",
      city: "Ostrava",
      postalCode: "702 00",
      country: "Česká republika",
    },
    defaultHourlyRate: 4000,
    currency: "CZK",
    paymentTermDays: 30,
    emails: [
      {
        type: "work",
        address: "pravni@slezske-tezebni.cz",
        isPrimary: true,
      },
    ],
    color: "stone",
  },
  {
    id: seedId<"contact">("contact-org-labska-plavebni"),
    type: "organization",
    displayName: "Labská plavební společnost, s.r.o.",
    organizationName: "Labská plavební společnost, s.r.o.",
    registrationNumber: "48757497",
    taxId: "CZ48757497",
    billingAddress: {
      line1: "Přístavní 1302/4",
      city: "Děčín",
      postalCode: "405 02",
      country: "Česká republika",
    },
    defaultHourlyRate: 3800,
    currency: "CZK",
    paymentTermDays: 45,
    emails: [
      {
        type: "work",
        address: "pravni@labska-plavebni.cz",
        isPrimary: true,
      },
    ],
    color: "red",
  },
  {
    id: seedId<"contact">("contact-org-beskydska-automotive"),
    type: "organization",
    displayName: "Beskydská automotive, a.s.",
    organizationName: "Beskydská automotive, a.s.",
    registrationNumber: "11862521",
    taxId: "CZ11862521",
    billingAddress: {
      line1: "Průmyslová 2290",
      city: "Frýdek-Místek",
      postalCode: "738 01",
      country: "Česká republika",
    },
    defaultHourlyRate: 4200,
    currency: "CZK",
    paymentTermDays: 30,
    emails: [
      {
        type: "work",
        address: "pravni@beskydska-automotive.cz",
        isPrimary: true,
      },
    ],
    color: "purple",
  },
  {
    id: seedId<"contact">("contact-org-hornad-tech"),
    type: "organization",
    displayName: "Hornád Tech Ventures, s.r.o.",
    organizationName: "Hornád Tech Ventures, s.r.o.",
    registrationNumber: "55979718",
    taxId: "SK2120558431",
    billingAddress: {
      line1: "Hlavná 32",
      city: "Košice",
      postalCode: "040 01",
      country: "Slovensko",
    },
    defaultHourlyRate: 190,
    currency: "EUR",
    paymentTermDays: 30,
    emails: [
      {
        type: "work",
        address: "office@hornad-tech.sk",
        isPrimary: true,
      },
    ],
    color: "zinc",
  },
  {
    id: seedId<"contact">("contact-org-palavske-vrchy"),
    type: "organization",
    displayName: "Vinařství Pálavské vrchy, s.r.o.",
    organizationName: "Vinařství Pálavské vrchy, s.r.o.",
    registrationNumber: "76018954",
    taxId: "CZ76018954",
    billingAddress: {
      line1: "Náměstí 17",
      city: "Mikulov",
      postalCode: "692 01",
      country: "Česká republika",
    },
    defaultHourlyRate: 3000,
    currency: "CZK",
    paymentTermDays: 30,
    emails: [
      {
        type: "work",
        address: "obchod@palavske-vrchy.cz",
        isPrimary: true,
      },
    ],
    color: "teal",
  },
];

const PERSON_CONTACTS: SeedLocaleContent["personContacts"] = [
  {
    id: seedId<"contact">("contact-person-ondrej-brazda"),
    type: "person",
    displayName: "JUDr. Ondřej Brázda",
    prefix: "JUDr.",
    firstName: "Ondřej",
    lastName: "Brázda",
    emails: [
      {
        type: "work",
        address: "ondrej.brazda@brazdakalina.cz",
        isPrimary: true,
      },
    ],
    phones: [
      {
        type: "mobile",
        number: "+420 602 318 447",
        isPrimary: true,
      },
    ],
    color: "violet",
  },
  {
    id: seedId<"contact">("contact-person-lucie-vesela"),
    type: "person",
    displayName: "Mgr. Lucie Veselá",
    prefix: "Mgr.",
    firstName: "Lucie",
    lastName: "Veselá",
    emails: [
      {
        type: "work",
        address: "lucie.vesela@vltavska-energetika.cz",
        isPrimary: true,
      },
    ],
    phones: [
      {
        type: "mobile",
        number: "+420 603 254 119",
        isPrimary: true,
      },
    ],
    color: "fuchsia",
  },
  {
    id: seedId<"contact">("contact-person-radek-pospisil"),
    type: "person",
    displayName: "Ing. Radek Pospíšil",
    prefix: "Ing.",
    firstName: "Radek",
    lastName: "Pospíšil",
    emails: [
      {
        type: "work",
        address: "pospisil@brnenska-stavebni.cz",
        isPrimary: true,
      },
    ],
    color: "cyan",
  },
  {
    id: seedId<"contact">("contact-person-emily-carter"),
    type: "person",
    displayName: "Emily Carter",
    firstName: "Emily",
    lastName: "Carter",
    emails: [
      {
        type: "work",
        address: "e.carter@northbridge-data.co.uk",
        isPrimary: true,
      },
    ],
    phones: [
      {
        type: "mobile",
        number: "+44 7700 900456",
        isPrimary: true,
      },
    ],
    color: "sky",
  },
  {
    id: seedId<"contact">("contact-person-martin-dolezal"),
    type: "person",
    displayName: "JUDr. Martin Doležal, Ph.D.",
    prefix: "JUDr.",
    firstName: "Martin",
    lastName: "Doležal",
    suffix: "Ph.D.",
    notes: "Specialista na stavební právo a spory ze smluv o dílo",
    emails: [
      {
        type: "work",
        address: "dolezal@dolezal-advokat.cz",
        isPrimary: true,
      },
    ],
    color: "amber",
  },
];

const EXTRA_MATTERS: SeedLocaleContent["extraMatters"] = [
  // Advokátní kancelář Brázda & Kalina
  {
    name: "Substituce – insolvenční řízení",
    reference: "2024/009",
    clientLabel: "contact-org-brazda-kalina",
  },
  {
    name: "Náhrada škody – společné zastoupení",
    reference: "2024/010",
    clientLabel: "contact-org-brazda-kalina",
  },
  // Hofmann & Seidl
  {
    name: "Kartelové šetření ÚOHS",
    reference: "2024/011",
    clientLabel: "contact-org-hofmann-seidl",
  },
  // Považská strojárska
  {
    name: "Přeshraniční dodávky – reklamace",
    reference: "2024/012",
    clientLabel: "contact-org-povazska-strojarska",
  },
  // Karlínská banka
  {
    name: "Syndikovaný úvěr – strukturace",
    reference: "2024/013",
    clientLabel: "contact-org-karlinska-banka",
  },
  {
    name: "Regulatorní reporting ČNB",
    reference: "2024/014",
    clientLabel: "contact-org-karlinska-banka",
  },
  {
    name: "AML šetření – klientské účty",
    reference: "2024/015",
    clientLabel: "contact-org-karlinska-banka",
  },
  // Hanácká farmaceutika
  {
    name: "Registrace léčivých přípravků – SÚKL",
    reference: "2024/016",
    clientLabel: "contact-org-hanacka-farmaceutika",
  },
  // Donauwerk Energie
  {
    name: "Dlouhodobá smlouva o dodávkách elektřiny (PPA)",
    reference: "2024/017",
    clientLabel: "contact-org-donauwerk-energie",
  },
  // Slezské těžební závody
  {
    name: "Rekultivace odvalu – Karviná",
    reference: "2024/018",
    clientLabel: "contact-org-slezske-tezebni",
  },
  // Labská plavební společnost
  {
    name: "Spor z přepravní smlouvy",
    reference: "2024/019",
    clientLabel: "contact-org-labska-plavebni",
  },
  // Beskydská automotive
  {
    name: "Záruční spor – dodávky komponentů",
    reference: "2024/020",
    clientLabel: "contact-org-beskydska-automotive",
  },
  // Hornád Tech Ventures
  {
    name: "Seed investice – term sheet",
    reference: "2024/021",
    clientLabel: "contact-org-hornad-tech",
  },
  // Further matters for the main clients (deeper grouping)
  {
    name: "Kolektivní smlouva 2025",
    reference: "2024/055",
    clientLabel: "contact-org-kovotech-vysocina",
  },
  {
    name: "Licenční řízení ERÚ",
    reference: "2024/056",
    clientLabel: "contact-org-vltavska-energetika",
  },
  {
    name: "Územní řízení – Brno-sever",
    reference: "2024/057",
    clientLabel: "contact-org-brnenska-stavebni",
  },
  {
    name: "Strukturování fondu IV",
    reference: "2024/058",
    clientLabel: "contact-org-zeleny-horizont",
  },
];

const RECENT_MATTER_ACTIVITY = {
  "2024/059": "2026-07-17T09:00:00.000Z", // Prověrka datové místnosti – Projekt Atlas (Zelený horizont)
  "2026/031": "2026-07-16T15:00:00.000Z", // Smlouva o dodávkách – Meridian (Severka Robotics)
  "2024/058": "2026-07-16T11:00:00.000Z", // Strukturování fondu IV (Zelený horizont)
  "2024/015": "2026-07-15T16:00:00.000Z", // AML šetření – klientské účty (Karlínská banka)
  "2024/020": "2026-07-15T10:30:00.000Z", // Záruční spor – dodávky komponentů (Beskydská automotive)
  "2024/003": "2026-07-14T14:00:00.000Z", // Due diligence – Zelený horizont III (Zelený horizont)
  "2024/019": "2026-07-14T09:00:00.000Z", // Spor z přepravní smlouvy (Labská plavební)
  "2024/013": "2026-07-13T15:00:00.000Z", // Syndikovaný úvěr – strukturace (Karlínská banka)
  "2024/007": "2026-07-13T10:00:00.000Z", // Přeshraniční akvizice (Zelený horizont)
  "2024/011": "2026-07-12T14:00:00.000Z", // Kartelové šetření ÚOHS (Hofmann & Seidl)
};

const NOTES = [
  "Čeká se na vyjádření klienta k poslednímu návrhu",
  "Zkontrolováno partnerem; nutné drobné úpravy",
  "Finální verze čeká na podpis",
  "Protistrana požádala o prodloužení lhůty",
  "Podáno u soudu prostřednictvím datové schránky",
  "Interní revize dokončena",
  "Naplánována schůzka s klientem k obchodním podmínkám",
  "Nutný překlad do angličtiny",
  "Znalecký posudek přiložen samostatně",
  "Čeká se na souhlas regulátora",
  "Verze se sledovanými změnami zaslána protistraně",
  "Před podpisem nutné rozhodnutí představenstva",
  "Notářský zápis naplánován na příští týden",
  "Aktualizováno podle novely zákona",
  "Důvěrné; omezená distribuce",
  "Porovnáno se zjištěními z due diligence",
  "Vzor aktualizován podle současných standardů",
  "Přiloženo posouzení rizik",
  "Odhad odměny uveden v průvodním dopise",
  "Archivováno po uzavření spisu",
];

const TIME_ENTRY_NARRATIVES = [
  "Revize návrhu smlouvy o koupi podílu",
  "Telefonická porada s klientem k podmínkám transakce",
  "Právní rešerše k regulatorním požadavkům",
  "Příprava checklistu pro due diligence",
  "Analýza návrhu protistrany",
  "Příprava vyjádření k podání protistrany",
  "Revize finančních podkladů a výkazů",
  "Příprava výslechu svědka",
  "Podání u soudu a zajištění doručení",
  "Vyjednávání podmínek dohody o narovnání",
  "Revize dodatků k pracovním smlouvám",
  "Porada k posouzení compliance rizik",
  "Analýza přeshraniční regulace",
  "Analýza souladu s GDPR a dokumentace",
  "Interní porada týmu ke strategii spisu",
  "Příprava zadání pro znalecký posudek",
  "Revize plánu reorganizace skupiny",
  "Analýza podmínek integrovaného povolení",
  "Návrh rozhodnutí valné hromady",
  "Prověrka podle zákona proti praní peněz",
  "Revize návrhu na povolení spojení soutěžitelů (ÚOHS)",
  "Informování klienta o stavu sporu",
  "Rešerše k otázce mezinárodní příslušnosti",
  "Příprava dokumentace k vypořádání transakce",
  "Revize dodatku k nájemní smlouvě",
  "Korespondence s advokátem protistrany",
  "Due diligence majetku cílové společnosti",
  "Revize portfolia práv duševního vlastnictví",
  "Příprava na ústní jednání v rozhodčím řízení",
  "Analýza rozsahu pojistného krytí",
  "Daňové poradenství k přeshraniční transakci",
  "Posouzení vymahatelnosti konkurenční doložky",
  "Příprava zápisu z jednání představenstva",
  "Rešerše k předpisům o ochraně osobních údajů",
  "Návrh dodatku ke smlouvě o dodávkách",
  "Revize odpovědi na dotaz regulátora",
  "Informování klienta o nové právní úpravě",
  "Analýza nároků ze smlouvy o dílo",
  "Příprava návrhu smírného řešení",
  "Prověrka souladu s exportní kontrolou",
];

const EXPENSE_DESCRIPTIONS = [
  "Soudní poplatek",
  "Cesta do sídla klienta",
  "Odměna znalce za konzultaci",
  "Tisk a vazba dokumentů",
  "Kurýrní doručení podepsaných smluv",
  "Ověření podpisů (legalizace)",
  "Výpis z katastru nemovitostí",
  "Doručení soudním exekutorem",
  "Pronájem jednací místnosti",
  "Poštovné za doporučené zásilky",
];

/** Feminine count words ("čtyři protistrany"); larger counts stay digits. */
const feminineCount = (count: number) =>
  [
    "žádná",
    "jedna",
    "dvě",
    "tři",
    "čtyři",
    "pět",
    "šest",
    "sedm",
    "osm",
    "devět",
    "deset",
  ].at(count) ?? String(count);

/** The accusative of `feminineCount` ("na jednu protistranu"). */
const feminineAccusative = (count: number) =>
  count === 1 ? "jednu" : feminineCount(count);

/** The Czech form for a count: one, two to four, or five and more. */
const plural = (count: number, one: string, few: string, many: string) => {
  if (count === 1) {
    return one;
  }
  return count >= 2 && count <= 4 ? few : many;
};

/** "všech 72 dokumentů", "všechny 3 dokumenty", "jediný dokument". */
const allDocuments = (count: number) =>
  count === 1
    ? "jediný dokument"
    : `${plural(count, "", "všechny", "všech")} ${String(count)} ${plural(count, "", "dokumenty", "dokumentů")}`;

const CONSENT_NEEDED_TAG = "nutný souhlas";

const formatContractValue = (value: number) => `${String(value)} EUR`;

export const CS_SEED_CONTENT = {
  colleagues: [
    {
      id: "test-user-cs-alena-jandova",
      name: "Alena Jandová",
      email: "alena.jandova@stella.dev",
      image:
        "https://api.dicebear.com/9.x/avataaars/svg?seed=alena-jandova&backgroundColor=b6e3f4",
      hourlyRate: 4500,
    },
    {
      id: "test-user-cs-bohumil-mares",
      name: "Bohumil Mareš",
      email: "bohumil.mares@stella.dev",
      image:
        "https://api.dicebear.com/9.x/avataaars/svg?seed=bohumil-mares&backgroundColor=d1d4f9",
      hourlyRate: 2500,
    },
    {
      id: "test-user-cs-klara-novakova",
      name: "Klára Nováková",
      email: "klara.novakova@stella.dev",
      image:
        "https://api.dicebear.com/9.x/avataaars/svg?seed=klara-novakova&backgroundColor=ffd5dc",
      hourlyRate: 4500,
    },
  ],
  ownerHourlyRate: 6500,
  currency: "CZK",

  orgContacts: ORG_CONTACTS,
  personContacts: PERSON_CONTACTS,
  moreOrgContacts: MORE_ORG_CONTACTS,

  matters: {
    "ws-akvizice-energo": {
      // The matter the marketing editor scenes film: its breadcrumb frames
      // the Smlouva_o_dodavkach.docx redline (Severka Robotics buying drive
      // components from Meridian Precision).
      name: MARKERS.meridianMatterName,
      reference: "2026/031",
      clientIndex: 4, // Severka Robotics
      billingReference: "SR-DODAVKY-2026",
    },
    "ws-stavebni-spor": {
      name: "Spor o vady díla – Brno-jih",
      reference: "2024/002",
      clientIndex: 2, // Brněnská stavební společnost
      billingReference: "BSS-SPOR-2024",
    },
    "ws-due-diligence": {
      name: "Due diligence – Zelený horizont III",
      reference: "2024/003",
      clientIndex: 3, // Zelený horizont
      billingReference: "ZH-DD-2024",
    },
    "ws-pracovni-spory": {
      name: "Pracovněprávní spory – Kovotech",
      reference: "2024/004",
      clientIndex: 0, // Kovotech Vysočina
    },
    "ws-compliance-ceska-energie": {
      name: "Compliance program – Vltavská energetika",
      reference: "2024/005",
      clientIndex: 1, // Vltavská energetika
      billingReference: "VE-COMP-2024",
    },
    "ws-reorganizace": {
      name: "Reorganizace skupiny Kovotech",
      reference: "2024/006",
      clientIndex: 0, // Kovotech Vysočina
    },
    "ws-cross-border": {
      name: "Přeshraniční akvizice – poradenství",
      reference: "2024/007",
      clientIndex: 3, // Zelený horizont
      billingReference: "ZH-MA-2024",
    },
    "ws-gdpr-audit": {
      name: "Audit GDPR a implementace",
      reference: "2024/008",
      clientIndex: 2, // Brněnská stavební společnost
      billingReference: "BSS-GDPR-2024",
    },
    "ws-export-review": {
      name: MARKERS.exportReviewMatterName,
      reference: "2024/059",
      clientIndex: 3, // Zelený horizont
      billingReference: "ZH-EXPORT-2024",
    },
  },
  extraMatters: EXTRA_MATTERS,
  recentMatterActivity: RECENT_MATTER_ACTIVITY,

  matterDocuments: CS_MATTER_DOCUMENTS,
  documentTexts: CS_DOCUMENT_TEXTS,
  emails: CS_EMAILS,
  spaDocumentName: CS_SPA_DOCUMENT_NAME,
  supplierAgreement: {
    fileName: MARKERS.supplierAgreementFileName,
    baseFileName: "Smlouva_o_dodavkach_v3.docx",
    baseVersionLabel: "Původní návrh",
    currentVersionLabel: "Vyjednaný návrh",
    draftMarker: "PRACOVNÍ VERZE v4 — OBSAHUJE SLEDOVANÉ ZMĚNY",
    baseDraftMarker: "PRACOVNÍ VERZE v3",
    reviewer: SUPPLIER_AGREEMENT_REVIEWER,
    comments: SUPPLIER_AGREEMENT_COMMENTS,
    paragraphs: SUPPLIER_AGREEMENT_PARAGRAPHS,
    note: "Dvě ustanovení mimo playbook",
  },

  folders: { documents: "Dokumenty" },
  properties: {
    documents: "Dokumenty",
    status: "Stav",
    notes: "Poznámky",
    dueDate: "Termín",
    documentType: "Typ dokumentu",
    statusOptions: ["Aktivní", "V revizi", "Uzavřeno", "Pozastaveno"],
    documentTypePrompt: "Urči z přiloženého souboru kategorii dokumentu.",
  },
  notes: NOTES,
  documentTypeLabels: {
    nda: "Smlouva o mlčenlivosti (NDA)",
    spa: "Smlouva o koupi podílu",
    apa: "Smlouva o koupi aktiv",
    shareholders: "Akcionářská dohoda",
    msa: "Rámcová smlouva o poskytování služeb",
    sla: "Smlouva o úrovni služeb (SLA)",
    dpa: "Smlouva o zpracování osobních údajů",
    saas: "Smlouva o poskytování SaaS",
    employment: "Pracovní smlouva",
    consultancy: "Smlouva o poradenství",
    lease: "Nájemní smlouva",
    loan: "Úvěrová smlouva / smlouva o zápůjčce",
    guarantee: "Ručitelské prohlášení / finanční záruka",
    poa: "Plná moc",
    license: "Licenční smlouva",
    distribution: "Distribuční smlouva",
    supply: "Smlouva o dodávkách",
    settlement: "Dohoda o narovnání",
    termsheet: "Term sheet / memorandum o porozumění",
    other: "Ostatní",
  },

  exportReview: {
    folders: [
      "Korporátní dokumenty",
      "Obchodní smlouvy",
      "Pracovní právo",
      "Regulace",
      "Financování",
      "Nemovitosti",
    ],
    documentTypes: [
      "Seznam akcionářů",
      "Smlouva s odběratelem",
      "Smlouva s dodavatelem",
      "Pracovní smlouva",
      "Povolení",
      "Úvěrová smlouva",
      "Nájemní smlouva",
      "Pojistná smlouva",
    ],
    counterparties: [
      "Lindenhof Handel GmbH",
      "Javorník Strojírny s.r.o.",
      "Cedrus Cloud Ltd.",
      "Delta Logistika s.r.o.",
      "Ellbridge Bank plc",
      "Tisza Analytics Kft.",
      "Grachten Vastgoed B.V.",
      "Helios Energie a.s.",
    ],
    jurisdictions: [
      "Česká republika",
      "Německo",
      "Nizozemsko",
      "Maďarsko",
      "Spojené království",
    ],
    governingLaws: [
      "české právo",
      "německé právo",
      "nizozemské právo",
      "maďarské právo",
      "anglické právo",
    ],
    riskLevels: ["Nízké", "Střední", "Vysoké", "Kritické"],
    reviewStatuses: ["Nezahájeno", "V revizi", "Čeká na partnera", "Schváleno"],
    evidenceQuality: ["Přímá citace", "Ověřit zdroj", "Rozporné podklady"],
    primaryTags: ["změna kontroly", "ukončení", "datová místnost", "obnovení"],
    secondaryTags: [CONSENT_NEEDED_TAG, "cena", "ochrana dat", "zabezpečení"],
    keyObligation: (counterparty) =>
      `Společnost ${counterparty} je povinna před každým postoupením, obnovením nebo podstatnou změnou služeb zaslat písemné oznámení.`,
    riskFinding: {
      elevated:
        "Práva na souhlas, oznámení nebo ukončení musí před podpisem posoudit partner.",
      ordinary:
        "Nebyla zjištěna žádná blokující překážka; před dokončením transakce ověřte plnění povinností v běžném obchodním styku.",
    },
    formatContractValue,
    extract: {
      heading: (documentType) =>
        `${documentType.toUpperCase()} — VÝTAH PRO REVIZI`,
      intro: ({ counterparty, documentType, jurisdiction }) =>
        `Společnost ${counterparty} (jurisdikce: ${jurisdiction}) je stranou dokumentu „${documentType}“, který se prověřuje v rámci datové místnosti Projektu Atlas.`,
      keyTerms: "Klíčové údaje",
      labels: {
        document: "Dokument",
        documentType: "Typ dokumentu",
        counterparty: "Protistrana",
        jurisdiction: "Jurisdikce",
        governingLaw: "Rozhodné právo",
        effectiveDate: "Datum účinnosti",
        expiryDate: "Datum skončení",
        contractValue: "Hodnota smlouvy",
        riskLevel: "Úroveň rizika",
        reviewStatus: "Stav revize",
        evidenceQuality: "Kvalita podkladů",
        tags: "Štítky",
      },
      keyObligation: "Klíčová povinnost",
      riskFinding: "Zjištěné riziko",
      underReview: "Prověřovaný výňatek:",
      clause: ({ counterparty, governingLaw }) =>
        `„Společnost ${counterparty} je povinna plnit výše uvedenou povinnost a rozhodným právem je ${governingLaw}.“`,
    },
    statements: {
      "document-type": (row) => `Vytěžený typ dokumentu: ${row.documentType}.`,
      counterparty: (row) => `Vytěžená protistrana: ${row.counterparty}.`,
      jurisdiction: (row) => `Vytěžená jurisdikce: ${row.jurisdiction}.`,
      "governing-law": (row) => `Vytěžené rozhodné právo: ${row.governingLaw}.`,
      "effective-date": (row) =>
        `Vytěžené datum účinnosti: ${row.effectiveDate}.`,
      "expiry-date": (row) => `Vytěžené datum skončení: ${row.expiryDate}.`,
      "contract-value": (row) =>
        `Vytěžená hodnota smlouvy: ${formatContractValue(row.contractValue)}.`,
      "risk-level": (row) => `Klasifikovaná úroveň rizika: ${row.riskLevel}.`,
      "evidence-quality": (row) =>
        `Klasifikovaná kvalita podkladů: ${row.evidenceQuality}.`,
      tags: (row) => `Vytěžené štítky: ${row.tags.join(", ")}.`,
      "key-obligation": () =>
        "Klíčová povinnost vytěžena z oddílu o povinnostech.",
      "risk-finding": () => "Zjištěné riziko vytěženo z oddílu o rizicích.",
    },
    columns: {
      documentType: {
        name: "Typ dokumentu",
        prompt: "Urči z přiloženého souboru kategorii dokumentu.",
      },
      counterparty: {
        name: "Protistrana",
        prompt: "Uveď hlavní protistranu, kterou dokument označuje.",
      },
      jurisdiction: {
        name: "Jurisdikce",
        prompt: "Uveď jurisdikci, k níž se dokument vztahuje.",
      },
      governingLaw: {
        name: "Rozhodné právo",
        prompt: "Vytěž ujednání o rozhodném právu.",
      },
      effectiveDate: {
        name: "Datum účinnosti",
        prompt: "Uveď datum účinnosti ve formátu ISO.",
      },
      expiryDate: {
        name: "Datum skončení",
        prompt: "Uveď datum skončení nebo obnovení ve formátu ISO.",
      },
      contractValue: {
        name: "Hodnota smlouvy",
        prompt: "Uveď hodnotu smlouvy v eurech.",
      },
      riskLevel: {
        name: "Úroveň rizika",
        prompt: "Klasifikuj úroveň rizika z hlediska due diligence.",
      },
      reviewStatus: { name: "Stav revize" },
      evidenceQuality: {
        name: "Kvalita podkladů",
        prompt: "Posuď, zda má vytěžená hodnota přímou oporu v textu.",
      },
      tags: {
        name: "Štítky",
        prompt: "Vytěž stručné štítky pro due diligence.",
      },
      keyObligation: {
        name: "Klíčová povinnost",
        prompt: "Vytěž klíčovou povinnost podstatnou pro dokončení transakce.",
      },
      riskFinding: {
        name: "Zjištěné riziko",
        prompt: "Shrň hlavní riziko z due diligence jednou větou.",
      },
    },
  },

  agent: {
    formattingLocale: "cs-CZ",
    viewLabels: {
      title: "Dopady změny kontroly",
      scope:
        "Datová místnost Projektu Atlas · všechny smlouvy, hodnota smluv sečtená za každou protistranu",
      positions: {
        consent: "Souhlas nebo přezkum ukončení",
        confirm: "Ověřit souhlas",
        notice: "Pouze oznámení",
      },
      // Label-first so the counts read grammatically for any number
      // ("protistrany: 4", never "4 protistran").
      statDetail:
        "protistrany: {counterparties} · dokumenty: {documents} · {share} hodnoty",
      splitLabel: "Podíl na hodnotě smluv podle dopadu změny kontroly",
      columns: [
        "Protistrana",
        "Smlouva",
        "Dokumenty",
        "Hodnota smluv",
        "Riziko",
        "Změna kontroly",
      ],
    },
    agreementLabel: (documentType, year) => `${documentType} ${year}`,
    firstAnswerIntro: ({ documentCount, consentCount }) =>
      `Kontrola zahrnula ${allDocuments(documentCount)} v datové místnosti. Každá smlouva vyžaduje před postoupením, obnovením nebo podstatnou změnou služeb písemné oznámení, takže změna kontroly vyvolá všude přinejmenším oznamovací povinnost. Přísnější režim ${plural(consentCount, "má", "mají", "má")} jen ${feminineCount(consentCount)} ${plural(consentCount, "protistrana", "protistrany", "protistran")}: ${plural(consentCount, "její revizní výtah uvádí", "jejich revizní výtahy uvádějí", "jejich revizní výtahy uvádějí")} práva na souhlas nebo ukončení, která musí před podpisem posoudit partner.`,
    tableColumns: ["Protistrana", "Smlouva", "Riziko", "Dopad změny kontroly"],
    firstAnswerOutro: ({ confirmNames }) =>
      `U smluv se společnostmi ${confirmNames} revizní výtahy neuvádějí žádnou blokující překážku, každá je však označena štítkem „${CONSENT_NEEDED_TAG}“; před podpisem proto ověřte, zda je souhlas skutečně potřeba.`,
    secondAnswerLead: ({
      counterparty,
      criticalCount,
      riskFinding,
      riskFindingCitation,
      keyObligation,
      keyObligationCitation,
    }) =>
      `Úvěrová smlouva se společností ${counterparty} ${
        criticalCount === 1
          ? "je jedinou smlouvou s kritickým rizikem"
          : `patří mezi ${feminineCount(criticalCount)} ${plural(criticalCount, "smlouvu", "smlouvy", "smluv")} s kritickým rizikem`
      }. Její revizní výtah uvádí: „${riskFinding}“ ${riskFindingCitation} To platí nad rámec standardní povinnosti: „${keyObligation}“ ${keyObligationCitation}`,
    citationLabels: {
      riskFinding: "Zjištěné riziko",
      keyObligation: "Klíčová povinnost",
      governingLaw: "Rozhodné právo",
      expiryDate: "Datum skončení",
      contractValue: "Hodnota smlouvy",
    },
    factLabels: {
      governingLaw: "Rozhodné právo",
      expires: "Platnost do",
      contractValue: "Hodnota smlouvy",
    },
    thirdAnswerLead: ({
      share,
      consentValue,
      totalValue,
      consentCount,
      criticalCount,
      firstCriticalCitation,
      secondCriticalCitation,
    }) =>
      `Zde je přehled dopadů podle protistran. Na ${feminineAccusative(consentCount)} ${plural(consentCount, "protistranu", "protistrany", "protistran")}, ${plural(consentCount, "u níž", "u nichž", "u nichž")} je třeba posoudit souhlas nebo ukončení, připadá ${share} hodnoty smluv v datové místnosti (${consentValue} z ${totalValue}); v čele stojí ${
        criticalCount === 1
          ? "smlouva"
          : `${feminineCount(criticalCount)} ${plural(criticalCount, "smlouva", "smlouvy", "smluv")}`
      } s kritickým rizikem: ${firstCriticalCitation} a ${secondCriticalCitation}.`,
    thirdAnswerFollowUp: ({ confirmNames, consentCount }) =>
      `Další krok: ověřit stanovisko k souhlasu u společností ${confirmNames} a poté připravit žádosti o souhlas pro ${feminineAccusative(consentCount)} ${plural(consentCount, "posuzovanou protistranu", "posuzované protistrany", "posuzovaných protistran")}.`,
    recap: ({ consentNames, confirmNames }) =>
      `${MARKERS.agent.recapPrefix}: u společností ${consentNames} je třeba posoudit souhlas nebo ukončení a přehled dopadů to shrnuje pro poradu partnerů. Otevřené zůstává ověření souhlasu u společností ${confirmNames}.`,
  },

  billing: {
    taskCodeLabels: {
      RESEARCH: "Právní rešerše",
      REVIEW: "Revize dokumentů",
      DRAFT: "Příprava dokumentů",
      MEETING: "Jednání / porada",
      COURT: "Účast u soudu",
      FILING: "Podání a doručování",
      DISCOVERY: "Zajišťování důkazů",
      NEGOTIATE: "Vyjednávání",
      ADVISE: "Poradenství",
      ADMIN: "Administrativa",
    },
    activityCodeLabels: {
      PLAN: "Plánování a strategie",
      COMMUNICATE: "Komunikace",
      ANALYZE: "Analýza",
      MANAGE: "Správa spisu",
      TRAVEL: "Cestování",
      ATTEND: "Účast",
      PREPARE: "Příprava",
      CORRESPOND: "Korespondence",
    },
    timeEntryNarratives: TIME_ENTRY_NARRATIVES,
    invoiceEntryNarratives: [
      "Revize korporátních dokumentů cílové společnosti podle checklistu právní DD",
      "Analýza struktury skupiny a seznamu akcionářů",
      "Revize veřejnoprávních povolení a zjištění v oblasti compliance",
      "Souhrn rizik u ustanovení o změně kontroly v podstatných smlouvách",
      "Připomínky k prohlášením a zárukám a k odškodnění ve smlouvě o koupi podílu",
      "Telefonát s klientem k seznamu výjimek a připomínkám ke smlouvě o koupi podílu",
    ],
    expenseDescriptions: EXPENSE_DESCRIPTIONS,
    rateTableName: "Výchozí sazebník",
    invoiceNumberPrefix: "FV",
  },
  issuing: {
    seller: {
      legalName: "Hartvich & Partneři, advokátní kancelář, s.r.o.",
      registrationId: "14710498",
      vatId: "CZ14710498",
      addressLine1: "Vodičkova 699/30",
      city: "Praha",
      postalCode: "110 00",
      country: "CZ",
      iban: "CZ2301000000005523455429",
    },
    vatRates: {
      standard: {
        name: "Základní sazba",
        rateBps: 2100,
        validFrom: "2013-01-01",
      },
      reduced: {
        name: "Snížená sazba",
        rateBps: 1200,
        validFrom: "2024-01-01",
      },
    },
    numberSeriesName: "Faktury",
  },
  templates: {
    categories: {
      "tmpl-cat-corporate": {
        name: "Obchodní korporace",
        description:
          "Vzory smluv o koupi podílu, akcionářských dohod a rozhodnutí orgánů společnosti.",
      },
      "tmpl-cat-employment": {
        name: "Pracovní právo",
        description:
          "Pracovní smlouvy, smlouvy o mlčenlivosti a další personální vzory.",
      },
      "tmpl-cat-commercial": {
        name: "Obchodní smlouvy",
        description:
          "Rámcové smlouvy o poskytování služeb, SLA a další obchodní vzory.",
      },
      "tmpl-cat-real-estate": {
        name: "Nemovitosti",
        description:
          "Nájemní smlouvy, licence a vzory pro převody nemovitostí.",
      },
    },
    templates: {
      "tmpl-spa": {
        name: "Smlouva o koupi podílu",
        fileName: "Smlouva_o_koupi_podilu.docx",
      },
      "tmpl-board-resolution": {
        name: "Rozhodnutí představenstva",
        fileName: "Rozhodnuti_predstavenstva.docx",
      },
      "tmpl-shareholders": {
        name: "Akcionářská dohoda",
        fileName: "Akcionarska_dohoda.docx",
      },
      "tmpl-employment": {
        name: "Pracovní smlouva",
        fileName: "Pracovni_smlouva.docx",
      },
      "tmpl-nda": {
        name: "Smlouva o mlčenlivosti",
        fileName: "Smlouva_o_mlcenlivosti.docx",
      },
      "tmpl-msa": {
        name: "Rámcová smlouva o poskytování služeb",
        fileName: "Ramcova_smlouva_o_poskytovani_sluzeb.docx",
      },
      "tmpl-sla": {
        name: "Smlouva o úrovni služeb (SLA)",
        fileName: "Smlouva_o_urovni_sluzeb_SLA.docx",
      },
      "tmpl-supply": {
        // Distinct from the negotiated Smlouva_o_dodavkach.docx the editor
        // scenes film, so the two files never collide.
        name: "Smlouva o dodávkách",
        fileName: "Ramcova_smlouva_o_dodavkach.docx",
      },
      "tmpl-lease": {
        name: "Nájemní smlouva",
        fileName: "Najemni_smlouva.docx",
      },
    },
  },
} satisfies SeedLocaleContent;
