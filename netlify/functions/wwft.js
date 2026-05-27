// netlify/functions/wwft.js
// ─────────────────────────────────────────────────────────────────────────────
// Backend voor de WWFT-module van de MVA Finance app.
// Leest/schrijft de tabel facturen in Supabase (service-key server-side).
//
// Eén endpoint, action-gebaseerd (zoals kosten.js):
//   { action: 'lijst' }                                  → actuele WWFT-zaken (courtagenota's, wwft_actueel=true)
//   { action: 'status', factuurnummer, veld, waarde }    → één statusveld bijwerken
//
// Toegestane velden bij 'status': 'eigen_klant_status' | 'wederpartij_status'
// Toegestane waarden: 'open' | 'ja' | 'nee' | 'weigert'
//
// Vereiste env vars (in het mva-finance Netlify-project):
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

const sb = {
  headers: {
    apikey:         SUPABASE_SERVICE_KEY,
    Authorization:  `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  },
  async get(path) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: this.headers });
    if (!r.ok) throw new Error(`Supabase GET ${path} → ${r.status}: ${await r.text()}`);
    return r.json();
  },
  async patch(path, body) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method: 'PATCH',
      headers: { ...this.headers, Prefer: 'return=representation' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Supabase PATCH ${path} → ${r.status}: ${await r.text()}`);
    return r.json();
  },
};

const TOEGESTANE_VELDEN  = ['eigen_klant_status', 'wederpartij_status'];
const TOEGESTANE_WAARDEN = ['open', 'ja', 'nee', 'weigert'];

// Welke kolommen de WWFT-pagina nodig heeft (geen ruwe_mail e.d.)
const SELECT_VELDEN =
  'factuurnummer,datum,transportdatum,type,relatie,adres,betreft,afdeling,' +
  'bedrag_incl,eigen_klant_status,wederpartij_status,wwft_actueel,is_courtagenota';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST vereist' }) };

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase-config ontbreekt (env vars)' }) };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ongeldige JSON' }) }; }

  const { action } = payload;

  try {
    if (action === 'lijst') {
      // Alleen actuele WWFT-zaken: courtagenota's die op de werklijst staan.
      const path =
        `facturen?select=${SELECT_VELDEN}` +
        `&wwft_actueel=eq.true` +
        `&order=datum.desc.nullslast,factuurnummer.desc`;
      const rows = await sb.get(path);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, zaken: rows }) };
    }

    if (action === 'status') {
      const { factuurnummer, veld, waarde } = payload;
      if (!factuurnummer) return { statusCode: 400, headers, body: JSON.stringify({ error: 'factuurnummer vereist' }) };
      if (!TOEGESTANE_VELDEN.includes(veld))  return { statusCode: 400, headers, body: JSON.stringify({ error: `Ongeldig veld: ${veld}` }) };
      if (!TOEGESTANE_WAARDEN.includes(waarde)) return { statusCode: 400, headers, body: JSON.stringify({ error: `Ongeldige waarde: ${waarde}` }) };

      const data = { [veld]: waarde, bijgewerkt_op: new Date().toISOString() };
      const resultaat = await sb.patch(
        `facturen?factuurnummer=eq.${encodeURIComponent(factuurnummer)}&wwft_actueel=eq.true`,
        data
      );
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, zaak: resultaat[0] }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: `Onbekende action: ${action}` }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
