// MVA Intelligence — Finance-module
// Netlify Function: bewaart en laadt scenario's via Netlify Blobs.
// Geen externe database nodig — opslag zit in Netlify zelf.
//
// GET  (x-finance-token)            -> { scenarios:[{id,naam,ts}] }   (lijst, opgebouwd uit de opslag)
// GET  ?id=<id> (x-finance-token)   -> { id, naam, payload, ts }      (laden)
// POST { naam, payload } (token)    -> { id, naam, ts }               (opslaan)
// DELETE ?id=<id> (token)           -> { ok:true }
//
// Robuust: geen aparte index-blob (die kon racen). De lijst wordt elke keer
// rechtstreeks uit de opgeslagen scenario's opgebouwd.
//
// Vereiste env var: FINANCE_TOKEN

const PREFIX = "scn_";

exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "x-finance-token, content-type",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors };

  const { FINANCE_TOKEN } = process.env;
  const token = event.headers["x-finance-token"] || event.headers["X-Finance-Token"];
  if (!FINANCE_TOKEN || token !== FINANCE_TOKEN) return json(401, cors, { error: "Geen toegang." });

  let store;
  try {
    const { getStore, connectLambda } = await import("@netlify/blobs");
    connectLambda(event);            // koppelt Blobs-context aan deze aanvraag (Lambda-stijl functie)
    store = getStore("finance-scenarios");
  } catch (e) {
    return json(500, cors, { error: "Opslag niet beschikbaar: " + String((e && e.message) || e) });
  }

  try {
    if (event.httpMethod === "GET") {
      const id = event.queryStringParameters && event.queryStringParameters.id;
      if (id) {
        const rec = await store.get(PREFIX + id, { type: "json" });
        if (!rec) return json(404, cors, { error: "Scenario niet gevonden." });
        return json(200, cors, rec);
      }
      // lijst: bouw rechtstreeks op uit alle scn_-blobs
      const listing = await store.list({ prefix: PREFIX });
      const blobs = (listing && listing.blobs) || [];
      const scenarios = [];
      for (const b of blobs) {
        try {
          const rec = await store.get(b.key, { type: "json" });
          if (rec && rec.id) scenarios.push({ id: rec.id, naam: rec.naam, ts: rec.ts });
        } catch (_) { /* sla onleesbare over */ }
      }
      scenarios.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      return json(200, cors, { scenarios });
    }

    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      const naam = (body.naam || "").toString().trim().slice(0, 80) || "Naamloos scenario";
      const payload = body.payload || {};
      const id = body.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
      const ts = Date.now();
      await store.setJSON(PREFIX + id, { id, naam, payload, ts });
      return json(200, cors, { id, naam, ts });
    }

    if (event.httpMethod === "DELETE") {
      const id = event.queryStringParameters && event.queryStringParameters.id;
      if (!id) return json(400, cors, { error: "Geen id." });
      await store.delete(PREFIX + id);
      return json(200, cors, { ok: true });
    }

    return json(405, cors, { error: "Methode niet toegestaan." });
  } catch (e) {
    return json(500, cors, { error: String((e && e.message) || e) });
  }
};

function json(s, c, b) {
  return { statusCode: s, headers: { ...c, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(b) };
}
