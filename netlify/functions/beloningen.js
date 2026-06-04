// netlify/functions/beloningen.js
// ─────────────────────────────────────────────────────────────────────────────
// Backend voor de Beloningen-module van de MVA Finance app.
// €175-verrekening voor de gevende makelaar bij een geslaagde doorgegeven lead.
//
// Matchketen (bewezen 28 mei 2026):
//   bellijst_items (bron='pool', lead_status='deal')
//     → bezichtiging_id → bezichtigingen.gevende_makelaar_id
//       → gebruikers.naam  = de makelaar die €175 krijgt
//
// Hypotheek-beloning (€650):
//   hypotheek_doorverwijzingen (gevende_makelaar_id) → gebruikers.naam = makelaar die €650 krijgt
//   Trigger = de doorverwijzing zelf (lead doorgegeven aan de Hypotheekshop).
//   Ontdubbeld op beloningen.hypotheek_doorverwijzing_id.
//
// Eén endpoint, action-gebaseerd (zoals wwft.js / kosten.js):
//   { action: 'scan' }                         → maak concept-beloningen voor nieuwe pool-deals, geef daarna de lijst
//   { action: 'lijst' }                        → alle beloningen
//   { action: 'status', id, status }           → status bijwerken (concept/bevestigd/uitbetaald/vervallen)
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
  async post(path, body) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method: 'POST',
      headers: { ...this.headers, Prefer: 'return=representation,resolution=ignore-duplicates' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Supabase POST ${path} → ${r.status}: ${await r.text()}`);
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

const TOEGESTANE_STATUS = ['concept', 'bevestigd', 'uitbetaald', 'vervallen'];

// Maak concept-beloningen voor pool-leads die op 'deal' staan en nog geen beloning hebben.
// Bewust in losse stappen (geen embedded join), zodat het werkt ongeacht of er
// foreign-key-relaties in de database gedefinieerd zijn.
async function scanNieuweDeals() {
  // 1. Pool-deals met een bezichtiging
  // lead_status kan 'Deal' of 'deal' zijn → hoofdletter-ongevoelig matchen via ilike
  const leads = await sb.get(
    'bellijst_items?select=id,bezichtiger_naam,bezichtiger_email,adres,bezichtiging_id' +
    '&bron=eq.pool&lead_status=ilike.deal&bezichtiging_id=not.is.null'
  );
  if (!leads.length) return 0;

  // 2. Welke bellijst_item_ids hebben al een €175-beloning? (niet dubbel aanmaken)
  //    Type-scoped: een hypotheek-beloning op hetzelfde bellijst_item mag een €175 niet blokkeren.
  const bestaand = await sb.get('beloningen?select=bellijst_item_id&type=eq.lead_175');
  const alGehad = new Set(bestaand.map(b => b.bellijst_item_id));

  const teVerwerken = leads.filter(l => !alGehad.has(l.id));
  if (!teVerwerken.length) return 0;

  // 3. Bijbehorende bezichtigingen ophalen (voor gevende_makelaar_id)
  const bzIds = [...new Set(teVerwerken.map(l => l.bezichtiging_id))];
  const bezichtigingen = await sb.get(
    `bezichtigingen?select=id,gevende_makelaar_id&id=in.(${bzIds.join(',')})`
  );
  const bzMap = new Map(bezichtigingen.map(b => [b.id, b.gevende_makelaar_id]));

  // 4. Makelaarsnamen ophalen
  const makelaarIds = [...new Set(bezichtigingen.map(b => b.gevende_makelaar_id).filter(Boolean))];
  let naamMap = new Map();
  if (makelaarIds.length) {
    const gebruikers = await sb.get(`gebruikers?select=id,naam&id=in.(${makelaarIds.join(',')})`);
    naamMap = new Map(gebruikers.map(g => [g.id, g.naam]));
  }

  // 5. Concept-beloningen samenstellen
  const nieuwe = [];
  for (const l of teVerwerken) {
    const makelaarId = bzMap.get(l.bezichtiging_id);
    const makelaarNaam = makelaarId ? naamMap.get(makelaarId) : null;
    if (!makelaarId || !makelaarNaam) continue; // geen gevende makelaar bekend → overslaan
    nieuwe.push({
      type: 'lead_175',
      bedrag: 175.00,
      gevende_makelaar_id: makelaarId,
      gevende_makelaar: makelaarNaam,
      bellijst_item_id: l.id,
      bezichtiging_id: l.bezichtiging_id,
      klant_naam: l.bezichtiger_naam,
      klant_email: l.bezichtiger_email,
      adres: l.adres,
      status: 'concept',
    });
  }

  if (nieuwe.length) {
    await sb.post('beloningen', nieuwe);
  }
  return nieuwe.length;
}

// Maak concept-beloningen (€650) voor hypotheek-doorverwijzingen die nog geen beloning hebben.
// Trigger = de doorverwijzing zelf (lead doorgegeven aan de Hypotheekshop). Status-voortgang
// (concept → bevestigd → uitbetaald) gebeurt daarna handmatig in de app.
async function scanHypotheekDoorverwijzingen() {
  // 1. Doorverwijzingen mét gevende makelaar
  const verwijzingen = await sb.get(
    'hypotheek_doorverwijzingen?select=id,klant_naam,klant_email,type_advies,gevende_makelaar_id,gevende_makelaar_naam,bellijst_item_id,bezichtiging_id' +
    '&gevende_makelaar_id=not.is.null'
  );
  if (!verwijzingen.length) return 0;

  // 2. Welke doorverwijzingen hebben al een €650-beloning? (niet dubbel aanmaken)
  const bestaand = await sb.get('beloningen?select=hypotheek_doorverwijzing_id&type=eq.hypotheek_650');
  const alGehad = new Set(bestaand.map(b => b.hypotheek_doorverwijzing_id).filter(Boolean));

  const teVerwerken = verwijzingen.filter(v => !alGehad.has(v.id));
  if (!teVerwerken.length) return 0;

  // 3. Makelaarsnamen ophalen (autoritatief uit gebruikers, fallback op opgeslagen naam)
  const makelaarIds = [...new Set(teVerwerken.map(v => v.gevende_makelaar_id).filter(Boolean))];
  let naamMap = new Map();
  if (makelaarIds.length) {
    const gebruikers = await sb.get(`gebruikers?select=id,naam&id=in.(${makelaarIds.join(',')})`);
    naamMap = new Map(gebruikers.map(g => [g.id, g.naam]));
  }

  // 4. Concept-beloningen samenstellen
  const nieuwe = [];
  for (const v of teVerwerken) {
    const naam = naamMap.get(v.gevende_makelaar_id) || v.gevende_makelaar_naam;
    if (!v.gevende_makelaar_id || !naam) continue; // geen gevende makelaar bekend → overslaan
    nieuwe.push({
      type: 'hypotheek_650',
      bedrag: 650.00,
      gevende_makelaar_id: v.gevende_makelaar_id,
      gevende_makelaar: naam,
      hypotheek_doorverwijzing_id: v.id,
      bellijst_item_id: v.bellijst_item_id || null,
      bezichtiging_id: v.bezichtiging_id || null,
      klant_naam: v.klant_naam,
      klant_email: v.klant_email,
      opmerking: v.type_advies ? ('Hypotheekadvies: ' + v.type_advies) : null,
      status: 'concept',
    });
  }

  if (nieuwe.length) {
    await sb.post('beloningen', nieuwe);
  }
  return nieuwe.length;
}

async function haalLijst() {
  return sb.get('beloningen?select=*&order=aangemaakt_op.desc');
}

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
    if (action === 'scan') {
      const nieuwLead      = await scanNieuweDeals();
      const nieuwHypotheek = await scanHypotheekDoorverwijzingen();
      const beloningen = await haalLijst();
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, nieuw: nieuwLead + nieuwHypotheek, nieuw_lead: nieuwLead, nieuw_hypotheek: nieuwHypotheek, beloningen }) };
    }

    if (action === 'lijst') {
      const beloningen = await haalLijst();
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, beloningen }) };
    }

    if (action === 'status') {
      const { id, status } = payload;
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id vereist' }) };
      if (!TOEGESTANE_STATUS.includes(status)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: `Ongeldige status: ${status}` }) };
      }
      const data = { status, bijgewerkt_op: new Date().toISOString() };
      const res = await sb.patch(`beloningen?id=eq.${encodeURIComponent(id)}`, data);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, beloning: res[0] }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: `Onbekende action: ${action}` }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
