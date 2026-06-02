// MVA Intelligence — Finance-module
// Gedeelde leesfunctie via DIRECTE databankverbinding (manier B).
// Leest realisatie (grootboek_detail) + controletotalen rechtstreeks uit Postgres,
// en omzeilt zo de PostgREST-cache volledig.
//
// Vereiste Netlify environment variables:
//   DATABASE_URL    Postgres connection string (Transaction pooler, poort 6543) incl. wachtwoord
//   FINANCE_TOKEN   toegangscode voor de finance-module
//
// Aanroep:
//   GET ?deel=grootboek   -> { rows:[...], controle:[...] }
//   GET ?deel=overzicht   -> { realisatie:{...} }
//   (geen deel)           -> grootboek + controle

const { Client } = require("pg");

exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "x-finance-token, content-type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors };

  const { DATABASE_URL, FINANCE_TOKEN } = process.env;
  const token = event.headers["x-finance-token"] || event.headers["X-Finance-Token"];
  if (!FINANCE_TOKEN || token !== FINANCE_TOKEN) return json(401, cors, { error: "Geen toegang." });
  if (!DATABASE_URL) return json(500, cors, { error: "Server niet geconfigureerd: DATABASE_URL ontbreekt." });

  const deel = (event.queryStringParameters && event.queryStringParameters.deel) || "grootboek";
  const client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

  try {
    await client.connect();

    const gd = await client.query(
      `select entiteit, gb_nr, omschrijving, categorie,
              to_char(d2025,'YYYY-MM-DD') as d2025, to_char(dytd,'YYYY-MM-DD') as dytd,
              v2025, vytd
       from finance.grootboek_detail order by entiteit, gb_nr`);
    const ct = await client.query(
      `select entiteit, to_char(rapportagedatum,'YYYY-MM-DD') as rapportagedatum, resultaat
       from finance.controle_eindtotalen order by entiteit, rapportagedatum`);

    if (deel === "overzicht") {
      const r2025 = {}, rytd = {};
      let peilYtd = null;
      for (const ent of ["PRO", "VZ"]) {
        const rows = ct.rows.filter(c => c.entiteit === ent).sort((a,b)=>a.rapportagedatum<b.rapportagedatum?-1:1);
        if (rows[0]) r2025[ent] = Number(rows[0].resultaat);
        if (rows[1]) { rytd[ent] = Number(rows[1].resultaat); peilYtd = rows[1].rapportagedatum; }
      }
      return json(200, cors, { realisatie: { r2025, rytd, peil_ytd: peilYtd } });
    }

    return json(200, cors, { rows: gd.rows, controle: ct.rows });
  } catch (e) {
    return json(502, cors, { error: "Databank: " + String((e && e.message) || e) });
  } finally {
    try { await client.end(); } catch (_) {}
  }
};

function json(s, c, b) {
  return { statusCode: s, headers: { ...c, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(b) };
}
