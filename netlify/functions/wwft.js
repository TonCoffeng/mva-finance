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
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

// Verifieer het Supabase-token van de aanroeper en haal de rol op uit gebruikers.
async function verifieerGebruiker(token) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const user = await r.json();
  if (!user || !user.id) return null;
  const rows = await sb.get(`gebruikers?select=id,rol,actief,email&auth_uuid=eq.${user.id}&limit=1`);
  const g = rows && rows[0];
  if (!g || g.actief === false) return null;
  return g;
}

const TOEGESTANE_VELDEN  = ['eigen_klant_status', 'wederpartij_status'];
const TOEGESTANE_WAARDEN = ['open', 'ja', 'nee', 'weigert'];

// Fase 2 — pilot: gebruiker-ids die hun EIGEN WWFT-zaken ALLEEN-LEZEN mogen inzien.
// Uitbreiden naar meer makelaars = id toevoegen aan deze lijst. (Rogier de Vries = 7)
const WWFT_EIGEN_DOSSIERS_PILOT = [7];

// Welke kolommen de WWFT-pagina nodig heeft (geen ruwe_mail e.d.)
const SELECT_VELDEN =
  'factuurnummer,datum,transportdatum,type,relatie,adres,betreft,afdeling,' +
  'bedrag_incl,eigen_klant_status,wederpartij_status,wwft_notitie,wwft_actueel,is_courtagenota,makelaar_id';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST vereist' }) };

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase-config ontbreekt (env vars)' }) };
  }

  // ── Toegang: token verifiëren + rol bepalen (server-side, niet te omzeilen) ──
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Niet ingelogd' }) };
  const gebruiker = await verifieerGebruiker(token);
  if (!gebruiker) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Sessie ongeldig of verlopen' }) };
  const volledigeToegang = gebruiker.rol === 'directie' || gebruiker.rol === 'compliance';
  const eigenDossiers    = WWFT_EIGEN_DOSSIERS_PILOT.map(Number).includes(Number(gebruiker.id));
  if (!volledigeToegang && !eigenDossiers) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Geen toegang tot de WWFT-module' }) };
  }
  // volledigeToegang → alle zaken + bewerken (directie, compliance)
  // eigenDossiers    → alleen eigen zaken (makelaar_id), alleen-lezen (pilot-makelaars)

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ongeldige JSON' }) }; }

  const { action } = payload;

  try {
    if (action === 'lijst') {
      // Alleen actuele WWFT-zaken: courtagenota's die op de werklijst staan.
      // Pilot-makelaars (geen volledige toegang) zien uitsluitend hun eigen zaken.
      let path =
        `facturen?select=${SELECT_VELDEN}` +
        `&wwft_actueel=eq.true`;
      if (!volledigeToegang) {
        path += `&makelaar_id=eq.${gebruiker.id}`;
      }
      path += `&order=datum.desc.nullslast,factuurnummer.desc`;
      const rows = await sb.get(path);

      // Makelaar-naam per zaak erbij (voor weergave + filter). Geen FK nodig: losse lookup.
      const ids = [...new Set(rows.map(r => r.makelaar_id).filter(Boolean))];
      if (ids.length) {
        const gs = await sb.get(`gebruikers?select=id,naam&id=in.(${ids.join(',')})`);
        const naamVan = {};
        for (const g of gs) naamVan[g.id] = g.naam;
        for (const r of rows) r.makelaar_naam = naamVan[r.makelaar_id] || null;
      }

      // OTD-zaken: automatisch aangemaakt door de Signhost-webhook bij ondertekening.
      let otdPath =
        'wwft_zaken?select=id,bron,otd_dossier_id,factuur_id,object_adres,documenttype,makelaar_email,makelaar_naam,' +
        'opdrachtgevers,aantal_personen,status,wwft_notitie,doorbelast,ondertekend_op,toegewezen_aan,' +
        'otd_aanwezig,otd_ontbreekt,eigen_klant_ok,wederpartij_ok' +
        '&order=ondertekend_op.desc.nullslast';
      if (!volledigeToegang) {
        otdPath += `&makelaar_email=eq.${encodeURIComponent(gebruiker.email || '')}`;
      }
      let otdZaken = [];
      try { otdZaken = await sb.get(otdPath); } catch (e) { otdZaken = []; }

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, zaken: rows, otd_zaken: otdZaken, readonly: !volledigeToegang }) };
    }

    if (action === 'status') {
      if (!volledigeToegang) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Alleen-lezen: alleen directie en compliance kunnen de WWFT-status wijzigen' }) };
      }
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

    if (action === 'notitie') {
      if (!volledigeToegang) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Alleen-lezen: alleen directie en compliance kunnen de WWFT-notitie wijzigen' }) };
      }
      const { factuurnummer } = payload;
      if (!factuurnummer) return { statusCode: 400, headers, body: JSON.stringify({ error: 'factuurnummer vereist' }) };
      const notitie = (payload.waarde == null ? '' : String(payload.waarde)).slice(0, 2000);

      const data = { wwft_notitie: notitie, bijgewerkt_op: new Date().toISOString() };
      const resultaat = await sb.patch(
        `facturen?factuurnummer=eq.${encodeURIComponent(factuurnummer)}&wwft_actueel=eq.true`,
        data
      );
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, zaak: resultaat[0] }) };
    }

    if (action === 'otd_status') {
      if (!volledigeToegang) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Alleen directie en compliance kunnen de status wijzigen' }) };
      }
      const { id, waarde } = payload;
      const OTD_STATUSSEN = ['te_starten', 'gestart', 'afgerond'];
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id vereist' }) };
      if (!OTD_STATUSSEN.includes(waarde)) return { statusCode: 400, headers, body: JSON.stringify({ error: `Ongeldige waarde: ${waarde}` }) };
      const resultaat = await sb.patch(
        `wwft_zaken?id=eq.${encodeURIComponent(id)}`,
        { status: waarde, bijgewerkt_op: new Date().toISOString() }
      );
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, zaak: resultaat[0] }) };
    }

    if (action === 'otd_notitie') {
      if (!volledigeToegang) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Alleen directie en compliance kunnen de notitie wijzigen' }) };
      }
      const { id } = payload;
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id vereist' }) };
      const notitie = (payload.waarde == null ? '' : String(payload.waarde)).slice(0, 2000);
      const resultaat = await sb.patch(
        `wwft_zaken?id=eq.${encodeURIComponent(id)}`,
        { wwft_notitie: notitie, bijgewerkt_op: new Date().toISOString() }
      );
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, zaak: resultaat[0] }) };
    }

    if (action === 'otd_aanwezig') {
      if (!volledigeToegang) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Alleen directie en compliance kunnen dit vinkje zetten' }) };
      }
      const { id, waarde } = payload;
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id vereist' }) };
      const resultaat = await sb.patch(
        `wwft_zaken?id=eq.${encodeURIComponent(id)}`,
        { otd_aanwezig: waarde === true || waarde === 'true', bijgewerkt_op: new Date().toISOString() }
      );
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, zaak: resultaat[0] }) };
    }

    if (action === 'otd_vinkje') {
      if (!volledigeToegang) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Alleen directie en compliance kunnen vinkjes zetten' }) };
      }
      const { id, veld, waarde } = payload;
      const TOEGESTANE_VINKJES = ['eigen_klant_ok', 'wederpartij_ok'];
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id vereist' }) };
      if (!TOEGESTANE_VINKJES.includes(veld)) return { statusCode: 400, headers, body: JSON.stringify({ error: `Ongeldig veld: ${veld}` }) };
      const resultaat = await sb.patch(
        `wwft_zaken?id=eq.${encodeURIComponent(id)}`,
        { [veld]: !!waarde, bijgewerkt_op: new Date().toISOString() }
      );
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, zaak: resultaat[0] }) };
    }

    if (action === 'otd_doorbelast') {
      if (!volledigeToegang) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Alleen directie en compliance kunnen doorbelasting afvinken' }) };
      }
      const { id, waarde } = payload;
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id vereist' }) };
      const resultaat = await sb.patch(
        `wwft_zaken?id=eq.${encodeURIComponent(id)}`,
        { doorbelast: !!waarde, bijgewerkt_op: new Date().toISOString() }
      );
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, zaak: resultaat[0] }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: `Onbekende action: ${action}` }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
