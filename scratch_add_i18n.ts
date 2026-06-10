import fs from "fs";
import path from "path";

const langsDir = "d:/12.New-Small-comp/7.stella/stella/apps/web/src/i18n/langs";

const translations: Record<string, string> = {
  "cs.json": '    "tabToAsk": "Tabulátor pro dotaz: \\"{prompt}\\"",',
  "de.json": '    "tabToAsk": "Tab zum Fragen: „{prompt}“",',
  "es.json": '    "tabToAsk": "Tab para preguntar: \\"{prompt}\\"",',
  "et.json": '    "tabToAsk": "Tabeldusklahv küsimiseks: \\"{prompt}\\"",',
  "fr.json": '    "tabToAsk": "Tab pour demander : « {prompt} »",',
  "hu.json": '    "tabToAsk": "Tab a kérdezéshez: „{prompt}”",',
  "lt.json": '    "tabToAsk": "Tab, kad paklaustumėte: „{prompt}“",',
  "lv.json": '    "tabToAsk": "Tab, lai jautātu: “{prompt}”",',
  "pl.json": '    "tabToAsk": "Tab, aby zapytać: „{prompt}”",',
  "pt-BR.json": '    "tabToAsk": "Tab para perguntar: \\"{prompt}\\"",',
  "sk.json": '    "tabToAsk": "Tabulátor pre otázku: \\"{prompt}\\"",',
};

for (const [filename, lineToAdd] of Object.entries(translations)) {
  const filepath = path.join(langsDir, filename);
  if (!fs.existsSync(filepath)) {
    console.log(`File not found: ${filepath}`);
    continue;
  }
  const content = fs.readFileSync(filepath, "utf8");
  const lines = content.split("\n");
  
  // Find where "stopResponse" is
  const index = lines.findIndex(l => l.includes('"stopResponse":'));
  if (index === -1) {
    console.log(`stopResponse not found in ${filename}`);
    continue;
  }
  
  // Check if tabToAsk is already present
  if (lines.some(l => l.includes('"tabToAsk":'))) {
    console.log(`tabToAsk already present in ${filename}`);
    continue;
  }
  
  // Insert tabToAsk after stopResponse
  lines.splice(index + 1, 0, lineToAdd);
  fs.writeFileSync(filepath, lines.join("\n"), "utf8");
  console.log(`Added key to ${filename}`);
}
