// Enable Banking → Supabase. GET ?conectar=BBVA&k=CLAVE abre el banco; el banco vuelve con ?code; POST con x-clave sincroniza.
import { createPrivateKey, sign } from 'node:crypto';
import { createClient } from 'npm:@supabase/supabase-js@2';

const API = 'https://api.enablebanking.com';
const SELF = 'https://sscjejofqqgyhrzgjsdf.supabase.co/functions/v1/banco';
const APP = 'https://dannyatvll.github.io/cuentas/';
const env = (k: string) => Deno.env.get(k) ?? '';
const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));
const PUB = 'sb_publishable_8arQCFyj2F-uAUeYQrN3WA_C7q8oood';

async function esDanny(clave: string | null) {
  if (!clave) return false;
  const c = createClient(env('SUPABASE_URL'), PUB, { global: { headers: { 'x-clave': clave } } });
  const { data } = await c.rpc('es_danny');
  return data === true;
}

const b64 = (b: Uint8Array | string) => btoa(typeof b === 'string' ? b : String.fromCharCode(...b)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

function jwt() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: env('EB_APP_ID').trim() }));
  const body = b64(JSON.stringify({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: now, exp: now + 3600 }));
  const key = createPrivateKey(env('EB_PRIVATE_KEY').replace(/\\n/g, '\n').trim());
  return `${head}.${body}.${b64(new Uint8Array(sign('sha256', new TextEncoder().encode(`${head}.${body}`), key)))}`;
}

async function eb(path: string, body?: unknown) {
  const r = await fetch(API + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${jwt()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${path} ${r.status}: ${t.slice(0, 300)}`);
  return JSON.parse(t);
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'x-clave, content-type' };
const volver = (q: string) => Response.redirect(`${APP}?banco=${encodeURIComponent(q)}`, 302);

async function conectar(banco: string) {
  const { aspsps } = await eb('/aspsps?country=ES');
  const a = aspsps.find((x: any) => x.name.toLowerCase() === banco.toLowerCase())
    ?? aspsps.find((x: any) => x.name.toLowerCase().includes(banco.toLowerCase()));
  if (!a) throw new Error(`No encuentro ${banco} en Enable Banking`);
  const secs = Math.min(a.maximum_consent_validity ?? 15552000, 180 * 86400);
  const r = await eb('/auth', {
    access: { valid_until: new Date(Date.now() + secs * 1000).toISOString() },
    aspsp: { name: a.name, country: a.country },
    state: banco,
    redirect_url: SELF,
    psu_type: 'personal',
  });
  return Response.redirect(r.url, 302);
}

async function callback(code: string, banco: string) {
  const s = await eb('/sessions', { code });
  await db.from('banco_sesiones').delete().eq('banco', banco).neq('id', s.session_id);
  await db.from('banco_sesiones').upsert({ id: s.session_id, banco, valido_hasta: s.access?.valid_until });
  const tarjetas = await db.from('banco_cuentas').select('cuenta_app').not('cuenta_app', 'is', null);
  const usadas = new Set((tarjetas.data ?? []).map((x: any) => x.cuenta_app));
  for (const ac of s.accounts ?? []) {
    const tipo = ac.cash_account_type ?? '';
    let cuenta_app: string | null = null;
    if (tipo === 'CARD' && /bbva/i.test(banco)) cuenta_app = 'Tarjeta crédito BBVA';
    else if (tipo !== 'CARD' && (ac.currency ?? 'EUR') === 'EUR' && !usadas.has(banco)) cuenta_app = banco;
    if (cuenta_app) usadas.add(cuenta_app);
    await db.from('banco_cuentas').upsert({
      uid: ac.uid, sesion: s.session_id, banco, tipo, cuenta_app,
      nombre: ac.name ?? ac.product ?? null,
      iban: ac.account_id?.iban ?? ac.account_id?.other?.identification ?? null,
    });
  }
  await sincronizar();
  return volver(`${banco} conectado`);
}

const lim = (s: string) => s.replace(/\s+/g, ' ').trim();

function texto(t: any) {
  const quien = t.credit_debit_indicator === 'DBIT' ? t.creditor?.name : t.debtor?.name;
  const info = (t.remittance_information ?? []).join(' ');
  return lim(quien || info || t.bank_transaction_code?.description || 'Movimiento');
}

async function sincronizar() {
  const { data: cuentas } = await db.from('banco_cuentas').select('*, banco_sesiones(valido_hasta)').not('cuenta_app', 'is', null);
  const { data: reglas } = await db.from('reglas').select('contiene, categoria').order('id', { ascending: false });
  const res: Record<string, unknown> = {};
  for (const c of cuentas ?? []) {
    try {
      if (c.banco_sesiones?.valido_hasta && new Date(c.banco_sesiones.valido_hasta) < new Date()) throw new Error('Permiso caducado');
      let desde = c.desde;
      if (!desde) {
        const { data: u } = await db.from('pagos').select('fecha').eq('cuenta', c.cuenta_app).not('origen', 'in', '("Apple Pay","Manual","Descuadre","Ajuste")').order('fecha', { ascending: false }).limit(1);
        desde = (u?.[0]?.fecha ?? new Date(Date.now() - 30 * 86400000).toISOString()).slice(0, 10);
      }
      const txs: any[] = [];
      let ck = '';
      do {
        const r = await eb(`/accounts/${c.uid}/transactions?date_from=${desde}${ck ? `&continuation_key=${encodeURIComponent(ck)}` : ''}`);
        txs.push(...(r.transactions ?? []));
        ck = r.continuation_key ?? '';
      } while (ck);
      const book = txs.filter(t => (t.status ?? 'BOOK') === 'BOOK');
      book.sort((a, b) => (a.booking_date ?? a.value_date).localeCompare(b.booking_date ?? b.value_date));

      const ini = new Date(new Date(desde).getTime() - 4 * 86400000).toISOString();
      const { data: prev } = await db.from('pagos').select('id, fecha, importe, ext_id').eq('cuenta', c.cuenta_app).gte('fecha', ini);
      const libres = (prev ?? []).filter((p: any) => !p.ext_id);
      const vistos = new Set((prev ?? []).map((p: any) => p.ext_id).filter(Boolean));
      const nuevos: any[] = [];
      let enlazados = 0;
      const rep: Record<string, number> = {};

      for (const t of book) {
        const dia = t.booking_date ?? t.value_date;
        const amt = Number(t.transaction_amount.amount);
        const imp = Math.round((t.credit_debit_indicator === 'DBIT' ? amt : -amt) * 100) / 100;
        const com = texto(t);
        let ext = t.entry_reference || t.transaction_id;
        if (!ext) { const k = `${dia}|${imp}|${com}`; rep[k] = (rep[k] ?? 0) + 1; ext = `${k}|${rep[k]}`; }
        ext = `${c.uid}:${ext}`;
        if (vistos.has(ext)) continue;
        vistos.add(ext);

        // Ya está en la app (Apple Pay, a mano o extracto): la enlazamos en vez de duplicarla
        const t0 = new Date(dia).getTime();
        const cand = libres.filter((p: any) => Math.abs(Number(p.importe) - imp) < 0.005 && Math.abs(new Date(p.fecha).getTime() - t0) <= 4 * 86400000)
          .sort((a: any, b: any) => Math.abs(new Date(a.fecha).getTime() - t0) - Math.abs(new Date(b.fecha).getTime() - t0));
        if (cand.length) {
          libres.splice(libres.indexOf(cand[0]), 1);
          await db.from('pagos').update({ ext_id: ext }).eq('id', cand[0].id);
          enlazados++;
          continue;
        }
        const lc = com.toLowerCase();
        let categoria = reglas?.find((r: any) => lc.includes(r.contiene))?.categoria ?? 'Sin categoría';
        if (imp < 0 && /sepe|prestaci[oó]n|n[oó]mina/.test(lc)) categoria = 'Ingreso';
        nuevos.push({
          fecha: `${dia}T12:00:00+02:00`, con_hora: false, comercio: com, cuenta: c.cuenta_app, origen: c.banco,
          importe: categoria === 'Ingreso' ? Math.abs(imp) : imp, categoria, ext_id: ext,
          importe_original: t.transaction_amount.currency !== 'EUR' ? `${amt} ${t.transaction_amount.currency}` : null,
        });
      }
      if (nuevos.length) { const { error } = await db.from('pagos').insert(nuevos); if (error) throw error; }

      const { balances } = await eb(`/accounts/${c.uid}/balances`);
      const pref = ['ITAV', 'CLAV', 'XPCD', 'ITBD', 'CLBD'];
      const orden = (b: any) => { const i = pref.indexOf(b.balance_type); return i < 0 ? 99 : i; };
      const bal = [...(balances ?? [])].sort((a, b) => orden(a) - orden(b))[0];
      if (bal) {
        const saldo = Number(bal.balance_amount.amount);
        await db.from('banco_cuentas').update({ saldo, saldo_fecha: new Date().toISOString(), desde: new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10) }).eq('uid', c.uid);
        if (c.tipo !== 'CARD') await db.from('saldos').update({ saldo, a_fecha: new Date().toISOString() }).eq('cuenta', c.cuenta_app);
      }
      await db.from('banco_sesiones').update({ ultimo_sync: new Date().toISOString(), error: null }).eq('id', c.sesion);
      res[c.cuenta_app] = { nuevos: nuevos.length, enlazados, saldo: bal?.balance_amount?.amount };
    } catch (e) {
      await db.from('banco_sesiones').update({ error: String(e).slice(0, 500) }).eq('id', c.sesion);
      res[c.cuenta_app] = { error: String(e) };
    }
  }
  return res;
}

Deno.serve(async req => {
  const u = new URL(req.url);
  try {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (u.searchParams.get('conectar')) {
      if (!await esDanny(u.searchParams.get('k'))) return new Response('No autorizado', { status: 401 });
      return await conectar(u.searchParams.get('conectar')!);
    }
    if (u.searchParams.get('code') || u.searchParams.get('error')) {
      const banco = u.searchParams.get('state') ?? '';
      if (!['BBVA', 'Revolut'].includes(banco)) return new Response('Banco desconocido', { status: 400 });
      if (!u.searchParams.get('code')) return volver(`error: ${u.searchParams.get('error_description') ?? u.searchParams.get('error')}`);
      return await callback(u.searchParams.get('code')!, banco);
    }
    if (!await esDanny(req.headers.get('x-clave'))) return new Response('No autorizado', { status: 401, headers: CORS });
    if (u.searchParams.has('estado')) {
      const { data } = await db.from('banco_sesiones').select('banco, valido_hasta, ultimo_sync, error');
      return Response.json(data, { headers: CORS });
    }
    // Desde la app: como mucho cada 6 horas (los bancos limitan los accesos sin el usuario delante)
    const { data: ses } = await db.from('banco_sesiones').select('ultimo_sync');
    const reciente = (ses ?? []).length && (ses ?? []).every((x: any) => x.ultimo_sync && Date.now() - new Date(x.ultimo_sync).getTime() < 6 * 3600000);
    if (reciente && !u.searchParams.has('ya')) return Response.json({ reciente: true }, { headers: CORS });
    return Response.json(await sincronizar(), { headers: CORS });
  } catch (e) {
    console.error(e);
    return u.searchParams.has('code') ? volver(`error: ${String(e).slice(0, 150)}`) : new Response(String(e), { status: 500 });
  }
});
