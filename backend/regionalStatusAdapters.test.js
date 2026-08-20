import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildFvgRivers, parseFvgWaterBodies } from "./arpaFvg.js";
import { buildLazioRivers, parseLazioCsv, parseLazioRecords } from "./arpaLazio.js";

test("ARPA FVG parser retains European codes, source reports and worst WFD status", () => {
  const html = `<table><thead><tr><th>Corpo idrico</th><th>Fiume</th><th>Comune</th><th>Stato ecologico</th><th>Stato chimico</th><th>Codice europeo</th></tr></thead><tbody>
    <tr><td><a href="/documents/1/isonzo.pdf">06AS5F3</a></td><td>Fiume Isonzo</td><td>Fiumicello</td><td>BUONO E OLTRE</td><td>BUONO</td><td>ITARW13IS00100010FR</td></tr>
    <tr><td>06SS4F5</td><td>Fiume Isonzo</td><td>Villesse</td><td>SUFFICIENTE</td><td>NON BUONO</td><td>ITARW13IS00100030FR</td></tr>
    <tr><td>06SS4F6</td><td>Fiume Isonzo</td><td>Turriaco</td><td>SCONOSCIUTO</td><td>SCONOSCIUTO</td><td>ITARW13IS00100020FR</td></tr>
  </tbody></table>`;
  const bodies = parseFvgWaterBodies(html);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].ecological, "Buono");
  assert.equal(bodies[0].ecologicalRaw, "BUONO E OLTRE");
  assert.equal(bodies[0].reportUrl, "https://www.arpa.fvg.it/documents/1/isonzo.pdf");
  const rivers = buildFvgRivers(bodies);
  assert.equal(rivers.length, 1);
  assert.equal(rivers[0].stretches[1].water_body_code, "ITARW13IS00100030FR");
  assert.equal(rivers[0].wfd_status, "bad");
  assert.equal(rivers[0].official_only, true);
});

test("ARPA Lazio parser groups numbered bodies and excludes dry unclassified rows", () => {
  const csv = `Denominazione Corpo Idrico;Codice Europeo Corpo Idrico; Codice Regionale Stazione;Tipologia Corpo Idrico;Tipologia Monitoraggio;Stato/Potenziale Ecologico triennio 2021-2023;Stato Chimico triennio 2021-2023\r\n
Fiume Aniene 1;IT12N010_ANIENE1_13SR6T;F4.71;Naturale;Sorveglianza;Buono;Buono\r\n
Fiume Aniene 5;IT12N010_ANIENE5_14SS4F;F4.64;Fortemente Modificato;Operativo;Scarso;Non Buono\r\n
Rio Torto 1;IT12N010_RIOTORTO1_14IN7T;F4.67;Naturale;Operativo;in secca;in secca`;
  const bodies = parseLazioCsv(csv);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].chemical, "Non buono");
  const rivers = buildLazioRivers(bodies);
  assert.equal(rivers.length, 1);
  assert.equal(rivers[0].name, "Fiume Aniene");
  assert.equal(rivers[0].stretches.length, 2);
  assert.equal(rivers[0].wfd_status, "bad");
  assert.equal(rivers[0].stretches[0].station_code, "F4.71");
});

test("ARPA Lazio datastore fallback maps the official CKAN field names", () => {
  const bodies = parseLazioRecords([{
    "Denominazione Corpo Idrico": "Fiume Sacco 3",
    "Codice Europeo Corpo Idrico": "IT12N005_SACCO3_15SS3D",
    "Codice Regionale Stazione": "F4.76",
    "Tipologia Corpo Idrico": "Naturale",
    "Tipologia Monitoraggio": "Operativo",
    "Stato/Potenziale Ecologico triennio 2021-2023": "Cattivo",
    "Stato Chimico triennio 2021-2023": "Non Buono"
  }]);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].stationCode, "F4.76");
  assert.equal(bodies[0].ecological, "Cattivo");
  assert.equal(bodies[0].chemical, "Non buono");
});

test("versioned ARPA Lazio snapshot contains the complete classified 2021-2023 release", () => {
  const snapshot = fs.readFileSync(path.join(import.meta.dirname, "data", "regional", "arpa-lazio-fiumi-2021-2023.csv"), "utf8");
  const bodies = parseLazioCsv(snapshot);
  const rivers = buildLazioRivers(bodies);
  assert.equal(bodies.length, 109);
  assert.equal(rivers.length, 63);
  assert.ok(bodies.every(body => body.waterBodyCode.startsWith("IT12")));
});
