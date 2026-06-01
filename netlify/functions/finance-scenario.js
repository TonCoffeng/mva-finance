// MVA Intelligence — Finance-module
// Netlify Function: bewaart en laadt scenario's via Netlify Blobs.
// Geen externe database nodig — opslag zit in Netlify zelf.
//
// GET  (x-finance-token)            -> { scenarios:[{id,naam,ts}] }      (lijst)
// GET  ?id=<id> (x-finance-token)   -> { id, naam, payload, ts }         (laden)
// POST { naam, payload } (token)    -> { id, naam, ts }                  (opslaan)
// DELETE ?id=<id> (token)           -> { ok:true }
//
// Vereiste env var: FINANCE_TOKEN

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
    const { getStore } = await import("@netlify/blobs");
    store = getStore("finance-scenarios");
  } catch (e) {
    return json(500, cors, { error: "Opslag niet beschikbaar: " + String((e && e.message) || e) });
  }

  const INDEX = "index";
  const readIndex = async () => {
    try { const v = await store.get(INDEX, { type: "json" }); return Array.isArray(v) ? v : []; }
    catch { return []; }
  };

  try {
    if (event.httpMethod === "GET") {
      const id = event.queryStringParameters && event.queryStringParameters.id;
      if (id) {
        const rec = await store.get("scn_" + id, { type: "json" });
        if (!rec) return json(404, cors, { error: "Scenario niet gevonden." });
        return json(200, cors, rec);
      }
      const idx = await readIndex();
      idx.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      return json(200, cors, { scenarios: idx });
    }

    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      const naam = (body.naam || "").toString().trim().slice(0, 80) || "Naamloos scenario";
      const payload = body.payload || {};
      const id = body.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
      const ts = Date.now();
      const rec = { id, naam, payload, ts };
      await store.setJSON("scn_" + id, rec);
      const idx = await readIndex();
      const without = idx.filter((x) => x.id !== id);
      without.push({ id, naam, ts });
      await store.setJSON(INDEX, without);
      return json(200, cors, { id, naam, ts });
    }

    if (event.httpMethod === "DELETE") {
      const id = event.queryStringParameters && event.queryStringParameters.id;
      if (!id) return json(400, cors, { error: "Geen id." });
      await store.delete("scn_" + id);
      const idx = await readIndex();
      await store.setJSON(INDEX, idx.filter((x) => x.id !== id));
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
