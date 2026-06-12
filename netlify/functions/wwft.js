// netlify/functions/wwft.js
// ─────────────────────────────────────────────────────────────────────────────
// Backend voor de WWFT-module van de MVA Finance app.
// Versie 2 — 12 juni 2026: nieuwe architectuur (één lijst, drie kenmerken,
// rolverdeling makelaar/Monique). Backward compatible met bestaande actions.
//
// Actions:
//   lijst                → alle wwft_zaken (Monique/directie) of eigen zaken
//   status               → eigen_klant_status / wederpartij_status op facturen (legacy)
//   notitie              → wwft_notitie op facturen (legacy)
//   otd_status           → status op wwft_zaken
//   otd_notitie          → wwft_notitie op wwft_zaken
//   otd_aanwezig         → otd_aanwezig vinkje
//   otd_vinkje           → eigen_klant_ok / wederpartij_ok (legacy vinkjes)
//   otd_doorbelast       → doorbelast vinkje
//   wwft_op_slot         → zet op_slot=true bij factuurkoppeling (door sync-fin)
//   override             → Monique overschrijft makelaar-vinkjes
//   mail_makelaar        → Monique stuurt mail naar makelaar vanuit app
//   archiveer            → zaak op status=afgerond zetten
//   directie_notitie     → Monique's notitie per zaak
//
// Vereiste env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY           = process.env.RESEND_API_KEY;
const MAIL_VAN             = 'WWFT <noreply@makelaarsvan.nl>';

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

const TOEGESTANE_VELDEN  = ['eigen_klant_status', 'wederpartij_status'];
const TOEGESTANE_WAARDEN = ['open', 'ja', 'nee', 'weigert'];
const WWFT_EIGEN_DOSSIERS_PILOT = [7];

const SELECT_VELDEN =
  'factuurnummer,datum,transportdatum,type,relatie,adres,betreft,afdeling,' +
  'bedrag_incl,eigen_klant_status,wederpartij_status,wwft_notitie,wwft_actueel,is_courtagenota,makelaar_id';

const OTD_SELECT =
  'id,bron,otd_dossier_id,factuur_id,object_adres,documenttype,makelaar_email,makelaar_naam,' +
  'opdrachtgevers,aantal_personen,status,wwft_notitie,doorbelast,ondertekend_op,toegewezen_aan,' +
  'otd_aanwezig,otd_ontbreekt,eigen_klant_ok,wederpartij_ok,' +
  'wwft_uitgevoerd,wwft_bewijs_urls,op_slot,directie_notitie,mail_verstuurd_op';

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
  const eigenDossiers    = WWFT_EIGEN_DOSSIERS_PILOT.map(Number).includes(Number(gebruiker.id));
  if (!volledigeToegang && !eigenDossiers) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Geen toegang tot de WWFT-module' }) };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ongeldige JSON' }) }; }

  const { action } = payload;

  try {

    // ── lijst ────────────────────────────────────────────────────────────────
    if (action === 'lijst') {
      // Legacy facturen-lijst (voor backward compat)
      let path = `facturen?select=${SELECT_VELDEN}&wwft_actueel=eq.true`;
      if (!volledigeToegang) path += `&makelaar_id=eq.${gebruiker.id}`;
      path += `&order=datum.desc.nullslast,factuurnummer.desc`;
      const rows = await sb.get(path);

      const ids = [...new Set(rows.map(r => r.makelaar_id).filter(Boolean))];
      if (ids.length) {
        const gs = await sb.get(`gebruikers?select=id,naam&id=in.(${ids.join(',')})`);
        const naamVan = {};
        for (const g of gs) naamVan[g.id] = g.naam;
        for (const r of rows) r.makelaar_naam = naamVan[r.makelaar_id] || null;
      }

      // Nieuwe wwft_zaken lijst
      let otdPath = `wwft_zaken?select=${OTD_SELECT}&order=ondertekend_op.desc.nullslast`;
      if (!volledigeToegang) {
        otdPath += `&makelaar_email=eq.${encodeURIComponent(gebruiker.email || '')}`;
      }
      let otdZaken = [];
      try { otdZaken = await sb.get(otdPath); } catch (e) { otdZaken = []; }

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, zaken: rows, otd_zaken: otdZaken, readonly: !volledigeToegang }) };
    }

    // ── wwft_op_slot — factuur gekoppeld, zaak op slot ───────────────────────
    if (action === 'wwft_op_slot') {
      // Mag door service-key calls (sync-fin op droplet) of volledigeToegang
      if (!volledigeToegang) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Geen toegang' }) };
      }
      const { id, factuur_id } = payload;
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id vereist' }) };

      const updateData = { op_slot: true, bijgewerkt_op: new Date().toISOString() };
      if (factuur_id) updateData.factuur_id = factuur_id;

      const resultaat = await sb.patch(`wwft_zaken?id=eq.${encodeURIComponent(id)}`, updateData);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, zaak: resultaat[0] }) };
    }

    // ── override — Monique overschrijft makelaar-vinkjes ─────────────────────
    if (action === 'override') {
      if (!volledigeToegang) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Alleen compliance/directie' }) };
      }
      const { id, veld, waarde } = payload;
      const OVERRIDE_VELDEN = ['wwft_uitgevoerd', 'otd_aanwezig', 'eigen_klant_ok', 'wederpartij_ok'];
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id vereist' }) };
      if (!OVERRIDE_VELDEN.includes(veld)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: `Ongeldig veld: ${veld}` }) };
      }
      const resultaat = await sb.patch(
        `wwft_zaken?id=eq.${encodeURIComponent(id)}`,
        { [veld]: !!waarde, bijgewerkt_op: new Date().toISOString() }
      );
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, zaak: resultaat[0] }) };
    }

    // ── directie_notitie ─────────────────────────────────────────────────────
    if (action === 'directie_notitie') {
      if (!volledigeToegang) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Alleen compliance/directie' }) };
      }
      const { id } = payload;
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id vereist' }) };
      const notitie = (payload.waarde == null ? '' : String(payload.waarde)).slice(0, 2000);
      const resultaat = await sb.patch(
        `wwft_zaken?id=eq.${encodeURIComponent(id)}`,
        { directie_notitie: notitie, bijgewerkt_op: new Date().toISOString() }
      );
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, zaak: resultaat[0] }) };
    }

    // ── mail_makelaar — Monique stuurt mail vanuit app ────────────────────────
    if (action === 'mail_makelaar') {
      if (!volledigeToegang) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Alleen compliance/directie' }) };
      }
      if (!RESEND_KEY) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'RESEND_API_KEY niet ingesteld' }) };
      }
      const { id, makelaar_email, makelaar_naam, object_adres, bericht } = payload;
      if (!id || !makelaar_email || !bericht) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'id, makelaar_email en bericht vereist' }) };
      }

      const mailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: MAIL_VAN,
          to: makelaar_email,
          subject: `WWFT-dossier: ${object_adres || 'onbekend adres'}`,
          html: `<p>Hoi ${makelaar_naam || ''},</p>
<p>${bericht.replace(/\n/g, '<br>')}</p>
<p>Met vriendelijke groet,<br>Monique Klaver<br>Makelaars van Amsterdam</p>`,
        }),
      });

      if (!mailRes.ok) {
        const err = await mailRes.text();
        return { statusCode: 500, headers, body: JSON.stringify({ error: `Mail mislukt: ${err}` }) };
      }

      // Log tijdstip
      await sb.patch(
        `wwft_zaken?id=eq.${encodeURIComponent(id)}`,
        { mail_verstuurd_op: new Date().toISOString(), bijgewerkt_op: new Date().toISOString() }
      );

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    // ── archiveer ─────────────────────────────────────────────────────────────
    if (action === 'archiveer') {
      if (!volledigeToegang) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Alleen compliance/directie' }) };
      }
      const { id } = payload;
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id vereist' }) };
      const resultaat = await sb.patch(
        `wwft_zaken?id=eq.${encodeURIComponent(id)}`,
        { status: 'afgerond', bijgewerkt_op: new Date().toISOString() }
      );
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, zaak: resultaat[0] }) };
    }

    // ── Legacy actions (ongewijzigd) ─────────────────────────────────────────
    if (action === 'status') {
      if (!volledigeToegang) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Alleen directie en compliance' }) };
      }
      const { factuurnummer, veld, waarde } = payload;
      if (!factuurnummer) return { statusCode: 400, headers, body: JSON.stringify({ error: 'factuurnummer vereist' }) };
      if (!TOEGESTANE_VELDEN.includes(veld))   return { statusCode: 400, headers, body: JSON.stringify({ error: `Ongeldig veld: ${veld}` }) };
      if (!TOEGESTANE_WAARDEN.includes(waarde)) return { statusCode: 400, headers, body: JSON.stringify({ error: `Ongeldige waarde: ${waarde}` }) };
      const resultaat = await sb.patch(
        `facturen?factuurnummer=eq.${encodeURIComponent(factuurnummer)}&wwft_actueel=eq.true`,
        { [veld]: waarde, bijgewerkt_op: new Date().toISOString() }
      );
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, zaak: resultaat[0] }) };
    }

    if (action === 'notitie') {
      if (!volledigeToegang) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Alleen directie en compliance' }) };
      }
      const { factuurnummer } = payload;
      if (!factuurnummer) return { statusCode: 400, headers, body: JSON.stringify({ error: 'factuurnummer vereist' }) };
      const notitie = (payload.waarde == null ? '' : String(payload.waarde)).slice(0, 2000);
      const resultaat = await sb.patch(
        `facturen?factuurnummer=eq.${encodeURIComponent(factuurnummer)}&wwft_actueel=eq.true`,
        { wwft_notitie: notitie, bijgewerkt_op: new Date().toISOString() }
      );
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, zaak: resultaat[0] }) };
    }

    if (action === 'otd_status') {
      if (!volledigeToegang) return { statusCode: 403, headers, body: JSON.stringify({ error: 'Alleen directie en compliance' }) };
      const { id, waarde } = payload;
      const OTD_STATUSSEN = ['te_starten', 'gestart', 'afgerond'];
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id vereist' }) };
      if (!OTD_STATUSSEN.includes(waarde)) return { statusCode: 400, headers, body: JSON.stringify({ error: `Ongeldige waarde: ${waarde}` }) };
      const resultaat = await sb.patch(`wwft_zaken?id=eq.${encodeURIComponent(id)}`, { status: waarde, bijgewerkt_op: new Date().toISOString() });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, zaak: resultaat[0] }) };
    }

    if (action === 'otd_notitie') {
      if (!volledigeToegang) return { statusCode: 403, headers, body: JSON.stringify({ error: 'Alleen directie en compliance' }) };
      const { id } = payload;
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id vereist' }) };
      const notitie = (payload.waarde == null ? '' : String(payload.waarde)).slice(0, 2000);
      const resultaat = await sb.patch(`wwft_zaken?id=eq.${encodeURIComponent(id)}`, { wwft_notitie: notitie, bijgewerkt_op: new Date().toISOString() });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, zaak: resultaat[0] }) };
    }

    if (action === 'otd_aanwezig') {
      if (!volledigeToegang) return { statusCode: 403, headers, body: JSON.stringify({ error: 'Alleen directie en compliance' }) };
      const { id, waarde } = payload;
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id vereist' }) };
      const resultaat = await sb.patch(`wwft_zaken?id=eq.${encodeURIComponent(id)}`, { otd_aanwezig: waarde === true || waarde === 'true', bijgewerkt_op: new Date().toISOString() });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, zaak: resultaat[0] }) };
    }

    if (action === 'otd_vinkje') {
      if (!volledigeToegang) return { statusCode: 403, headers, body: JSON.stringify({ error: 'Alleen directie en compliance' }) };
      const { id, veld, waarde } = payload;
      const TOEGESTANE_VINKJES = ['eigen_klant_ok', 'wederpartij_ok'];
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id vereist' }) };
      if (!TOEGESTANE_VINKJES.includes(veld)) return { statusCode: 400, headers, body: JSON.stringify({ error: `Ongeldig veld: ${veld}` }) };
      const resultaat = await sb.patch(`wwft_zaken?id=eq.${encodeURIComponent(id)}`, { [veld]: !!waarde, bijgewerkt_op: new Date().toISOString() });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, zaak: resultaat[0] }) };
    }

    if (action === 'otd_doorbelast') {
      if (!volledigeToegang) return { statusCode: 403, headers, body: JSON.stringify({ error: 'Alleen directie en compliance' }) };
      const { id, waarde } = payload;
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id vereist' }) };
      const resultaat = await sb.patch(`wwft_zaken?id=eq.${encodeURIComponent(id)}`, { doorbelast: !!waarde, bijgewerkt_op: new Date().toISOString() });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, zaak: resultaat[0] }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: `Onbekende action: ${action}` }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
