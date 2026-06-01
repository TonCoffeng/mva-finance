// MVA Intelligence — Finance-module
// Netlify Function: levert Grootboek detail + controletotalen.
// Standaardroute: leest de Supabase Data API (PostgREST) op het public-schema,
// via de service-sleutel — exact zoals de andere MvA-apps (o.a. Leadpool).
//
// Vereiste Netlify environment variables (staan al ingesteld):
//   SUPABASE_URL          https://ehqtyhoeubchcwfavdzr.supabase.co
//   SUPABASE_SERVICE_KEY  service_role sleutel (server-side, geheim)
//   FINANCE_TOKEN         wachtwoord voor toegang tot deze pagina

exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "x-finance-token, content-type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors };

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY, FINANCE_TOKEN } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return json(500, cors, { error: "Server niet geconfigureerd: SUPABASE_URL of SUPABASE_SERVICE_KEY ontbreekt." });
  }

  const token = event.headers["x-finance-token"] || event.headers["X-Finance-Token"];
  if (!FINANCE_TOKEN || token !== FINANCE_TOKEN) return json(401, cors, { error: "Geen toegang." });

  const base = SUPABASE_URL.replace(/\/+$/, "") + "/rest/v1";
  const headers = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: "Bearer " + SUPABASE_SERVICE_KEY,
    Accept: "application/json",
  };

  try {
    const gdUrl = base +
      "/v_finance_grootboek" +
      "?select=entiteit,gb_nr,omschrijving,categorie,d2025,dytd,v2025,vytd" +
      "&order=entiteit,gb_nr";
    const ctUrl = base +
      "/v_finance_controle" +
      "?select=entiteit,rapportagedatum,resultaat";

    const [gdRes, ctRes] = await Promise.all([
      fetch(gdUrl, { headers }),
      fetch(ctUrl, { headers }),
    ]);

    if (!gdRes.ok) return json(502, cors, { error: "Grootboek ophalen mislukt (" + gdRes.status + "): " + (await gdRes.text()) });
    if (!ctRes.ok) return json(502, cors, { error: "Controle ophalen mislukt (" + ctRes.status + "): " + (await ctRes.text()) });

    const rows = await gdRes.json();
    const controle = await ctRes.json();

    return json(200, cors, { rows, controle, generated_at: new Date().toISOString() });
  } catch (e) {
    return json(502, cors, { error: String((e && e.message) || e) });
  }
};

function json(statusCode, cors, body) {
  return { statusCode, headers: { ...cors, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) };
}
