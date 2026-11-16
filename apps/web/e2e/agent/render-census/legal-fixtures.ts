import { panic } from "better-result";

const FIXTURE_SEED = 20_261_026;
export const DOCUMENT_NAME = "Smluvní podmínky převzetí a správy areálu.docx";
export const INSERTED_TEXT = " v obvyklém rozsahu.";
export const REVIEW_COLUMNS = [
  "Spisové označení",
  "Předmět posouzení",
  "Smluvní role",
  "Rozhodné datum",
  "Finanční dopad",
  "Sjednaná lhůta",
  "Hodnocení ujednání",
  "Doporučený postup",
  "Věcná poznámka",
] as const;

const TOPICS = [
  "Vymezení předmětu plnění",
  "Součinnost smluvních stran",
  "Předání technické dokumentace",
  "Podmínky převzetí díla",
  "Odpovědnost za skryté vady",
  "Zajištění řádného provozu",
  "Splatnost sjednané ceny",
  "Změna rozsahu prací",
  "Ochrana důvěrných informací",
  "Oznámení překážky plnění",
  "Přiměřenost smluvní pokuty",
  "Náhrada účelných nákladů",
  "Důsledky prodlení dodavatele",
  "Dokládání splnění závazku",
  "Vedení předávacího protokolu",
  "Pravidla započtení pohledávek",
  "Doručování právních jednání",
  "Uplatnění práva na slevu",
  "Ukončení smluvního vztahu",
  "Zachování povinnosti mlčenlivosti",
  "Rozdělení provozních rizik",
  "Řešení výkladových rozporů",
  "Vrácení svěřených podkladů",
] as const;

const SCOPES = [
  "přípravná etapa",
  "stavební část",
  "technologické vybavení",
  "přístupové komunikace",
  "přejímací řízení",
  "odstranění nedodělků",
  "zkušební provoz",
  "záruční doba",
  "pravidelná údržba",
  "závěrečné vypořádání",
] as const;

const OBLIGATIONS = [
  "Dodavatel předá objednateli úplné podklady v podobě umožňující ověřit skutečný rozsah plnění.",
  "Objednatel určí odpovědnou osobu a zpřístupní záznamy potřebné k řádnému posouzení závazku.",
  "Přejímající strana zapíše zjištěné odchylky do protokolu a umožní druhé straně doplnit vyjádření.",
  "Správce areálu uchová průkazný záznam o každém zásahu, který ovlivňuje bezpečnost nebo dostupnost provozu.",
  "Smluvní strany oddělí nespornou část plnění od požadavků, jejichž důvodnost je třeba doložit.",
  "Poskytovatel služby oznámí změnu pracovního postupu předem a popíše její dopad na sjednaný harmonogram.",
] as const;

const CONDITIONS = [
  "Samotné převzetí podkladů nepotvrzuje jejich věcnou správnost ani nezbavuje předávající stranu odpovědnosti za úplnost údajů.",
  "Případná změna sjednaného rozsahu vyžaduje písemné potvrzení, v němž budou odděleně uvedeny náklady a vliv na termín dokončení.",
  "Nevyjádří-li se druhá strana ve stanovené lhůtě, nelze její nečinnost bez dalšího považovat za souhlas s navrženým vypořádáním.",
  "Při posuzování přiměřenosti požadavku se přihlédne k významu dotčené povinnosti, délce prodlení a doloženým možnostem nápravy.",
  "Záznam o kontrole musí umožnit zpětně určit posuzovanou verzi dokumentace, rozsah zjištění a osobu odpovědnou za jejich vypořádání.",
  "Uplatnění práva z vady neomezuje povinnost provést nezbytná opatření, která zabrání zvětšení prokazatelné škody.",
] as const;

const RECOMMENDATIONS = [
  "Doplnit vazbu na předávací protokol",
  "Upřesnit počátek běhu lhůty",
  "Oddělit cenu plnění od náhrady nákladů",
  "Doložit způsob doručení oznámení",
  "Sjednotit pojmy s technickou přílohou",
  "Prověřit návaznost na záruční podmínky",
] as const;

const at = <T>(items: readonly T[], index: number) => {
  const item = items.at(index % items.length);
  if (item === undefined) {
    panic("Legal fixture vocabulary must not be empty");
  }
  return item;
};

// Each record has its own seeded stream, so generating a subset cannot change it.
type SeededIndexOptions = { record: number; field: number };

const SEED_MODULUS = 2_147_483_647;
const SEED_MULTIPLIER = 48_271;

const seededIndex = ({ record, field }: SeededIndexOptions) => {
  let state =
    (FIXTURE_SEED + (record + 1) * 104_729 + field * 13_007) % SEED_MODULUS;
  state = (state * SEED_MULTIPLIER) % SEED_MODULUS;
  return (state * SEED_MULTIPLIER) % SEED_MODULUS;
};

export const legalClause = (index: number) => {
  const topic = at(TOPICS, index);
  const scope = at(SCOPES, Math.floor(index / TOPICS.length));
  const days = 7 + (seededIndex({ record: index, field: 1 }) % 24);
  const reference = `AR-2026-${String(index + 1).padStart(4, "0")}`;
  return {
    heading: `Článek ${String(index + 1)}. ${topic}: ${scope}`,
    paragraph: `${at(OBLIGATIONS, seededIndex({ record: index, field: 2 }))} Pro oblast „${scope}“ se sjednává lhůta ${String(days)} dnů od doručení příslušné výzvy; související podklady se vedou pod označením ${reference}. ${at(CONDITIONS, seededIndex({ record: index, field: 3 }))} Při společné kontrole se samostatně zaznamená, zda se závěr vztahuje také na ujednání označené jako „${topic}“ a které listiny tento závěr podporují.`,
  };
};

export const createOutlinePages = () =>
  Array.from({ length: 80 }, (_page, page) =>
    Array.from({ length: page < 70 ? 3 : 2 }, (_clause, local) =>
      legalClause((page < 70 ? page * 3 : 210 + (page - 70) * 2) + local),
    ),
  );

type ReviewRecordOptions = { index: number; rowCount: number };

export const reviewRecord = ({ index, rowCount }: ReviewRecordOptions) => {
  const clause = legalClause(index);
  const month = 1 + (seededIndex({ record: index, field: 4 }) % 12);
  const day = 1 + (seededIndex({ record: index, field: 5 }) % 28);
  return {
    name: `${at(TOPICS, index)} – podklad AR-2026-${String(index + 1).padStart(4, "0")}`,
    values: {
      "Spisové označení": `SP-2026-${String(rowCount - index).padStart(4, "0")}`,
      "Předmět posouzení": at(TOPICS, index),
      "Smluvní role": at(
        ["objednatel", "dodavatel", "správce areálu"],
        seededIndex({ record: index, field: 6 }),
      ),
      "Rozhodné datum": `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      "Finanční dopad": `${String(25_000 + (seededIndex({ record: index, field: 7 }) % 975_000))} Kč`,
      "Sjednaná lhůta": `${String(7 + (seededIndex({ record: index, field: 1 }) % 24))} dnů od doručení výzvy`,
      "Hodnocení ujednání": at(
        [
          "Vyžaduje doplnění podkladů",
          "Přijatelné při uvedeném výkladu",
          "Nutno vyjasnit návaznost ustanovení",
        ],
        seededIndex({ record: index, field: 8 }),
      ),
      "Doporučený postup": at(
        RECOMMENDATIONS,
        seededIndex({ record: index, field: 9 }),
      ),
      "Věcná poznámka": clause.paragraph,
    } satisfies Record<(typeof REVIEW_COLUMNS)[number], string>,
  };
};
