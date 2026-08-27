import { heuristicAnchors, parseDreamAnchors, similarity } from "../src/memory-text.js";

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.error(`FAIL  ${name}`);
  }
}

console.log("Heuristik:");
check(
  "Merke-Satz wird als Fakt erkannt",
  heuristicAnchors("Bitte merke dir: Das Deployment läuft über Coolify.").some(
    (a) => a.kind === "fact" && a.importance >= 0.8,
  ),
);
check(
  "Namensnennung wird als Fakt erkannt",
  heuristicAnchors("Ich heiße Jonas und wohne in Bonn.").some((a) => a.kind === "fact"),
);
check(
  "Präferenz wird erkannt",
  heuristicAnchors("Ich mag keine Benachrichtigungen am Abend.").some(
    (a) => a.kind === "preference",
  ),
);
check(
  "Entscheidung wird erkannt",
  heuristicAnchors("Wir machen Code-Reviews von nun an immer paarweise.").some(
    (a) => a.kind === "decision",
  ),
);
check(
  "Offene Frage wird erkannt",
  heuristicAnchors("Der Name der neuen API ist noch unklar.").some(
    (a) => a.kind === "open_question",
  ),
);
check(
  "Smalltalk bleibt außen vor",
  heuristicAnchors("Hallo, wie geht es dir heute? Mir geht es gut, danke!").length === 0,
);
check(
  "Leerer Text liefert nichts",
  heuristicAnchors("").length === 0,
);

console.log("Dedupe (Similarity):");
check(
  "Umformulierte Wiederholung liegt über Schwelle",
  similarity(
    "Ich heiße Jonas und wohne in Bonn",
    "Mein Name ist Jonas, ich wohne in Bonn",
  ) >= 0.5,
);
check(
  "Fremde Sätze liegen unter Schwelle",
  similarity("Ich mag keine Benachrichtigungen", "Das Deployment läuft über Coolify") < 0.4,
);

console.log("Dream-Parser:");
check(
  "Gültiges anchors-JSON wird geparst",
  parseDreamAnchors(
    '{"anchors":[{"text":"Nutzer wohnt in Bonn","kind":"fact","importance":0.9}]}',
  ).length === 1,
);
check(
  "Bekanntes Kind bleibt erhalten, unbekanntes wird fact",
  parseDreamAnchors(
    '{"anchors":[{"text":"Wir nutzen pnpm","kind":"decision"},{"text":"Server heißt alfa","kind":"seltsam"}]}',
  )[1]?.kind === "fact",
);
check(
  "Wichtigkeit wird auf 0.1–1 begrenzt",
  parseDreamAnchors('{"anchors":[{"text":"Sehr wichtig alles","importance":99}]}')[0]
    ?.importance === 1,
);
check(
  "Müll wird abgewiesen",
  parseDreamAnchors("kein json hier") .length === 0,
);
check(
  "Text in JSON-Wrapper wird noch gefunden",
  parseDreamAnchors('Sure! Here you go: {"anchors":[{"text":"API-Key liegt im Vault","kind":"fact","importance":0.8}]}').length === 1,
);

console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`);
process.exit(fail > 0 ? 1 : 0);
