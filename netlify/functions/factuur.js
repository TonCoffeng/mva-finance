// netlify/functions/factuur.js
// ─────────────────────────────────────────────────────────────────────────────
// Backend voor de Facturatie-module van de MVA Finance app.
// Versie 1 — 13 juni 2026: eigen facturatie ter vervanging van Effytool.
//
// Actions:
//   basisdata        → actieve administraties + producten (voor de dropdowns)
//   concept_lijst    → eigen (bron=eigen) facturen, nieuwste eerst
//   concept_laden    → één factuur + bijbehorende regels
//   concept_opslaan  → nieuwe of bestaande conceptfactuur + regels opslaan (geen nummer)
//   accorderen       → conceptfactuur definitief maken: sluitend factuurnummer via
//                      de DB-functie volgend_factuurnummer(), status + accordeervelden
//   concept_verwijderen → conceptfactuur (en regels) weggooien — alleen vóór accorderen
//
// Nummering: een concept heeft GEEN nummer. Pas bij accorderen wordt via de
// atomaire DB-functie het volgende sluitende nummer per administratie/jaar uitgegeven.
//
// Vereiste env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

// Makelaars die (naast directie/compliance) mogen meetesten met facturatie.
const FACTUUR_PILOT = [7]; // Rogier de Vries

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
  async post(path, body, prefer = 'return=representation') {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method: 'POST',
      headers: { ...this.headers, Prefer: prefer },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Supabase POST ${path} → ${r.status}: ${await r.text()}`);
    const txt = await r.text();
    return txt ? JSON.parse(txt) : null;
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
  async del(path) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method: 'DELETE',
      headers: { ...this.headers, Prefer: 'return=minimal' },
    });
    if (!r.ok) throw new Error(`Supabase DELETE ${path} → ${r.status}: ${await r.text()}`);
    return true;
  },
  async rpc(fn, args) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(args),
    });
    if (!r.ok) throw new Error(`Supabase RPC ${fn} → ${r.status}: ${await r.text()}`);
    return r.json();
  },
};

async function verifieerGebruiker(token) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const user = await r.json();
  if (!user || !user.id) return null;
  const rows = await sb.get(`gebruikers?select=id,rol,actief,email,naam&auth_uuid=eq.${user.id}&limit=1`);
  const g = rows && rows[0];
  if (!g || g.actief === false) return null;
  return g;
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Bereken regel- en factuurtotalen uit ingevoerde regels (incl-bedragen per stuk).
// Autoritatief in de backend — de client toont alleen een voorbeeld.
function verwerkRegels(regels) {
  const verwerkt = [];
  let totExcl = 0, totBtw = 0, totIncl = 0;
  (regels || []).forEach((r, i) => {
    const btw       = Number(r.btw_tarief != null ? r.btw_tarief : 21);
    const aantal    = Number(r.aantal || 1);
    const prijsIncl = Number(r.prijs_incl || 0);          // per stuk, incl btw
    const prijsExcl = round2(prijsIncl / (1 + btw / 100)); // per stuk, excl btw
    const regelIncl = round2(aantal * prijsIncl);
    const regelExcl = round2(regelIncl / (1 + btw / 100));
    const regelBtw  = round2(regelIncl - regelExcl);
    totExcl += regelExcl; totBtw += regelBtw; totIncl += regelIncl;
    verwerkt.push({
      product_id:   r.product_id || null,
      omschrijving: String(r.omschrijving || '').slice(0, 300),
      aantal,
      prijs_excl:   prijsExcl,
      btw_tarief:   btw,
      bedrag_excl:  regelExcl,
      btw_bedrag:   regelBtw,
      bedrag_incl:  regelIncl,
      gb_rekening:  r.gb_rekening || null,
      btw_code:     r.btw_code || null,
      sortering:    i,
    });
  });
  return { regels: verwerkt, totExcl: round2(totExcl), totBtw: round2(totBtw), totIncl: round2(totIncl) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST vereist' }) };

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase-config ontbreekt' }) };
  }

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Niet ingelogd' }) };
  const gebruiker = await verifieerGebruiker(token);
  if (!gebruiker) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Sessie ongeldig of verlopen' }) };

  const volledigeToegang = gebruiker.rol === 'directie' || gebruiker.rol === 'compliance';
  const pilot            = FACTUUR_PILOT.map(Number).includes(Number(gebruiker.id));
  if (!volledigeToegang && !pilot) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Geen toegang tot de facturatie-module' }) };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ongeldige JSON' }) }; }

  const { action } = payload;

  const FACTUUR_VELDEN =
    'id,factuurnummer,datum,soort,type,relatie,adres,betreft,notaris,betaalconditie,' +
    'bedrag_excl,btw,bedrag_incl,status,opmaker,geaccordeerd,geaccordeerd_op,accordeerder,' +
    'administratie_id,is_courtagenota,factuurcategorie,makelaar_id,bron,aangemaakt_op';

  try {

    // ── basisdata ─────────────────────────────────────────────────────────────
    if (action === 'basisdata') {
      const administraties = await sb.get(
        'administraties?select=id,prefix,naam,entiteit,betaalconditie,makelaar_id&actief=eq.true&order=naam.asc'
      );
      const producten = await sb.get(
        'producten?select=id,tier,naam,sectie,markering,prijs_incl,btw_tarief,is_courtage,variabel,is_pakket&actief=eq.true&order=is_courtage.desc,sortering.asc'
      );
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, administraties, producten }) };
    }

    // ── concept_lijst ───────────────────────────────────────────────────────────
    if (action === 'concept_lijst') {
      const rows = await sb.get(
        `facturen?select=${FACTUUR_VELDEN}&bron=eq.eigen&order=aangemaakt_op.desc&limit=100`
      );
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, facturen: rows }) };
    }

    // ── concept_laden ────────────────────────────────────────────────────────────
    if (action === 'concept_laden') {
      const { factuur_id } = payload;
      if (!factuur_id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'factuur_id vereist' }) };
      const fr = await sb.get(`facturen?select=${FACTUUR_VELDEN}&id=eq.${encodeURIComponent(factuur_id)}&bron=eq.eigen&limit=1`);
      const factuur = fr && fr[0];
      if (!factuur) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Factuur niet gevonden' }) };
      const regels = await sb.get(
        `factuur_regels?select=*&factuur_id=eq.${encodeURIComponent(factuur_id)}&order=sortering.asc`
      );
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, factuur, regels }) };
    }

    // ── concept_opslaan ───────────────────────────────────────────────────────────
    if (action === 'concept_opslaan') {
      const { factuur_id, administratie_id, soort, relatie, adres, betreft, notaris, betaalconditie } = payload;
      if (!administratie_id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Kies een administratie' }) };
      if (!relatie || !String(relatie).trim()) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Relatie (debiteur) is verplicht' }) };

      // Administratie ophalen voor makelaar_id-koppeling
      const ar = await sb.get(`administraties?select=id,prefix,makelaar_id&id=eq.${encodeURIComponent(administratie_id)}&limit=1`);
      const adm = ar && ar[0];
      if (!adm) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Onbekende administratie' }) };

      const { regels, totExcl, totBtw, totIncl } = verwerkRegels(payload.regels);
      if (!regels.length) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Voeg minstens één factuurregel toe' }) };

      const heeftCourtage = (payload.regels || []).some(r => r.is_courtage);
      const kop = {
        administratie_id: Number(administratie_id),
        soort:            soort === 'Aankoop' ? 'Aankoop' : 'Verkoop',
        relatie:          String(relatie).slice(0, 200),
        adres:            adres ? String(adres).slice(0, 200) : null,
        betreft:          betreft ? String(betreft).slice(0, 300) : null,
        notaris:          notaris ? String(notaris).slice(0, 200) : null,
        betaalconditie:   betaalconditie ? String(betaalconditie).slice(0, 200) : null,
        bedrag_excl:      totExcl,
        btw:              totBtw,
        bedrag_incl:      totIncl,
        type:             '00ALGEM Courtagenota',
        is_courtagenota:  heeftCourtage,
        factuurcategorie: heeftCourtage ? 'courtagenota' : 'overig',
        status:           'concept',
        bron:             'eigen',
        opmaker:          gebruiker.naam || gebruiker.email || null,
        makelaar_id:      adm.makelaar_id || null,
        bijgewerkt_op:    new Date().toISOString(),
      };

      let factuur;
      if (factuur_id) {
        // Bestaand concept bijwerken — mag alleen zolang het nog concept is
        const best = await sb.get(`facturen?select=id,status,bron&id=eq.${encodeURIComponent(factuur_id)}&limit=1`);
        const b = best && best[0];
        if (!b || b.bron !== 'eigen') return { statusCode: 404, headers, body: JSON.stringify({ error: 'Factuur niet gevonden' }) };
        if (b.status !== 'concept')   return { statusCode: 409, headers, body: JSON.stringify({ error: 'Deze factuur is al geaccordeerd en kan niet meer gewijzigd worden' }) };
        const upd = await sb.patch(`facturen?id=eq.${encodeURIComponent(factuur_id)}`, kop);
        factuur = upd[0];
        await sb.del(`factuur_regels?factuur_id=eq.${encodeURIComponent(factuur_id)}`);
      } else {
        kop.aangemaakt_op = new Date().toISOString();
        const ins = await sb.post('facturen', kop);
        factuur = Array.isArray(ins) ? ins[0] : ins;
      }

      const regelsMetId = regels.map(r => ({ ...r, factuur_id: factuur.id }));
      await sb.post('factuur_regels', regelsMetId, 'return=minimal');

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, factuur_id: factuur.id, totalen: { totExcl, totBtw, totIncl } }) };
    }

    // ── accorderen ─────────────────────────────────────────────────────────────
    if (action === 'accorderen') {
      const { factuur_id } = payload;
      if (!factuur_id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'factuur_id vereist' }) };

      const fr = await sb.get(`facturen?select=id,status,bron,administratie_id,factuurnummer&id=eq.${encodeURIComponent(factuur_id)}&limit=1`);
      const f = fr && fr[0];
      if (!f || f.bron !== 'eigen') return { statusCode: 404, headers, body: JSON.stringify({ error: 'Factuur niet gevonden' }) };
      if (f.status !== 'concept')   return { statusCode: 409, headers, body: JSON.stringify({ error: 'Deze factuur is al geaccordeerd' }) };
      if (!f.administratie_id)      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Geen administratie gekoppeld' }) };

      const nu   = new Date();
      const jaar = nu.getFullYear();

      // Sluitend nummer ophalen via de atomaire DB-functie
      const nummer = await sb.rpc('volgend_factuurnummer', { p_administratie_id: f.administratie_id, p_jaar: jaar });
      if (!nummer || typeof nummer !== 'string') {
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Kon geen factuurnummer toekennen' }) };
      }

      const upd = await sb.patch(`facturen?id=eq.${encodeURIComponent(factuur_id)}&status=eq.concept`, {
        factuurnummer:  nummer,
        status:         'geaccordeerd',
        geaccordeerd:   true,
        geaccordeerd_op: nu.toISOString(),
        accordeerder:   gebruiker.naam || gebruiker.email || null,
        datum:          nu.toISOString(),
        wwft_actueel:   true,
        bijgewerkt_op:  nu.toISOString(),
      });

      if (!upd || !upd.length) {
        return { statusCode: 409, headers, body: JSON.stringify({ error: 'Factuur was net al geaccordeerd' }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, factuur: upd[0] }) };
    }

    // ── concept_verwijderen ──────────────────────────────────────────────────────
    if (action === 'concept_verwijderen') {
      const { factuur_id } = payload;
      if (!factuur_id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'factuur_id vereist' }) };
      const fr = await sb.get(`facturen?select=id,status,bron&id=eq.${encodeURIComponent(factuur_id)}&limit=1`);
      const f = fr && fr[0];
      if (!f || f.bron !== 'eigen') return { statusCode: 404, headers, body: JSON.stringify({ error: 'Factuur niet gevonden' }) };
      if (f.status !== 'concept')   return { statusCode: 409, headers, body: JSON.stringify({ error: 'Alleen concepten kunnen verwijderd worden' }) };
      await sb.del(`factuur_regels?factuur_id=eq.${encodeURIComponent(factuur_id)}`);
      await sb.del(`facturen?id=eq.${encodeURIComponent(factuur_id)}`);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: `Onbekende action: ${action}` }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
