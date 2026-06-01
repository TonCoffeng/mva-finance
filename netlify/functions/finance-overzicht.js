// MVA Intelligence — Finance-module
// Netlify Function: overzichtscijfers (alleen vaststaande, gecontroleerde bronnen).
// Realisatie sluit op €0,00 (SnelStart); begroting sluit op €45.466.
// Vereiste env var: FINANCE_TOKEN
const DATA = {
  realisatie: {
    "2025": { pro: 67112.07, vgz: 17150.72, peil: "2025-12-31" },
    "ytd":  { pro: 17483.73, vgz: -36759.86, peil: "2026-05-29" }
  },
  begroting: { "2026": { pro: 11555.67, vgz: 33910.35 } }
};
exports.handler = async (event) => {
  const cors = { "Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"x-finance-token, content-type","Access-Control-Allow-Methods":"GET, OPTIONS" };
  if (event.httpMethod === "OPTIONS") return { statusCode:204, headers:cors };
  const { FINANCE_TOKEN } = process.env;
  const token = event.headers["x-finance-token"] || event.headers["X-Finance-Token"];
  if (!FINANCE_TOKEN || token !== FINANCE_TOKEN) return json(401, cors, { error:"Geen toegang." });
  return json(200, cors, { ...DATA, generated_at:new Date().toISOString() });
};
function json(s,c,b){ return { statusCode:s, headers:{...c,"content-type":"application/json; charset=utf-8"}, body:JSON.stringify(b) }; }
