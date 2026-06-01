// MVA Intelligence — Finance-module
// Netlify Function: levert Grootboek detail + controletotalen uit het
// finance-schema van Supabase. Gebruikt de service-role-key (server-side,
// nooit in de browser). Gated met een eenvoudige token tot de centrale
// inlog erop zit.
//
// Vereiste Netlify environment variables:
//   SUPABASE_URL          bv. https://ehqtyhoeubchcwfavdzr.supabase.co
//   SUPABASE_SERVICE_KEY  de service-role / secret key (NIET de publishable)
//   FINANCE_TOKEN         vrij te kiezen wachtwoord voor toegang tot deze pagina
//
// Vereist ook: schema "finance" toegevoegd aan Exposed schemas (API-settings).

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
  if (!FINANCE_TOKEN || token !== FINANCE_TOKEN) {
    return json(401, cors, { error: "Geen toegang." });
  }

  const base = SUPABASE_URL.replace(/\/+$/, "") + "/rest/v1";
  const headers = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: "Bearer " + SUPABASE_SERVICE_KEY,
    "Accept-Profile": "finance",
  };

  try {
    const [gdRes, ctRes] = await Promise.all([
      fetch(`${base}/grootboek_detail?select=*&order=entiteit.asc,gb_nr.asc`, { headers }),
      fetch(`${base}/controle_eindtotalen?select=*`, { headers }),
    ]);
    if (!gdRes.ok) throw new Error("grootboek_detail " + gdRes.status + ": " + (await gdRes.text()));
    if (!ctRes.ok) throw new Error("controle_eindtotalen " + ctRes.status + ": " + (await ctRes.text()));

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
