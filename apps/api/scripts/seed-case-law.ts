/**
 * Seed the database with sample Czech court decisions for local
 * testing of the Case Law feature.
 *
 * Creates:
 *  - A case law source (CZ Regional Courts)
 *  - 8 real Czech court decisions with structured sections
 *  - Citation links between decisions
 *
 * Prerequisites:
 *   Run seed-test-user.ts first to create the test organization.
 *
 * Usage:
 *   bun apps/api/scripts/seed-case-law.ts
 */

import "dotenv/config";

import { createScopedDb, db } from "@/api/db";
import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { indexDecision } from "@/api/handlers/case-law/search-index";
import type { DecisionSection } from "@/api/handlers/case-law/types";

const SOURCE_ID = "seed-src-cz-regional";

const now = new Date();

// ---------------------------------------------------------------
// Sample decisions based on real Czech court cases
// ---------------------------------------------------------------

type SeedDecision = {
  id: string;
  caseNumber: string;
  ecli: string | null;
  court: string;
  country: string;
  language: string;
  decisionDate: string;
  decisionType: string;
  fulltext: string;
  sections: DecisionSection[];
  sourceUrl: string;
  metadata: Record<string, unknown>;
  sourceHash: string;
};

const decisions: SeedDecision[] = [
  {
    id: "seed-dec-001",
    caseNumber: "25 Cdo 1550/2021",
    ecli: "ECLI:CZ:NS:2023:25.CDO.1550.2021.1",
    court: "Nejvyssi soud",
    country: "CZE",
    language: "cs",
    decisionDate: "2023-03-15",
    decisionType: "rozsudek",
    sourceUrl: "https://nsoud.cz/Judikatura/25Cdo1550_2021",
    metadata: {
      legalSentence:
        "Provozovatel motoroveho vozidla odpovida za skodu " +
        "zpusobenou jeho provozem podle ustanoveni " +
        "\u00a7 2927 obcanskeho zakoniku i v pripade, " +
        "ze skoda vznikla v dusledku technicke zavady " +
        "vozidla, o ktere provozovatel nevedel.",
      reportingJudge: "JUDr. Petr Vojtek",
      decisionCategory: "civilni",
      mentionedStatutes: [
        "\u00a7 2927 z. c. 89/2012 Sb.",
        "\u00a7 2894 z. c. 89/2012 Sb.",
      ],
    },
    sourceHash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
    fulltext:
      "CESKA REPUBLIKA\nROZSUDEK\nJMENEM REPUBLIKY\n\n" +
      "Nejvyssi soud rozhodl v senate slozene z predsedy " +
      "senatu JUDr. Petra Vojtka a soudcu Mgr. Viktora " +
      "Szabo a JUDr. Roberta Waltra v pravni veci " +
      "zalobce: Jan Novak, nar. 1985, bytem Praha 4, " +
      "proti zalovanemu: Pojistovna a.s., se sidlem " +
      "Praha 1, Narodni 10, o nahradu skody z provozu " +
      "dopravniho prostredku.\n\n" +
      "I. Vyrok\n\n" +
      "Dovolani se zamita.\n\n" +
      "II. Oduvodneni\n\n" +
      "Okresni soud v Praze rozhodl rozsudkem ze dne " +
      "12. 5. 2020, c. j. 15 C 123/2019-87, ze " +
      "zalovany je povinen zaplatit zalobci castku " +
      "350 000 Kc s prislusenstvim. Soud prvniho " +
      "stupne vysel ze zjisteni, ze dne 3. 1. 2019 " +
      "doslo k dopravni nehode, pri niz bylo " +
      "poskozeno vozidlo zalobce v dusledku technicke " +
      "zavady na vozidle zalovaneho.\n\n" +
      "K odvolani zalovaneho Mestsky soud v Praze " +
      "rozsudkem ze dne 8. 2. 2021 rozsudek soudu " +
      "prvniho stupne potvrdil. Odvolaci soud se " +
      "ztotoznili se skutkovymi zjistenimia pravnim " +
      "posouzenim veci soudem prvniho stupne.\n\n" +
      "Zalovany podal dovolani s odkazem na judikaturu " +
      "Nejvyssiho soudu sp. zn. 25 Cdo 1200/2018. " +
      "Nejvyssi soud vsak dospel k zaveru, ze tato " +
      "judikatura neni na danou vec aplikovatelna.\n\n" +
      "Podle ustanoveni \u00a7 2927 obcanskeho zakoniku " +
      "provozovatel odpovida za skodu zpusobenou " +
      "provozem dopravniho prostredku. Tato " +
      "odpovednost je objektivni a neni podminena " +
      "zavinenim provozovatele.\n\n" +
      "Nejvyssi soud proto dovolani zamitl.",
    sections: [
      {
        index: 0,
        type: "header",
        title: null,
        text:
          "CESKA REPUBLIKA\nROZSUDEK\nJMENEM REPUBLIKY\n\n" +
          "Nejvyssi soud rozhodl v senate slozene z predsedy " +
          "senatu JUDr. Petra Vojtka a soudcu Mgr. Viktora " +
          "Szabo a JUDr. Roberta Waltra v pravni veci " +
          "zalobce: Jan Novak, nar. 1985, bytem Praha 4, " +
          "proti zalovanemu: Pojistovna a.s., se sidlem " +
          "Praha 1, Narodni 10, o nahradu skody z provozu " +
          "dopravniho prostredku.",
      },
      {
        index: 1,
        type: "ruling",
        title: "I. Vyrok",
        text: "Dovolani se zamita.",
      },
      {
        index: 2,
        type: "argumentation",
        title: "II. Oduvodneni",
        text:
          "Okresni soud v Praze rozhodl rozsudkem ze dne " +
          "12. 5. 2020, c. j. 15 C 123/2019-87, ze " +
          "zalovany je povinen zaplatit zalobci castku " +
          "350 000 Kc s prislusenstvim. Soud prvniho " +
          "stupne vysel ze zjisteni, ze dne 3. 1. 2019 " +
          "doslo k dopravni nehode, pri niz bylo " +
          "poskozeno vozidlo zalobce v dusledku technicke " +
          "zavady na vozidle zalovaneho.\n\n" +
          "K odvolani zalovaneho Mestsky soud v Praze " +
          "rozsudkem ze dne 8. 2. 2021 rozsudek soudu " +
          "prvniho stupne potvrdil. Odvolaci soud se " +
          "ztotoznili se skutkovymi zjistenimia pravnim " +
          "posouzenim veci soudem prvniho stupne.\n\n" +
          "Zalovany podal dovolani s odkazem na judikaturu " +
          "Nejvyssiho soudu sp. zn. 25 Cdo 1200/2018. " +
          "Nejvyssi soud vsak dospel k zaveru, ze tato " +
          "judikatura neni na danou vec aplikovatelna.\n\n" +
          "Podle ustanoveni \u00a7 2927 obcanskeho zakoniku " +
          "provozovatel odpovida za skodu zpusobenou " +
          "provozem dopravniho prostredku. Tato " +
          "odpovednost je objektivni a neni podminena " +
          "zavinenim provozovatele.\n\n" +
          "Nejvyssi soud proto dovolani zamitl.",
      },
    ],
  },
  {
    id: "seed-dec-002",
    caseNumber: "25 Cdo 1200/2018",
    ecli: "ECLI:CZ:NS:2019:25.CDO.1200.2018.1",
    court: "Nejvyssi soud",
    country: "CZE",
    language: "cs",
    decisionDate: "2019-06-20",
    decisionType: "rozsudek",
    sourceUrl: "https://nsoud.cz/Judikatura/25Cdo1200_2018",
    metadata: {
      legalSentence:
        "Liberacnim duvodem podle \u00a7 2927 odst. 2 " +
        "obcanskeho zakoniku neni skutecnost, ze " +
        "provozovatel zajistil pravidelnou udrzbu " +
        "vozidla, pokud technicka zavada presto vznikla.",
      reportingJudge: "JUDr. Marta Skulova",
      decisionCategory: "civilni",
      mentionedStatutes: [
        "\u00a7 2927 z. c. 89/2012 Sb.",
        "\u00a7 2927 odst. 2 z. c. 89/2012 Sb.",
      ],
    },
    sourceHash: "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5",
    fulltext:
      "CESKA REPUBLIKA\nROZSUDEK\nJMENEM REPUBLIKY\n\n" +
      "Nejvyssi soud rozhodl v senate slozene z predsedy " +
      "senatu JUDr. Marty Skulove v pravni veci zalobce: " +
      "Marie Svobodova, bytem Brno, proti zalovanemu: " +
      "Autodoprava Kral s.r.o., se sidlem Olomouc, " +
      "o nahradu skody.\n\n" +
      "I. Vyrok\n\n" +
      "Rozsudek Krajskeho soudu v Brne se meni tak, " +
      "ze zalovany je povinen zaplatit zalobci 520 000 Kc.\n\n" +
      "II. Oduvodneni\n\n" +
      "Zalovany namital, ze provadel pravidelne " +
      "technicke kontroly vozidla a ze technicka zavada " +
      "brzdoveho systemu vznikla nahodne. Nejvyssi soud " +
      "konstatoval, ze odpovednost za skodu z provozu " +
      "dopravniho prostredku je objektivni a pravidelna " +
      "udrzba neni liberacnim duvodem.",
    sections: [
      {
        index: 0,
        type: "header",
        title: null,
        text:
          "CESKA REPUBLIKA\nROZSUDEK\nJMENEM REPUBLIKY\n\n" +
          "Nejvyssi soud rozhodl v senate slozene z " +
          "predsedy senatu JUDr. Marty Skulove v pravni " +
          "veci zalobce: Marie Svobodova, bytem Brno, " +
          "proti zalovanemu: Autodoprava Kral s.r.o., " +
          "se sidlem Olomouc, o nahradu skody.",
      },
      {
        index: 1,
        type: "ruling",
        title: "I. Vyrok",
        text:
          "Rozsudek Krajskeho soudu v Brne se meni tak, " +
          "ze zalovany je povinen zaplatit zalobci " +
          "520 000 Kc.",
      },
      {
        index: 2,
        type: "argumentation",
        title: "II. Oduvodneni",
        text:
          "Zalovany namital, ze provadel pravidelne " +
          "technicke kontroly vozidla a ze technicka " +
          "zavada brzdoveho systemu vznikla nahodne. " +
          "Nejvyssi soud konstatoval, ze odpovednost " +
          "za skodu z provozu dopravniho prostredku je " +
          "objektivni a pravidelna udrzba neni " +
          "liberacnim duvodem.",
      },
    ],
  },
  {
    id: "seed-dec-003",
    caseNumber: "21 Cdo 2345/2022",
    ecli: "ECLI:CZ:NS:2023:21.CDO.2345.2022.1",
    court: "Nejvyssi soud",
    country: "CZE",
    language: "cs",
    decisionDate: "2023-09-28",
    decisionType: "rozsudek",
    sourceUrl: "https://nsoud.cz/Judikatura/21Cdo2345_2022",
    metadata: {
      legalSentence:
        "Zamestnavatel muze okamzite zrusit pracovni " +
        "pomer podle \u00a7 55 odst. 1 pism. b) zakoniku " +
        "prace pouze tehdy, jestlize zamestnanec porusil " +
        "povinnost vyplyvajici z pravnich predpisu " +
        "vztahujicich se k jim vykonavane praci zvlast " +
        "hrubym zpusobem.",
      reportingJudge: "JUDr. Mojmir Putna",
      decisionCategory: "pracovni",
      mentionedStatutes: [
        "\u00a7 55 z. c. 262/2006 Sb.",
        "\u00a7 52 pism. g) z. c. 262/2006 Sb.",
      ],
    },
    sourceHash: "c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6",
    fulltext:
      "CESKA REPUBLIKA\nROZSUDEK\nJMENEM REPUBLIKY\n\n" +
      "Nejvyssi soud Ceske republiky rozhodl v senate " +
      "slozene z predsedy senatu JUDr. Mojmira Putny " +
      "v pravni veci zalobce: Tomas Horak, bytem " +
      "Ostrava, proti zalovanemu: Stavby Plus a.s., " +
      "se sidlem Ostrava, o neplatnost okamziteho " +
      "zruseni pracovniho pomeru.\n\n" +
      "I. Vyrok\n\n" +
      "Dovolani zalovaneho se zamita.\n\n" +
      "II. Oduvodneni\n\n" +
      "Zalovany okamzite zrusil pracovni pomer se " +
      "zalobcem z duvodu opakovaneho pozdniho prichodu " +
      "na pracoviste. Soud prvniho stupne i odvolaci " +
      "soud rozhodly, ze opakovane pozdni prichody " +
      "v rozsahu 10-15 minut nedosahuji intenzity " +
      "zvlast hrubeho poruseni povinnosti.\n\n" +
      "Nejvyssi soud se ztotoznili se zaverem, ze " +
      "v danem pripade bylo na miste pouzit postupu " +
      "podle \u00a7 52 pism. g) zakoniku prace, tj. " +
      "vypoved pro soustavne mene zavazne porusovani " +
      "povinnosti, nikoliv okamzite zruseni podle " +
      "\u00a7 55 odst. 1 pism. b) zakoniku prace.",
    sections: [
      {
        index: 0,
        type: "header",
        title: null,
        text:
          "CESKA REPUBLIKA\nROZSUDEK\nJMENEM REPUBLIKY\n\n" +
          "Nejvyssi soud Ceske republiky rozhodl v senate " +
          "slozene z predsedy senatu JUDr. Mojmira Putny " +
          "v pravni veci zalobce: Tomas Horak, bytem " +
          "Ostrava, proti zalovanemu: Stavby Plus a.s., " +
          "se sidlem Ostrava, o neplatnost okamziteho " +
          "zruseni pracovniho pomeru.",
      },
      {
        index: 1,
        type: "ruling",
        title: "I. Vyrok",
        text: "Dovolani zalovaneho se zamita.",
      },
      {
        index: 2,
        type: "argumentation",
        title: "II. Oduvodneni",
        text:
          "Zalovany okamzite zrusil pracovni pomer se " +
          "zalobcem z duvodu opakovaneho pozdniho " +
          "prichodu na pracoviste. Soud prvniho stupne " +
          "i odvolaci soud rozhodly, ze opakovane pozdni " +
          "prichody v rozsahu 10-15 minut nedosahuji " +
          "intenzity zvlast hrubeho poruseni povinnosti.\n\n" +
          "Nejvyssi soud se ztotoznili se zaverem, ze " +
          "v danem pripade bylo na miste pouzit postupu " +
          "podle \u00a7 52 pism. g) zakoniku prace, tj. " +
          "vypoved pro soustavne mene zavazne porusovani " +
          "povinnosti, nikoliv okamzite zruseni podle " +
          "\u00a7 55 odst. 1 pism. b) zakoniku prace.",
      },
    ],
  },
  {
    id: "seed-dec-004",
    caseNumber: "4 As 52/2023",
    ecli: "ECLI:CZ:NSS:2023:4.AS.52.2023.1",
    court: "Nejvyssi spravni soud",
    country: "CZE",
    language: "cs",
    decisionDate: "2023-11-10",
    decisionType: "rozsudek",
    sourceUrl: "https://vyhledavac.nssoud.cz/DokumentOriginal/Html/12345",
    metadata: {
      legalSentence:
        "Spravni organ je povinen v oduvodneni rozhodnuti " +
        "o udeleni pokuty dle zakona o ochrane " +
        "hospodarske souteze uvest konkretni okolnosti, " +
        "ktere zohlednil pri stanoveni vyse pokuty.",
      reportingJudge: "JUDr. Filip Dienstbier",
      decisionCategory: "spravni",
      areaOfLaw: "hospodarska soutez",
      mentionedStatutes: [
        "\u00a7 22a z. c. 143/2001 Sb.",
        "\u00a7 68 z. c. 500/2004 Sb.",
      ],
    },
    sourceHash: "d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1",
    fulltext:
      "CESKA REPUBLIKA\nROZSUDEK\nJMENEM REPUBLIKY\n\n" +
      "Nejvyssi spravni soud rozhodl v senate slozene " +
      "z predsedy senatu JUDr. Filipa Dienstbiera " +
      "a soudcu Mgr. Aleše Roztocila a JUDr. Jany " +
      "Zemánkové v pravni veci zalobce: ABC Holding " +
      "a.s., se sidlem Praha 2, proti zalovanemu: " +
      "Urad pro ochranu hospodarske souteze, se sidlem " +
      "Brno, o zalobu proti rozhodnuti zalovaneho.\n\n" +
      "I. Vyrok\n\n" +
      "Rozhodnuti Uradu pro ochranu hospodarske " +
      "souteze ze dne 15. 3. 2023 se rusi a vec se " +
      "vraci zalovanemu k dalsimu rizeni.\n\n" +
      "II. Oduvodneni\n\n" +
      "Zalobce napadl rozhodnuti zalovaneho, kterym mu " +
      "byla ulozena pokuta ve vysi 15 000 000 Kc za " +
      "poruseni zakona o ochrane hospodarske souteze. " +
      "Zalobce namital, ze oduvodneni rozhodnuti " +
      "neobsahuje dostatecne konkretni okolnosti, ktere " +
      "spravni organ zohlednil pri stanoveni vyse " +
      "pokuty.\n\n" +
      "Nejvyssi spravni soud shledal zalbu duvodnou. " +
      "Spravni organ je v souladu s \u00a7 68 spravniho " +
      "radu povinen v oduvodneni rozhodnuti uvest " +
      "duvody vystupu, podklady pro vydani rozhodnuti " +
      "a uvahy, kterymi se spravni organ ridil pri " +
      "hodnoceni dukazu a pri pouziti pravnich predpisu.",
    sections: [
      {
        index: 0,
        type: "header",
        title: null,
        text:
          "CESKA REPUBLIKA\nROZSUDEK\nJMENEM REPUBLIKY\n\n" +
          "Nejvyssi spravni soud rozhodl v senate slozene " +
          "z predsedy senatu JUDr. Filipa Dienstbiera " +
          "a soudcu Mgr. Aleše Roztocila a JUDr. Jany " +
          "Zemánkové v pravni veci zalobce: ABC Holding " +
          "a.s., se sidlem Praha 2, proti zalovanemu: " +
          "Urad pro ochranu hospodarske souteze, se " +
          "sidlem Brno, o zalobu proti rozhodnuti " +
          "zalovaneho.",
      },
      {
        index: 1,
        type: "ruling",
        title: "I. Vyrok",
        text:
          "Rozhodnuti Uradu pro ochranu hospodarske " +
          "souteze ze dne 15. 3. 2023 se rusi a vec se " +
          "vraci zalovanemu k dalsimu rizeni.",
      },
      {
        index: 2,
        type: "argumentation",
        title: "II. Oduvodneni",
        text:
          "Zalobce napadl rozhodnuti zalovaneho, kterym " +
          "mu byla ulozena pokuta ve vysi 15 000 000 Kc " +
          "za poruseni zakona o ochrane hospodarske " +
          "souteze. Zalobce namital, ze oduvodneni " +
          "rozhodnuti neobsahuje dostatecne konkretni " +
          "okolnosti, ktere spravni organ zohlednil pri " +
          "stanoveni vyse pokuty.\n\n" +
          "Nejvyssi spravni soud shledal zalbu duvodnou. " +
          "Spravni organ je v souladu s \u00a7 68 spravniho " +
          "radu povinen v oduvodneni rozhodnuti uvest " +
          "duvody vystupu, podklady pro vydani rozhodnuti " +
          "a uvahy, kterymi se spravni organ ridil pri " +
          "hodnoceni dukazu a pri pouziti pravnich " +
          "predpisu.",
      },
    ],
  },
  {
    id: "seed-dec-005",
    caseNumber: "30 Cdo 3456/2022",
    ecli: "ECLI:CZ:NS:2023:30.CDO.3456.2022.1",
    court: "Nejvyssi soud",
    country: "CZE",
    language: "cs",
    decisionDate: "2023-05-17",
    decisionType: "usneseni",
    sourceUrl: "https://nsoud.cz/Judikatura/30Cdo3456_2022",
    metadata: {
      legalSentence:
        "Narok na zadostiucineni za nemajetkovou ujmu " +
        "zpusobenou nesprávnym uredním postupem se " +
        "promlcuje v subjektivni promlceci lhute tri " +
        "let ode dne, kdy se poskozeny dozvedel " +
        "o ujme a o tom, kdo za ni odpovida.",
      reportingJudge: "JUDr. Pavel Simon",
      decisionCategory: "civilni",
      mentionedStatutes: [
        "\u00a7 32 z. c. 82/1998 Sb.",
        "\u00a7 629 z. c. 89/2012 Sb.",
      ],
    },
    sourceHash: "e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    fulltext:
      "CESKA REPUBLIKA\nUSNESENI\n\n" +
      "Nejvyssi soud Ceske republiky rozhodl v senate " +
      "slozene z predsedy senatu JUDr. Pavla Simona " +
      "v pravni veci zalobce: Ceska republika " +
      "zastoupena Ministerstvem spravedlnosti, proti " +
      "zalovanemu: Karel Dvorak, bytem Plzen, " +
      "o zadostiucineni za nemajetkovou ujmu.\n\n" +
      "I. Vyrok\n\n" +
      "Dovolani se odmita.\n\n" +
      "II. Oduvodneni\n\n" +
      "Zalobce se domaha zadostiucineni za " +
      "nemajetkovou ujmu zpusobenou neprimerenoe " +
      "delkou soudniho rizeni. Dovolaci soud dospel " +
      "k zaveru, ze narok je promlceny, nebot " +
      "subjektivni promlceci lhuta tri let uplynula.",
    sections: [
      {
        index: 0,
        type: "header",
        title: null,
        text:
          "CESKA REPUBLIKA\nUSNESENI\n\n" +
          "Nejvyssi soud Ceske republiky rozhodl v senate " +
          "slozene z predsedy senatu JUDr. Pavla Simona " +
          "v pravni veci zalobce: Ceska republika " +
          "zastoupena Ministerstvem spravedlnosti, " +
          "proti zalovanemu: Karel Dvorak, bytem Plzen, " +
          "o zadostiucineni za nemajetkovou ujmu.",
      },
      {
        index: 1,
        type: "ruling",
        title: "I. Vyrok",
        text: "Dovolani se odmita.",
      },
      {
        index: 2,
        type: "argumentation",
        title: "II. Oduvodneni",
        text:
          "Zalobce se domaha zadostiucineni za " +
          "nemajetkovou ujmu zpusobenou neprimerenoe " +
          "delkou soudniho rizeni. Dovolaci soud dospel " +
          "k zaveru, ze narok je promlceny, nebot " +
          "subjektivni promlceci lhuta tri let uplynula.",
      },
    ],
  },
  {
    id: "seed-dec-006",
    caseNumber: "22 Cdo 987/2023",
    ecli: "ECLI:CZ:NS:2024:22.CDO.987.2023.1",
    court: "Nejvyssi soud",
    country: "CZE",
    language: "cs",
    decisionDate: "2024-01-22",
    decisionType: "rozsudek",
    sourceUrl: "https://nsoud.cz/Judikatura/22Cdo987_2023",
    metadata: {
      legalSentence:
        "Dobra vira drzitele nemovite veci, ktera je " +
        "predpokladem vydrzeni vlastnickeho prava " +
        "podle \u00a7 1089 obcanskeho zakoniku, musi " +
        "trvat po celou vydrzeci dobu deseti let.",
      reportingJudge: "Mgr. David Havlik",
      decisionCategory: "civilni",
      mentionedStatutes: [
        "\u00a7 1089 z. c. 89/2012 Sb.",
        "\u00a7 992 z. c. 89/2012 Sb.",
      ],
    },
    sourceHash: "f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3",
    fulltext:
      "CESKA REPUBLIKA\nROZSUDEK\nJMENEM REPUBLIKY\n\n" +
      "Nejvyssi soud rozhodl v senate slozene z " +
      "predsedy senatu Mgr. Davida Havlika v pravni " +
      "veci zalobce: Obec Dolni Lhota, proti " +
      "zalovanemu: Frantisek Pospisil, bytem Dolni " +
      "Lhota, o urceni vlastnickeho prava k pozemku.\n\n" +
      "I. Vyrok\n\n" +
      "Dovolani zalobce se zamita.\n\n" +
      "II. Oduvodneni\n\n" +
      "Zalovany uzival pozemek parc. c. 1234 v k.u. " +
      "Dolni Lhota nepretrzite po dobu 25 let v dobre " +
      "vire, ze je jeho vlastnikem. Soud prvniho " +
      "stupne i odvolaci soud priznal zalobalovanemu " +
      "vlastnicke pravo na zaklade vydrzeni.\n\n" +
      "Nejvyssi soud potvrdil, ze podminka dobre viry " +
      "trvajici po celou vydrzeci dobu byla splnena. " +
      "Zalovany mel duvod se domnivat, ze je " +
      "vlastnikem pozemku, nebot pozemek nabyl " +
      "na zaklade kupni smlouvy od osoby, ktera " +
      "figurovala v katastru nemovitosti jako vlastnik.",
    sections: [
      {
        index: 0,
        type: "header",
        title: null,
        text:
          "CESKA REPUBLIKA\nROZSUDEK\nJMENEM REPUBLIKY\n\n" +
          "Nejvyssi soud rozhodl v senate slozene z " +
          "predsedy senatu Mgr. Davida Havlika v pravni " +
          "veci zalobce: Obec Dolni Lhota, proti " +
          "zalovanemu: Frantisek Pospisil, bytem Dolni " +
          "Lhota, o urceni vlastnickeho prava k pozemku.",
      },
      {
        index: 1,
        type: "ruling",
        title: "I. Vyrok",
        text: "Dovolani zalobce se zamita.",
      },
      {
        index: 2,
        type: "argumentation",
        title: "II. Oduvodneni",
        text:
          "Zalovany uzival pozemek parc. c. 1234 v k.u. " +
          "Dolni Lhota nepretrzite po dobu 25 let v dobre " +
          "vire, ze je jeho vlastnikem. Soud prvniho " +
          "stupne i odvolaci soud priznal zalobalovanemu " +
          "vlastnicke pravo na zaklade vydrzeni.\n\n" +
          "Nejvyssi soud potvrdil, ze podminka dobre viry " +
          "trvajici po celou vydrzeci dobu byla splnena. " +
          "Zalovany mel duvod se domnivat, ze je " +
          "vlastnikem pozemku, nebot pozemek nabyl " +
          "na zaklade kupni smlouvy od osoby, ktera " +
          "figurovala v katastru nemovitosti jako vlastnik.",
      },
    ],
  },
  {
    id: "seed-dec-007",
    caseNumber: "Pl. US 34/2022",
    ecli: "ECLI:CZ:US:2023:PL.US.34.22.1",
    court: "Ustavni soud",
    country: "CZE",
    language: "cs",
    decisionDate: "2023-07-04",
    decisionType: "nalez",
    sourceUrl: "https://nalus.usoud.cz/PlUS34_22",
    metadata: {
      legalSentence:
        "Pravni uprava omezujici pristup k informacim " +
        "o odmenach pracovniku verejne spravy musi byt " +
        "proporcionalni a nesmi neprimerane zasahovat " +
        "do prava na informace garantovaneho cl. 17 " +
        "Listiny.",
      reportingJudge: "JUDr. Katerina Simackova",
      decisionCategory: "ustavni",
      mentionedStatutes: [
        "cl. 17 usneseni c. 2/1993 Sb.",
        "\u00a7 8b z. c. 106/1999 Sb.",
      ],
    },
    sourceHash: "a1c2e3f4a5b6c7d8e9f0a1b2c3d4e5f6",
    fulltext:
      "CESKA REPUBLIKA\nNALEZ\nUSTAVNIHO SOUDU\n\n" +
      "Ustavni soud rozhodl pod sp. zn. Pl. US 34/22 " +
      "dne 4. 7. 2023 v plenu slozene z predsedy soudu " +
      "JUDr. Pavla Rychetskeho a soudcu v pravni veci " +
      "navrhu skupiny 42 poslancu na zruseni casti " +
      "zakona c. 106/1999 Sb., o svobodnem pristupu " +
      "k informacim.\n\n" +
      "I. Vyrok\n\n" +
      "Ustanoveni \u00a7 8b odst. 3 zakona c. 106/1999 " +
      "Sb. se rusí dnem vyhlaseni nalezu " +
      "ve Sbirce zakonu.\n\n" +
      "II. Oduvodneni\n\n" +
      "Skupina poslancu napadla ustanoveni omezujici " +
      "pristup verejnosti k informacim o platech " +
      "a odmenach pracovniku verejne spravy. " +
      "Ustavni soud posoudil soulad napadeneho " +
      "ustanoveni s cl. 17 Listiny zakladnich prav " +
      "a svobod a dospel k zaveru, ze omezeni pristupu " +
      "k informacim je neproporcionalni.\n\n" +
      "III. Odlisne stanovisko\n\n" +
      "Soudce JUDr. Jan Musil se nestotoznuje " +
      "s nazorelm vetsiny. Podle jeho nazoru je " +
      "omezeni pristupu k informacim o platech " +
      "oduvodneno ochranou soukromi zamestnancu.",
    sections: [
      {
        index: 0,
        type: "header",
        title: null,
        text:
          "CESKA REPUBLIKA\nNALEZ\nUSTAVNIHO SOUDU\n\n" +
          "Ustavni soud rozhodl pod sp. zn. Pl. US 34/22 " +
          "dne 4. 7. 2023 v plenu slozene z predsedy " +
          "soudu JUDr. Pavla Rychetskeho a soudcu " +
          "v pravni veci navrhu skupiny 42 poslancu " +
          "na zruseni casti zakona c. 106/1999 Sb., " +
          "o svobodnem pristupu k informacim.",
      },
      {
        index: 1,
        type: "ruling",
        title: "I. Vyrok",
        text:
          "Ustanoveni \u00a7 8b odst. 3 zakona c. 106/1999 " +
          "Sb. se rusí dnem vyhlaseni nalezu " +
          "ve Sbirce zakonu.",
      },
      {
        index: 2,
        type: "argumentation",
        title: "II. Oduvodneni",
        text:
          "Skupina poslancu napadla ustanoveni omezujici " +
          "pristup verejnosti k informacim o platech " +
          "a odmenach pracovniku verejne spravy. " +
          "Ustavni soud posoudil soulad napadeneho " +
          "ustanoveni s cl. 17 Listiny zakladnich prav " +
          "a svobod a dospel k zaveru, ze omezeni " +
          "pristupu k informacim je neproporcionalni.",
      },
      {
        index: 3,
        type: "dissent",
        title: "III. Odlisne stanovisko",
        text:
          "Soudce JUDr. Jan Musil se nestotoznuje " +
          "s nazorelm vetsiny. Podle jeho nazoru je " +
          "omezeni pristupu k informacim o platech " +
          "oduvodneno ochranou soukromi zamestnancu.",
      },
    ],
  },
  {
    id: "seed-dec-008",
    caseNumber: "15 C 234/2022",
    ecli: null,
    court: "Okresni soud v Praze",
    country: "CZE",
    language: "cs",
    decisionDate: "2022-11-03",
    decisionType: "rozsudek",
    sourceUrl: "https://rozhodnuti.justice.cz/detail/15C234_2022",
    metadata: {
      subjectOfProceeding: "najem bytu",
      mentionedStatutes: [
        "\u00a7 2201 z. c. 89/2012 Sb.",
        "\u00a7 2291 z. c. 89/2012 Sb.",
      ],
    },
    sourceHash: "b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2",
    fulltext:
      "CESKA REPUBLIKA\nROZSUDEK\nJMENEM REPUBLIKY\n\n" +
      "Okresni soud v Praze rozhodl samosoudkyni " +
      "JUDr. Evou Novotnou v pravni veci zalobce: " +
      "Bytove druzstvo Slunecni, IČ 12345678, se " +
      "sidlem Praha 10, proti zalovanemu: Petr Cerny, " +
      "bytem Praha 10, o vyklizeni bytu.\n\n" +
      "I. Vyrok\n\n" +
      "Zalovany je povinen byt v dome Praha 10, " +
      "Slunecni 15, byt c. 12, vyklidit a vyklizeny " +
      "predat zalobci do 15 dnu od pravni moci " +
      "rozsudku.\n\n" +
      "II. Oduvodneni\n\n" +
      "Zalobce jako pronajimatel vypoveděl zalobovanemu " +
      "najemni smlouvu z duvodu hrubeho poruseni " +
      "povinnosti najemce. Zalovany po dobu " +
      "6 mesicu nehradil najemne. Soud shledal " +
      "vypoved opravnenou v souladu s \u00a7 2291 " +
      "obcanskeho zakoniku. Zalovany v prubehu " +
      "rizeni neuhradil dluzne najemne ani neprokazal " +
      "jiny duvod pro zachovani najemniho vztahu.\n\n" +
      "Soud odkizuje na rozhodnuti Nejvyssiho soudu " +
      "sp. zn. 25 Cdo 1550/2021 v otazce objektivni " +
      "odpovednosti.",
    sections: [
      {
        index: 0,
        type: "header",
        title: null,
        text:
          "CESKA REPUBLIKA\nROZSUDEK\nJMENEM REPUBLIKY\n\n" +
          "Okresni soud v Praze rozhodl samosoudkyni " +
          "JUDr. Evou Novotnou v pravni veci zalobce: " +
          "Bytove druzstvo Slunecni, IČ 12345678, se " +
          "sidlem Praha 10, proti zalovanemu: Petr " +
          "Cerny, bytem Praha 10, o vyklizeni bytu.",
      },
      {
        index: 1,
        type: "ruling",
        title: "I. Vyrok",
        text:
          "Zalovany je povinen byt v dome Praha 10, " +
          "Slunecni 15, byt c. 12, vyklidit a vyklizeny " +
          "predat zalobci do 15 dnu od pravni moci " +
          "rozsudku.",
      },
      {
        index: 2,
        type: "argumentation",
        title: "II. Oduvodneni",
        text:
          "Zalobce jako pronajimatel vypoveděl " +
          "zalobovanemu najemni smlouvu z duvodu hrubeho " +
          "poruseni povinnosti najemce. Zalovany po " +
          "dobu 6 mesicu nehradil najemne. Soud shledal " +
          "vypoved opravnenou v souladu s \u00a7 2291 " +
          "obcanskeho zakoniku. Zalovany v prubehu " +
          "rizeni neuhradil dluzne najemne ani " +
          "neprokazal jiny duvod pro zachovani najemniho " +
          "vztahu.\n\n" +
          "Soud odkizuje na rozhodnuti Nejvyssiho soudu " +
          "sp. zn. 25 Cdo 1550/2021 v otazce objektivni " +
          "odpovednosti.",
      },
    ],
  },
];

// ---------------------------------------------------------------
// Citations between decisions
// ---------------------------------------------------------------

type SeedCitation = {
  id: string;
  citingDecisionId: string;
  citedDecisionId: string | null;
  citationText: string;
  sectionIndex: number | null;
};

const citations: SeedCitation[] = [
  {
    id: "seed-cit-001",
    citingDecisionId: "seed-dec-001",
    citedDecisionId: "seed-dec-002",
    citationText: "sp. zn. 25 Cdo 1200/2018",
    sectionIndex: 2,
  },
  {
    id: "seed-cit-002",
    citingDecisionId: "seed-dec-008",
    citedDecisionId: "seed-dec-001",
    citationText: "sp. zn. 25 Cdo 1550/2021",
    sectionIndex: 2,
  },
  {
    id: "seed-cit-003",
    citingDecisionId: "seed-dec-003",
    citedDecisionId: null,
    citationText: "\u00a7 55 odst. 1 pism. b) zakoniku prace",
    sectionIndex: 2,
  },
];

// ---------------------------------------------------------------
// Seed function
// ---------------------------------------------------------------

async function seed() {
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to run: NODE_ENV must not be 'production'.");
    process.exit(1);
  }

  // --- source ---
  const existingSource = await db.query.caseLawSources.findFirst({
    where: { id: SOURCE_ID },
    columns: { id: true },
  });

  if (existingSource) {
    console.log("Case law source already exists, skipping.");
  } else {
    await db.insert(caseLawSources).values({
      id: SOURCE_ID,
      adapterKey: "cz-supreme",
      name: "Czech Supreme Court (seed)",
      enabled: true,
      lastSyncAt: now,
      config: {},
      createdAt: now,
      updatedAt: now,
    });
    console.log("Created case law source: Czech Supreme Court");
  }

  // --- decisions ---
  let insertedCount = 0;
  let skippedCount = 0;

  for (const d of decisions) {
    const existing = await db.query.caseLawDecisions.findFirst({
      where: { id: d.id },
      columns: { id: true },
    });

    if (existing) {
      skippedCount++;
      continue;
    }

    await db.insert(caseLawDecisions).values({
      id: d.id,
      sourceId: SOURCE_ID,
      caseNumber: d.caseNumber,
      ecli: d.ecli,
      court: d.court,
      country: d.country,
      language: d.language,
      decisionDate: d.decisionDate,
      decisionType: d.decisionType,
      fulltext: d.fulltext,
      sections: d.sections,
      sourceUrl: d.sourceUrl,
      metadata: d.metadata,
      sourceHash: d.sourceHash,
      createdAt: now,
      updatedAt: now,
    });

    const scopedDb = createScopedDb([]);
    await indexDecision(d.id, scopedDb);

    insertedCount++;
  }

  console.log(
    `Decisions: ${insertedCount} inserted, ` +
      `${skippedCount} skipped (already exist).`,
  );

  // --- citations ---
  let citInserted = 0;
  let citSkipped = 0;

  for (const c of citations) {
    const existing = await db.query.caseLawCitations.findFirst({
      where: { id: c.id },
      columns: { id: true },
    });

    if (existing) {
      citSkipped++;
      continue;
    }

    await db.insert(caseLawCitations).values({
      id: c.id,
      citingDecisionId: c.citingDecisionId,
      citedDecisionId: c.citedDecisionId,
      citationText: c.citationText,
      sectionIndex: c.sectionIndex,
      createdAt: now,
    });
    citInserted++;
  }

  console.log(
    `Citations: ${citInserted} inserted, ` +
      `${citSkipped} skipped (already exist).`,
  );

  console.log("\nDone. Case law data seeded successfully.");
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
