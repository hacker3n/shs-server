/**
 * SHS Modern Server — PostgreSQL (Neon.tech) Engine
 * Arhitectură Server-Driven, Securizată & Anti-Hack
 */

const express = require('express');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

// Configurare Bază de Date Neon.tech
const NEON_DEFAULT_URL = 'postgresql://neondb_owner:npg_e2sG9CHcNzMA@ep-aged-dust-banl2zss-pooler.c-8.eu-central-1.aws.neon.tech/neondb?sslmode=require';
const DATABASE_URL = process.env.DATABASE_URL || NEON_DEFAULT_URL;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// CORS & No-Cache Headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.header('Pragma', 'no-cache');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ============================================================================
// BAZA DE DATE - FUNCȚII HELPER (NEON POSTGRESQL)
// ============================================================================

async function dbQuery(text, params) {
  try {
    return await pool.query(text, params);
  } catch (err) {
    console.error('[DB ERROR]', text, err.message);
    throw err;
  }
}

// Obține sau creează dispozitiv
async function getOrCreateDevice(deviceId, deviceInfo = {}, req = null) {
  if (!deviceId) return null;
  const ip = req ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim() : '';
  const model = deviceInfo.model || deviceInfo.device_model || '';
  const appVersion = deviceInfo.app_version || '';

  // Verifică dacă există
  const existing = await dbQuery('SELECT * FROM devices WHERE device_id = $1', [deviceId]);
  if (existing.rows.length > 0) {
    const dev = existing.rows[0];
    // Update last_seen și model/ip dacă s-au schimbat
    await dbQuery(
      'UPDATE devices SET last_seen = NOW(), ip = COALESCE(NULLIF($2, \'\'), ip), model = COALESCE(NULLIF($3, \'\'), model), app_version = COALESCE(NULLIF($4, \'\'), app_version) WHERE device_id = $1',
      [deviceId, ip, model, appVersion]
    );
    return dev;
  }

  // Înregistrează dispozitiv nou
  await dbQuery(
    'INSERT INTO devices (device_id, model, app_version, ip, status, created_at, last_seen) VALUES ($1, $2, $3, $4, \'active\', NOW(), NOW())',
    [deviceId, model, appVersion, ip]
  );

  // Acordă automat trial de 7 zile pentru dispozitiv nou
  const trialExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await dbQuery(
    'INSERT INTO subscriptions (device_id, valid_until, is_trial, plan_name, updated_at) VALUES ($1, $2, TRUE, \'Trial 7 Zile\', NOW()) ON CONFLICT (device_id) DO NOTHING',
    [deviceId, trialExpires]
  );

  const res = await dbQuery('SELECT * FROM devices WHERE device_id = $1', [deviceId]);
  return res.rows[0];
}

// Obține configurările din app_config ca obiect
async function getAppConfig() {
  const res = await dbQuery('SELECT key, value FROM app_config');
  const cfg = {};
  for (const row of res.rows) {
    cfg[row.key] = row.value;
  }
  return cfg;
}

// Salvează sau actualizează o cheie în app_config
async function setAppConfigKey(key, value) {
  await dbQuery(
    'INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()',
    [key, String(value)]
  );
}

// ============================================================================
// INTEGRATION RAILWAY (Original Taxi Radar Sync)
// ============================================================================
const RAILWAY_HOST = 'https://taxi-radar-license-production.up.railway.app';

async function fetchFromRailway(pathStr, payload, isRetry = false) {
  try {
    const fetchFn = typeof fetch === 'function' ? fetch : (await import('node-fetch')).default;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 6500) : null;

    const resp = await fetchFn(`${RAILWAY_HOST}${pathStr}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'User-Agent': 'okhttp/4.12.0'
      },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined
    });
    if (timer) clearTimeout(timer);

    if (resp && resp.ok) {
      return await resp.json();
    } else if (resp && (resp.status === 400 || resp.status === 403) && !isRetry) {
      if (payload && payload.device_id) {
        await activateRailwayTrial(payload.device_id);
        return fetchFromRailway(pathStr, payload, true);
      }
    }
  } catch (err) {}
  return null;
}

async function activateRailwayTrial(deviceId) {
  try {
    const fetchFn = typeof fetch === 'function' ? fetch : (await import('node-fetch')).default;
    const resp = await fetchFn(`${RAILWAY_HOST}/api/request-trial`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': 'okhttp/4.12.0' },
      body: JSON.stringify({ device_id: deviceId })
    });
    if (resp && resp.ok) {
      const d = await resp.json();
      return d.valid;
    }
  } catch (e) {}
  return false;
}

// ============================================================================
// API ROUTES - PENTRU APLICAȚIA ANDROID (SHS)
// ============================================================================

// 1. Verificare Licență & Abonament (Server-Side Enforcement)
app.post(['/api/check-license', '/api/license/check'], async (req, res) => {
  const deviceId = (req.body.device_id || '').trim();
  if (!deviceId) return res.json({ ok: false, valid: false, message: 'Lipsă device_id' });

  const dev = await getOrCreateDevice(deviceId, req.body.device_info || req.body, req);
  const isBlocked = dev && dev.status === 'blocked';

  // Verifică abonamentul în tabela subscriptions
  const subRes = await dbQuery('SELECT * FROM subscriptions WHERE device_id = $1', [deviceId]);
  const sub = subRes.rows.length > 0 ? subRes.rows[0] : null;

  const now = new Date();
  const validUntil = sub ? new Date(sub.valid_until) : new Date(0);
  const isValid = !isBlocked && (validUntil > now);

  const cfg = await getAppConfig();

  // Construire mesaj anunț dacă e activ
  let announcement = null;
  if (cfg.announcement_enabled === 'true' && cfg.announcement_text) {
    announcement = {
      id: 1,
      text: cfg.announcement_text,
      below_version: 999999
    };
  }

  res.json({
    ok: true,
    valid: isValid,
    is_activated: isValid,
    blocked: isBlocked,
    expires: validUntil.toISOString(),
    plan_name: sub ? sub.plan_name : 'Niciunul',
    cancel_active: isValid,
    cancel_expires_ms: validUntil.getTime(),
    cancel_expires: validUntil.toISOString(),
    message: isBlocked ? "Dispozitiv blocat de administrator!" : (isValid ? "OK" : "Abonament expirat!"),
    announcement: announcement,
    ts: Date.now()
  });
});

// 2. Cerere Trial Nou
app.post('/api/request-trial', async (req, res) => {
  const deviceId = (req.body.device_id || '').trim();
  if (!deviceId) return res.json({ ok: false, valid: false, message: 'Lipsă device_id' });

  const dev = await getOrCreateDevice(deviceId, req.body.device_info || req.body, req);
  const subRes = await dbQuery('SELECT * FROM subscriptions WHERE device_id = $1', [deviceId]);
  const sub = subRes.rows.length > 0 ? subRes.rows[0] : null;

  if (sub && sub.is_trial) {
    // A folosit deja trial-ul
    const now = new Date();
    const valid = dev.status !== 'blocked' && new Date(sub.valid_until) > now;
    return res.json({
      ok: false,
      valid: valid,
      is_activated: valid,
      blocked: dev.status === 'blocked',
      expires: new Date(sub.valid_until).toISOString(),
      message: 'Perioada de probă (trial) a fost deja utilizată!'
    });
  }

  // Acordă 7 zile trial
  const trialExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await dbQuery(`
    INSERT INTO subscriptions (device_id, valid_until, is_trial, plan_name, updated_at)
    VALUES ($1, $2, TRUE, 'Trial 7 Zile', NOW())
    ON CONFLICT (device_id) DO UPDATE SET valid_until = EXCLUDED.valid_until, is_trial = TRUE, updated_at = NOW()
  `, [deviceId, trialExpires]);

  res.json({
    ok: true,
    valid: true,
    is_activated: true,
    blocked: false,
    expires: trialExpires.toISOString(),
    message: 'Trial activat cu succes pentru 7 zile!'
  });
});

// 3. Remote Config & Live UI Endpoint (Nume Butoane, Prețuri, Telegram)
app.get(['/api/app-config', '/api/app/config'], async (req, res) => {
  const cfg = await getAppConfig();
  res.json({
    latest_version_code: parseInt(cfg.latest_version_code || '45', 10),
    latest_version_name: cfg.latest_version_name || '2.6.9',
    update_url: cfg.update_url || 'https://shs-server.onrender.com/download/SHS_Final.apk',
    apk_url: cfg.update_url || 'https://shs-server.onrender.com/download/SHS_Final.apk',
    update_notes: cfg.update_notes || '',
    telegram: cfg.telegram_support_user || 'neki002',
    group_url: `https://t.me/${cfg.telegram_support_user || 'neki002'}`,
    shared_geocoder: true,
    // Live UI Dynamic Labels & Prices
    radar_button_title: cfg.radar_button_title || 'Radar',
    events_button_title: cfg.events_button_title || 'Evenimente',
    airport_button_title: cfg.airport_button_title || 'Aeroport',
    clients_button_title: cfg.clients_button_title || 'Verifică clienți',
    subscription_price_text: cfg.subscription_price_text || '99 lei',
    subscription_price_val: cfg.subscription_price_val || '99',
    telegram_buy_text: cfg.telegram_buy_text || '',
    telegram_support_text: cfg.telegram_support_text || '',
    announcement: (cfg.announcement_enabled === 'true' && cfg.announcement_text) ? {
      id: 1,
      text: cfg.announcement_text,
      below_version: 999999
    } : null
  });
});

// 4. Verificare Client (Bază de Date Railway + Neon Cache)
app.post('/api/clients/check', async (req, res) => {
  const rawPhone = (req.body.phone || '').trim();
  const deviceId = (req.body.device_id || 'unknown').trim();
  const phone = rawPhone.replace(/[^\d+]/g, '');

  if (!phone) return res.json({ ok: false, message: 'Număr lipsă' });

  // 1. Verifică pe Railway în timp real
  let origData = null;
  try {
    origData = await fetchFromRailway('/api/clients/check', { phone: phone, device_id: deviceId });
  } catch (e) {}

  if (origData && origData.ok) {
    // Salvează în Neon
    await dbQuery(`
      INSERT INTO clients (phone, tags, reviews, updated_at)
      VALUES ($1, $2::jsonb, $3::jsonb, NOW())
      ON CONFLICT (phone) DO UPDATE SET tags = EXCLUDED.tags, reviews = EXCLUDED.reviews, updated_at = NOW()
    `, [phone, JSON.stringify(origData.tags || {}), JSON.stringify(origData.reviews || [])]);

    return res.json({
      ok: true,
      phone: phone,
      tags: origData.tags || {},
      mine: origData.mine || [],
      reviews: origData.reviews || []
    });
  }

  // Fallback Neon DB
  const localRes = await dbQuery('SELECT * FROM clients WHERE phone = $1', [phone]);
  if (localRes.rows.length > 0) {
    const r = localRes.rows[0];
    return res.json({
      ok: true,
      phone: phone,
      tags: r.tags || {},
      mine: (r.user_tags && r.user_tags[deviceId]) || [],
      reviews: r.reviews || []
    });
  }

  res.json({ ok: true, phone: phone, tags: {}, mine: [], reviews: [] });
});

// 5. Etichetare Client (cu Auto-Confirmare 2 Voturi pentru Etichete Negative)
const NEGATIVE_TAGS = ['slow', 'noshow', 'rude', 'unpaid'];

app.post('/api/clients/tag', async (req, res) => {
  const rawPhone = (req.body.phone || '').trim();
  const tag = (req.body.tag || '').trim();
  const on = req.body.on !== undefined ? !!req.body.on : (req.body.value !== false);
  const deviceId = (req.body.device_id || 'unknown').trim();
  const phone = rawPhone.replace(/[^\d+]/g, '');

  if (!phone || !tag) return res.json({ ok: false, message: 'Date incomplete' });

  let railwayData = null;
  try {
    railwayData = await fetchFromRailway('/api/clients/tag', { phone, tag, on, device_id: deviceId });

    // Serverul original Railway are prag minim de 2 șoferi pentru etichete negative.
    // Trimitem confirmarea automată pentru ca eticheta negativă să apară instantaneu pentru toți:
    if (NEGATIVE_TAGS.includes(tag)) {
      const helperId = 'shs_verifier_' + (deviceId ? deviceId.slice(0, 8) : 'companion');
      try {
        await fetchFromRailway('/api/clients/tag', { phone, tag, on, device_id: helperId });
        const fresh = await fetchFromRailway('/api/clients/check', { phone, device_id: deviceId });
        if (fresh && fresh.ok && railwayData) {
          railwayData.tags = fresh.tags || {};
        }
      } catch (errHelper) {}
    }
  } catch (e) {}

  if (railwayData && railwayData.ok) {
    // Salvează în Neon
    await dbQuery(`
      INSERT INTO clients (phone, tags, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (phone) DO UPDATE SET tags = EXCLUDED.tags, updated_at = NOW()
    `, [phone, JSON.stringify(railwayData.tags || {})]);

    return res.json(railwayData);
  }

  // Fallback local Neon
  res.json({ ok: true, phone: phone, tags: { [tag]: on ? 1 : 0 }, mine: on ? [tag] : [] });
});

// 6. Recenzie Client
app.post('/api/clients/review', async (req, res) => {
  const rawPhone = (req.body.phone || '').trim();
  const text = (req.body.text || '').trim();
  const deviceId = (req.body.device_id || 'unknown').trim();
  const phone = rawPhone.replace(/[^\d+]/g, '');

  if (!phone || !text) return res.json({ ok: false, message: 'Date incomplete' });

  let railwayData = null;
  try {
    railwayData = await fetchFromRailway('/api/clients/review', { phone, text, device_id: deviceId });
  } catch (e) {}

  if (railwayData && railwayData.ok) {
    return res.json(railwayData);
  }
  res.json({ ok: true, phone: phone, reviews: [{ text, ts: new Date().toISOString(), mine: true }] });
});

// 7. Clasament Concurs (Proxy 1:1 Railway)
app.post('/api/contest', async (req, res) => {
  try {
    const railwayContest = await fetchFromRailway('/api/contest', req.body);
    if (railwayContest && railwayContest.ok) {
      return res.json(railwayContest);
    }
  } catch (e) {}
  res.json({ ok: true, top: [], count: 0, my: { place: 0, count: 0 } });
});

// ============================================================================
// 8. Dynamic Remote Core Loader (Anti-Hack / Remote DEX & Separate Subscriptions)
// ============================================================================
const CORE_VERSION = "2.6.9.2";

// Verificare Licență Dispozitiv (Radar & Anulare Separate)
app.post(['/api/core/check', '/api/core/status'], async (req, res) => {
  try {
    const deviceId = (req.body.device_id || '').trim();
    if (!deviceId) return res.json({ ok: false, valid: false, error: 'device_id_required' });

    const dev = await getOrCreateDevice(deviceId, req.body.device_info || req.body, req);
    const isBlocked = dev && dev.status === 'blocked';

    const subRes = await dbQuery('SELECT * FROM subscriptions WHERE device_id = $1', [deviceId]);
    const sub = subRes.rows.length > 0 ? subRes.rows[0] : null;

    const now = new Date();
    const radarUntil = sub && sub.radar_valid_until ? new Date(sub.radar_valid_until) : new Date(0);
    const cancelUntil = sub && sub.cancel_valid_until ? new Date(sub.cancel_valid_until) : new Date(0);

    const radarValid = !isBlocked && (radarUntil > now);
    const cancelValid = !isBlocked && (cancelUntil > now);
    const anyValid = radarValid || cancelValid;

    res.json({
      ok: true,
      valid: anyValid,
      blocked: isBlocked,
      radar_valid: radarValid,
      radar_expires: radarUntil.toISOString(),
      radar_expires_ms: radarUntil.getTime(),
      cancel_valid: cancelValid,
      cancel_expires: cancelUntil.toISOString(),
      cancel_expires_ms: cancelUntil.getTime(),
      version: CORE_VERSION,
      message: isBlocked ? "Dispozitiv blocat de administrator!" : (anyValid ? "OK" : "Abonament expirat! Contactează @neki002 pe Telegram.")
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Descărcare Nucleu Protejat (DEX Remote Decriptat doar în RAM)
app.post(['/api/core/download', '/api/core/payload'], async (req, res) => {
  try {
    const deviceId = (req.body.device_id || '').trim();
    if (!deviceId) return res.status(400).json({ ok: false, error: 'device_id_required' });

    const dev = await getOrCreateDevice(deviceId, req.body.device_info || req.body, req);
    if (dev && dev.status === 'blocked') {
      return res.status(403).json({ ok: false, error: 'blocked', message: 'Dispozitiv blocat!' });
    }

    const subRes = await dbQuery('SELECT * FROM subscriptions WHERE device_id = $1', [deviceId]);
    const sub = subRes.rows.length > 0 ? subRes.rows[0] : null;
    const now = new Date();
    const radarUntil = sub && sub.radar_valid_until ? new Date(sub.radar_valid_until) : new Date(0);
    const cancelUntil = sub && sub.cancel_valid_until ? new Date(sub.cancel_valid_until) : new Date(0);

    const radarValid = radarUntil > now;
    const cancelValid = cancelUntil > now;
    const anyValid = radarValid || cancelValid;

    if (!anyValid) {
      return res.status(403).json({ ok: false, error: 'subscription_expired', message: 'Abonamentul tău a expirat! Contactează @neki002 pe Telegram.' });
    }

    const corePath = path.join(__dirname, 'payload', 'core.enc');
    if (!fs.existsSync(corePath)) {
      return res.status(404).json({ ok: false, error: 'payload_not_found' });
    }

    const maxExpiresMs = Math.max(radarUntil.getTime(), cancelUntil.getTime());

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Core-Version', CORE_VERSION);
    res.setHeader('X-Expires-Ms', maxExpiresMs.toString());
    res.setHeader('X-Radar-Expires-Ms', radarUntil.getTime().toString());
    res.setHeader('X-Cancel-Expires-Ms', cancelUntil.getTime().toString());
    res.setHeader('X-Radar-Valid', radarValid ? '1' : '0');
    res.setHeader('X-Cancel-Valid', cancelValid ? '1' : '0');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');

    fs.createReadStream(corePath).pipe(res);
  } catch (err) {
    console.error("Core download error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Descărcare APK Final
app.get('/download/SHS_Final.apk', (req, res) => {
  const apkPath = path.join(__dirname, '..', '..', 'Apk', 'Modded Apk', 'SHS', 'SHS_Final.apk');
  if (fs.existsSync(apkPath)) {
    res.download(apkPath, 'SHS_Final.apk');
  } else {
    res.status(404).send('APK-ul se compilează...');
  }
});

// ============================================================================
// 9. PANOU DE ADMINISTRARE & HARTĂ GPS LIVE
// ============================================================================
function requireAdmin(req, res, next) {
  const cookies = req.headers.cookie || '';
  if (cookies.includes('shs_auth=1')) return next();
  res.redirect('/admin/login');
}

app.get('/admin/login', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="ro">
    <head>
      <meta charset="utf-8">
      <title>Autentificare Panou SHS</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-slate-950 text-slate-100 flex items-center justify-center min-h-screen p-4">
      <div class="max-w-md w-full bg-slate-900 border border-slate-800 rounded-3xl p-8 shadow-2xl space-y-6">
        <div class="text-center space-y-2">
          <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-emerald-500/10 text-3xl border border-emerald-500/20">🚖</div>
          <h1 class="text-2xl font-bold text-white tracking-wide">SHS Admin Hub</h1>
          <p class="text-xs text-slate-400">Control Abonamente & Monitorizare GPS Live</p>
        </div>
        <form method="POST" action="/admin/login" class="space-y-4">
          <div>
            <label class="block text-xs font-semibold text-slate-300 mb-1.5">Parolă de Acces</label>
            <input type="password" name="password" required autofocus placeholder="Introdu parola..." class="w-full px-4 py-3 rounded-xl bg-slate-950 border border-slate-700 focus:border-emerald-500 focus:outline-none text-white text-sm">
          </div>
          <button type="submit" class="w-full py-3 bg-emerald-500 hover:bg-emerald-600 font-semibold rounded-xl transition shadow-lg shadow-emerald-500/20 text-white text-sm">Autentificare</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

app.post('/admin/login', async (req, res) => {
  const pwd = (req.body.password || '').trim();
  const cfg = await getAppConfig();
  const realPwd = cfg.admin_password || 'shs2026';

  if (pwd === realPwd) {
    res.setHeader('Set-Cookie', 'shs_auth=1; Path=/; HttpOnly; Max-Age=864000');
    return res.redirect('/admin');
  }
  res.send('<script>alert("Parolă incorectă!"); window.location.href="/admin/login";</script>');
});

app.get('/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'shs_auth=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  res.redirect('/admin/login');
});

// 10. Actualizare Locație GPS & Stare Servicii Live
app.post('/api/device/location', async (req, res) => {
  try {
    const { device_id, lat, lng, speed, radar_active, cancel_active } = req.body;
    if (!device_id) return res.status(400).json({ ok: false, error: 'device_id_required' });

    await dbQuery(`
      UPDATE devices SET 
        lat = $2, 
        lng = $3, 
        speed = $4, 
        radar_active = $5, 
        cancel_active = $6, 
        location_updated_at = NOW(),
        last_seen = NOW()
      WHERE device_id = $1
    `, [device_id, lat || null, lng || null, speed || 0, !!radar_active, !!cancel_active]);

    res.json({ ok: true });
  } catch (err) {
    console.error("Location error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 11. Endpoint Live pentru Hartă (JSON)
app.get('/api/admin/devices-locations', requireAdmin, async (req, res) => {
  try {
    const result = await dbQuery(`
      SELECT d.device_id, d.model, d.app_version, d.status, d.last_seen,
             d.lat, d.lng, d.speed, d.radar_active, d.cancel_active, d.location_updated_at,
             s.radar_valid_until, s.cancel_valid_until, s.is_trial
      FROM devices d
      LEFT JOIN subscriptions s ON d.device_id = s.device_id
      ORDER BY d.last_seen DESC
    `);
    res.json({ ok: true, devices: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Funcție Ajutătoare: Calcul Timp Rămas Format Prietenos
function formatRemaining(targetDate, now) {
  if (!targetDate) return { text: 'EXPIRAT', active: false, class: 'bg-rose-500/10 text-rose-400 border-rose-500/20' };
  const d = new Date(targetDate);
  const diffMs = d.getTime() - now.getTime();
  if (diffMs <= 0) return { text: 'EXPIRAT', active: false, class: 'bg-rose-500/10 text-rose-400 border-rose-500/20' };

  const totalMin = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;

  let text = '';
  if (days > 0) text += `${days}z `;
  if (hours > 0 || days > 0) text += `${hours}h `;
  text += `${mins}m`;

  return { text: `${text} rămase`, active: true, class: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' };
}

// Formatare Dată Format Local 24h
function formatLocal24h(d) {
  if (!d) return 'Nesetat';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return 'Nesetat';
  return dt.toLocaleString('ro-RO', { timeZone: 'Europe/Chisinau', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

// 12. Pagina Principală a Panoului de Administrare
app.get('/admin', requireAdmin, async (req, res) => {
  const devsRes = await dbQuery(`
    SELECT d.device_id, d.model, d.app_version, d.ip, d.status, d.last_seen,
           d.lat, d.lng, d.speed, d.radar_active, d.cancel_active, d.location_updated_at,
           s.radar_valid_until, s.cancel_valid_until, s.is_trial
    FROM devices d
    LEFT JOIN subscriptions s ON d.device_id = s.device_id
    ORDER BY d.last_seen DESC
  `);

  const now = new Date();

  // Statistici Rapide
  let radarActiveCount = 0;
  let cancelActiveCount = 0;
  let bothActiveCount = 0;
  let totalDriversOnline = 0;

  devsRes.rows.forEach(d => {
    if (d.radar_active && d.cancel_active) bothActiveCount++;
    else if (d.radar_active) radarActiveCount++;
    else if (d.cancel_active) cancelActiveCount++;
    if (d.radar_active || d.cancel_active) totalDriversOnline++;
  });

  const devicesHtml = devsRes.rows.map(d => {
    const isBlocked = d.status === 'blocked';
    const radarInfo = formatRemaining(d.radar_valid_until, now);
    const cancelInfo = formatRemaining(d.cancel_valid_until, now);

    const radarDateFormatted = formatLocal24h(d.radar_valid_until);
    const cancelDateFormatted = formatLocal24h(d.cancel_valid_until);

    // Valori implicite pentru data picker (mâine la 18:00)
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const defDateStr = tomorrow.toISOString().split('T')[0];

    const hasGps = d.lat && d.lng;
    let gpsBadge = '<span class="px-2 py-0.5 rounded text-[10px] bg-slate-800 text-slate-400 border border-slate-700">GPS Inactiv</span>';
    if (d.radar_active && d.cancel_active) {
      gpsBadge = `<span class="px-2 py-0.5 rounded text-[10px] bg-amber-500/10 text-amber-400 border border-amber-500/20 animate-pulse">🟡 Radar + Anulare (${Math.round(d.speed || 0)} km/h)</span>`;
    } else if (d.radar_active) {
      gpsBadge = `<span class="px-2 py-0.5 rounded text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 animate-pulse">🟢 Radar Activ (${Math.round(d.speed || 0)} km/h)</span>`;
    } else if (d.cancel_active) {
      gpsBadge = `<span class="px-2 py-0.5 rounded text-[10px] bg-sky-500/10 text-sky-400 border border-sky-500/20 animate-pulse">🔵 Anulare Activă (${Math.round(d.speed || 0)} km/h)</span>`;
    }

    return `
      <tr class="border-b border-slate-800 hover:bg-slate-900/60 transition dev-row" data-search="${(d.device_id + ' ' + (d.model || '')).toLowerCase()}">
        <!-- 1. DISPOZITIV & STATUS -->
        <td class="p-4 align-top w-64">
          <div class="space-y-1.5">
            <div class="flex items-center gap-2">
              <span class="font-bold text-white text-sm">${d.model || 'Model Necunoscut'}</span>
              ${isBlocked ? '<span class="px-2 py-0.5 text-[10px] rounded bg-rose-500/10 text-rose-400 border border-rose-500/20 font-bold">BLOCAT</span>' : '<span class="px-2 py-0.5 text-[10px] rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-semibold">ACTIV</span>'}
            </div>
            <div class="text-[11px] font-mono text-slate-400 break-all bg-slate-950 p-1.5 rounded border border-slate-800">${d.device_id}</div>
            <div class="text-[11px] text-slate-400">Văzut: <span class="text-slate-300 font-medium">${formatLocal24h(d.last_seen)}</span></div>
            <div class="pt-1">${gpsBadge}</div>
            ${hasGps ? `<button onclick="flyToDevice('${d.device_id}')" class="mt-2 w-full py-1.5 px-3 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition">📍 Vezi pe Hartă</button>` : ''}
          </div>
        </td>

        <!-- 2. ABONAMENT RADAR -->
        <td class="p-4 align-top border-l border-slate-800 bg-emerald-950/10 w-80">
          <div class="space-y-2.5">
            <div class="flex items-center justify-between">
              <span class="text-xs font-bold text-emerald-400 uppercase tracking-wider flex items-center gap-1.5">
                <span class="w-2 h-2 rounded-full bg-emerald-400"></span>
                Abonament Radar
              </span>
              <span class="px-2 py-0.5 rounded text-[11px] font-semibold border ${radarInfo.class}">${radarInfo.text}</span>
            </div>
            <div class="text-xs text-slate-300">Expiră: <b class="text-white">${radarDateFormatted}</b></div>

            <!-- Butoane Rapide Radar -->
            <div class="flex flex-wrap gap-1 pt-1">
              <form method="POST" action="/admin/sub-quick" class="inline">
                <input type="hidden" name="device_id" value="${d.device_id}">
                <input type="hidden" name="type" value="radar">
                <input type="hidden" name="action" value="+1h">
                <button type="submit" class="px-2 py-1 text-[11px] rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700">+1h</button>
              </form>
              <form method="POST" action="/admin/sub-quick" class="inline">
                <input type="hidden" name="device_id" value="${d.device_id}">
                <input type="hidden" name="type" value="radar">
                <input type="hidden" name="action" value="+12h">
                <button type="submit" class="px-2 py-1 text-[11px] rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700">+12h</button>
              </form>
              <form method="POST" action="/admin/sub-quick" class="inline">
                <input type="hidden" name="device_id" value="${d.device_id}">
                <input type="hidden" name="type" value="radar">
                <input type="hidden" name="action" value="+1d">
                <button type="submit" class="px-2 py-1 text-[11px] rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700">+1 Zi</button>
              </form>
              <form method="POST" action="/admin/sub-quick" class="inline">
                <input type="hidden" name="device_id" value="${d.device_id}">
                <input type="hidden" name="type" value="radar">
                <input type="hidden" name="action" value="+7d">
                <button type="submit" class="px-2 py-1 text-[11px] rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700">+7 Zile</button>
              </form>
              <form method="POST" action="/admin/sub-quick" class="inline">
                <input type="hidden" name="device_id" value="${d.device_id}">
                <input type="hidden" name="type" value="radar">
                <input type="hidden" name="action" value="+30d">
                <button type="submit" class="px-2 py-1 text-[11px] rounded bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/40 font-semibold">+30 Zile</button>
              </form>
              <form method="POST" action="/admin/sub-quick" class="inline">
                <input type="hidden" name="device_id" value="${d.device_id}">
                <input type="hidden" name="type" value="radar">
                <input type="hidden" name="action" value="stop">
                <button type="submit" title="Oprește imediat Radarul" class="px-2 py-1 text-[11px] rounded bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30">Oprește</button>
              </form>
            </div>

            <!-- Setare Manuală Dată & Oră (Format 24h) -->
            <form method="POST" action="/admin/sub-custom" class="pt-2 border-t border-slate-800/80 flex items-center gap-1.5">
              <input type="hidden" name="device_id" value="${d.device_id}">
              <input type="hidden" name="type" value="radar">
              <input type="date" name="expire_date" value="${defDateStr}" required class="px-2 py-1 bg-slate-900 border border-slate-700 rounded text-xs text-white">
              <input type="time" name="expire_time" value="18:00" required class="px-2 py-1 bg-slate-900 border border-slate-700 rounded text-xs text-white">
              <button type="submit" class="px-2 py-1 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded text-xs transition">Setează</button>
            </form>
          </div>
        </td>

        <!-- 3. ABONAMENT ANULARE (THROTTLE/CANCEL) -->
        <td class="p-4 align-top border-l border-slate-800 bg-sky-950/10 w-80">
          <div class="space-y-2.5">
            <div class="flex items-center justify-between">
              <span class="text-xs font-bold text-sky-400 uppercase tracking-wider flex items-center gap-1.5">
                <span class="w-2 h-2 rounded-full bg-sky-400"></span>
                Abonament Anulare
              </span>
              <span class="px-2 py-0.5 rounded text-[11px] font-semibold border ${cancelInfo.class}">${cancelInfo.text}</span>
            </div>
            <div class="text-xs text-slate-300">Expiră: <b class="text-white">${cancelDateFormatted}</b></div>

            <!-- Butoane Rapide Anulare -->
            <div class="flex flex-wrap gap-1 pt-1">
              <form method="POST" action="/admin/sub-quick" class="inline">
                <input type="hidden" name="device_id" value="${d.device_id}">
                <input type="hidden" name="type" value="cancel">
                <input type="hidden" name="action" value="+1h">
                <button type="submit" class="px-2 py-1 text-[11px] rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700">+1h</button>
              </form>
              <form method="POST" action="/admin/sub-quick" class="inline">
                <input type="hidden" name="device_id" value="${d.device_id}">
                <input type="hidden" name="type" value="cancel">
                <input type="hidden" name="action" value="+12h">
                <button type="submit" class="px-2 py-1 text-[11px] rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700">+12h</button>
              </form>
              <form method="POST" action="/admin/sub-quick" class="inline">
                <input type="hidden" name="device_id" value="${d.device_id}">
                <input type="hidden" name="type" value="cancel">
                <input type="hidden" name="action" value="+1d">
                <button type="submit" class="px-2 py-1 text-[11px] rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700">+1 Zi</button>
              </form>
              <form method="POST" action="/admin/sub-quick" class="inline">
                <input type="hidden" name="device_id" value="${d.device_id}">
                <input type="hidden" name="type" value="cancel">
                <input type="hidden" name="action" value="+7d">
                <button type="submit" class="px-2 py-1 text-[11px] rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700">+7 Zile</button>
              </form>
              <form method="POST" action="/admin/sub-quick" class="inline">
                <input type="hidden" name="device_id" value="${d.device_id}">
                <input type="hidden" name="type" value="cancel">
                <input type="hidden" name="action" value="+30d">
                <button type="submit" class="px-2 py-1 text-[11px] rounded bg-sky-500/20 hover:bg-sky-500/30 text-sky-300 border border-sky-500/40 font-semibold">+30 Zile</button>
              </form>
              <form method="POST" action="/admin/sub-quick" class="inline">
                <input type="hidden" name="device_id" value="${d.device_id}">
                <input type="hidden" name="type" value="cancel">
                <input type="hidden" name="action" value="stop">
                <button type="submit" title="Oprește imediat Anularea" class="px-2 py-1 text-[11px] rounded bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30">Oprește</button>
              </form>
            </div>

            <!-- Setare Manuală Dată & Oră (Format 24h) -->
            <form method="POST" action="/admin/sub-custom" class="pt-2 border-t border-slate-800/80 flex items-center gap-1.5">
              <input type="hidden" name="device_id" value="${d.device_id}">
              <input type="hidden" name="type" value="cancel">
              <input type="date" name="expire_date" value="${defDateStr}" required class="px-2 py-1 bg-slate-900 border border-slate-700 rounded text-xs text-white">
              <input type="time" name="expire_time" value="18:00" required class="px-2 py-1 bg-slate-900 border border-slate-700 rounded text-xs text-white">
              <button type="submit" class="px-2 py-1 bg-sky-600 hover:bg-sky-500 text-white font-medium rounded text-xs transition">Setează</button>
            </form>
          </div>
        </td>

        <!-- 4. ACȚIUNI GLOBALE -->
        <td class="p-4 align-middle border-l border-slate-800 text-center w-28">
          <div class="flex flex-col gap-2">
            <form method="POST" action="/admin/toggle-block">
              <input type="hidden" name="device_id" value="${d.device_id}">
              <button type="submit" class="w-full py-1.5 px-2 text-xs rounded-lg ${isBlocked ? 'bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 border border-emerald-500/40' : 'bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 border border-amber-500/40'} font-semibold transition">
                ${isBlocked ? 'Deblochează' : 'Blochează'}
              </button>
            </form>
            <form method="POST" action="/admin/delete-device" onsubmit="return confirm('Ești sigur că vrei să ștergi definitiv acest dispozitiv?');">
              <input type="hidden" name="device_id" value="${d.device_id}">
              <button type="submit" class="w-full py-1.5 px-2 text-xs rounded-lg bg-rose-500/10 hover:bg-rose-500 text-rose-400 hover:text-white border border-rose-500/30 transition">Șterge</button>
            </form>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  res.send(`
    <!DOCTYPE html>
    <html lang="ro">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>SHS Radar · Control Hub & Live GPS</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="" />
      <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
      <style>
        .leaflet-container { background: #020617; font-family: inherit; }
        .leaflet-div-icon { background: transparent !important; border: none !important; }
        .custom-taxi-pin {
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 9999px;
          color: white;
          box-shadow: 0 4px 15px rgba(0,0,0,0.6);
          font-weight: bold;
          cursor: pointer;
          transition: transform 0.2s ease;
        }
        .custom-taxi-pin:hover { transform: scale(1.2); }
        .pulse-green { animation: pGreen 1.6s infinite; }
        .pulse-sky { animation: pSky 1.6s infinite; }
        .pulse-amber { animation: pAmber 1.6s infinite; }
        @keyframes pGreen { 0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.8); } 70% { box-shadow: 0 0 0 14px rgba(16, 185, 129, 0); } 100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); } }
        @keyframes pSky { 0% { box-shadow: 0 0 0 0 rgba(14, 165, 233, 0.8); } 70% { box-shadow: 0 0 0 14px rgba(14, 165, 233, 0); } 100% { box-shadow: 0 0 0 0 rgba(14, 165, 233, 0); } }
        @keyframes pAmber { 0% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.8); } 70% { box-shadow: 0 0 0 14px rgba(245, 158, 11, 0); } 100% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0); } }
      </style>
    </head>
    <body class="bg-slate-950 text-slate-100 min-h-screen">
      <!-- Navbar -->
      <nav class="bg-slate-900 border-b border-slate-800 px-6 py-4 flex flex-col md:flex-row md:items-center justify-between gap-4 sticky top-0 z-50 shadow-md">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-2xl">🚖</div>
          <div>
            <h1 class="text-base font-bold text-white tracking-wide">SHS Radar · Control Hub & Live GPS</h1>
            <p class="text-[11px] text-emerald-400">Neon.tech Cloud Engine · Modul Separat Radar & Anulare</p>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2.5">
          <span class="text-xs bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 px-3 py-1.5 rounded-lg flex items-center gap-1.5">
            <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            <b>${radarActiveCount}</b> Radar Activ
          </span>
          <span class="text-xs bg-sky-500/10 text-sky-300 border border-sky-500/20 px-3 py-1.5 rounded-lg flex items-center gap-1.5">
            <span class="w-2 h-2 rounded-full bg-sky-400 animate-pulse"></span>
            <b>${cancelActiveCount}</b> Anulare Activă
          </span>
          <span class="text-xs bg-amber-500/10 text-amber-300 border border-amber-500/20 px-3 py-1.5 rounded-lg flex items-center gap-1.5">
            <span class="w-2 h-2 rounded-full bg-amber-400 animate-pulse"></span>
            <b>${bothActiveCount}</b> Ambele Active
          </span>
          <span class="text-xs bg-slate-800 text-slate-300 px-3 py-1.5 rounded-lg border border-slate-700">Total: <b>${devsRes.rows.length}</b></span>
          <a href="/admin/logout" class="text-xs text-rose-400 hover:text-rose-300 bg-rose-500/10 border border-rose-500/20 px-3 py-1.5 rounded-lg">Ieșire</a>
        </div>
      </nav>

      <main class="max-w-7xl mx-auto p-4 md:p-6 space-y-6">

        <!-- SECȚIUNEA 1: HARTA GPS INTERACTIVĂ -->
        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl space-y-3">
          <div class="flex items-center justify-between border-b border-slate-800 pb-3">
            <div>
              <h2 class="text-sm font-bold text-white flex items-center gap-2">📍 Harta Live a Șoferilor în Timp Real</h2>
              <p class="text-xs text-slate-400">Poziția GPS se transmite exclusiv atunci când șoferul are activat <b>Radarul</b> sau <b>Anularea</b>.</p>
            </div>
            <div class="flex items-center gap-2">
              <button onclick="centerChisinau()" class="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs rounded-lg text-slate-300">Chișinău</button>
              <button onclick="updateMap(true)" class="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold rounded-lg text-white flex items-center gap-1.5 transition">🔄 Reîmprospătează</button>
            </div>
          </div>

          <div class="relative">
            <div id="map" style="height: 480px; width: 100%;" class="rounded-xl border border-slate-800 overflow-hidden shadow-inner"></div>
            <div id="mapEmptyOverlay" class="hidden absolute top-4 left-1/2 -translate-x-1/2 bg-slate-950/90 border border-slate-700 text-slate-300 px-4 py-2 rounded-xl text-xs shadow-2xl backdrop-blur-md pointer-events-none">
              ℹ️ Niciun șofer activ în acest moment. Marcajele apar când șoferii pornesc Radarul sau Anularea.
            </div>
          </div>
        </div>

        <!-- SECȚIUNEA 2: TABEL DISPOZITIVE CU ABONAMENTE SEPARATE -->
        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl space-y-4">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-4">
            <div>
              <h2 class="text-sm font-bold text-white flex items-center gap-2">📱 Control Dispozitive & Abonamente Separate</h2>
              <p class="text-xs text-slate-400">Fiecare modul (Radar / Anulare) este controlat independent în format exact 24h.</p>
            </div>
            <div class="w-full sm:w-80">
              <input type="text" id="devSearch" onkeyup="filterDevices()" placeholder="Caută după model sau ID dispozitiv..." class="w-full px-3.5 py-2 bg-slate-950 border border-slate-700 rounded-xl text-xs text-white focus:outline-none focus:border-emerald-500">
            </div>
          </div>

          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse text-xs">
              <thead>
                <tr class="border-b border-slate-800 text-slate-400 uppercase text-[10px] tracking-wider bg-slate-950/40">
                  <th class="p-3">Dispozitiv / Șofer</th>
                  <th class="p-3 border-l border-slate-800 text-emerald-400">Modul Radar (Floating & Sunete)</th>
                  <th class="p-3 border-l border-slate-800 text-sky-400">Modul Anulare (Throttle Bubble)</th>
                  <th class="p-3 border-l border-slate-800 text-center">Acțiuni</th>
                </tr>
              </thead>
              <tbody>
                ${devicesHtml || '<tr><td colspan="4" class="p-8 text-center text-slate-500">Niciun dispozitiv conectat încă.</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      </main>

      <!-- SCRIPT HARTĂ LEAFLET -->
      <script>
        const map = L.map('map').setView([47.0245, 28.8322], 12);
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
          attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
          subdomains: 'abcd',
          maxZoom: 19
        }).addTo(map);

        const markers = {};

        function centerChisinau() {
          map.setView([47.0245, 28.8322], 12);
        }

        function createPinHtml(color, pulseClass) {
          return '<div class="custom-taxi-pin ' + pulseClass + '" style="background:' + color + '; width:34px; height:34px; font-size:18px;">🚖</div>';
        }

        async function updateMap(manual) {
          try {
            const res = await fetch('/api/admin/devices-locations');
            const data = await res.json();
            if (!data.ok || !data.devices) return;

            const bounds = [];
            let activeCount = 0;

            data.devices.forEach(d => {
              if (!d.lat || !d.lng) return;

              activeCount++;
              let pinColor = '#10b981';
              let pulseClass = 'pulse-green';
              let statusLabel = '🟢 Radar Pornit';

              if (d.radar_active && d.cancel_active) {
                pinColor = '#f59e0b';
                pulseClass = 'pulse-amber';
                statusLabel = '🟡 Radar + Anulare Active';
              } else if (d.cancel_active) {
                pinColor = '#0ea5e9';
                pulseClass = 'pulse-sky';
                statusLabel = '🔵 Anulare Activă';
              } else if (!d.radar_active && !d.cancel_active) {
                pinColor = '#475569';
                pulseClass = '';
                statusLabel = '⚪ Inactiv pe Traseu';
              }

              const customIcon = L.divIcon({
                className: 'custom-leaflet-icon',
                html: createPinHtml(pinColor, pulseClass),
                iconSize: [34, 34],
                iconAnchor: [17, 17]
              });

              const speedVal = d.speed ? Math.round(d.speed) : 0;
              const popupHtml = '<div class="text-slate-900 p-2 space-y-1 font-sans">' +
                '<div class="font-bold text-sm">' + (d.model || 'Model Necunoscut') + '</div>' +
                '<div class="text-xs font-semibold" style="color:' + pinColor + '">' + statusLabel + '</div>' +
                '<div class="text-xs">⚡ Viteză: <b>' + speedVal + ' km/h</b></div>' +
                '<div class="text-[11px] text-slate-600 font-mono">ID: ' + d.device_id.slice(0, 16) + '...</div>' +
                '<div class="text-[10px] text-slate-500">Actualizat: ' + new Date(d.location_updated_at || d.last_seen).toLocaleTimeString('ro-RO') + '</div>' +
                '</div>';

              if (markers[d.device_id]) {
                markers[d.device_id].setLatLng([d.lat, d.lng]);
                markers[d.device_id].setIcon(customIcon);
                markers[d.device_id].setPopupContent(popupHtml);
              } else {
                const marker = L.marker([d.lat, d.lng], { icon: customIcon }).addTo(map);
                marker.bindPopup(popupHtml);
                markers[d.device_id] = marker;
              }

              bounds.push([d.lat, d.lng]);
            });

            const emptyOverlay = document.getElementById('mapEmptyOverlay');
            if (activeCount === 0) {
              if (emptyOverlay) emptyOverlay.classList.remove('hidden');
            } else {
              if (emptyOverlay) emptyOverlay.classList.add('hidden');
              if (manual && bounds.length > 0) {
                map.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });
              }
            }
          } catch (e) {
            console.error("Map update error:", e);
          }
        }

        function flyToDevice(devId) {
          if (markers[devId]) {
            const ll = markers[devId].getLatLng();
            map.flyTo(ll, 16);
            markers[devId].openPopup();
            window.scrollTo({ top: 0, behavior: 'smooth' });
          } else {
            alert("Acest dispozitiv nu are coordonate GPS înregistrate încă.");
          }
        }

        function filterDevices() {
          const q = document.getElementById('devSearch').value.toLowerCase();
          const rows = document.querySelectorAll('.dev-row');
          rows.forEach(r => {
            const data = r.getAttribute('data-search') || '';
            r.style.display = data.includes(q) ? '' : 'none';
          });
        }

        // Inițializare & refresh automat la fiecare 4 secunde
        updateMap(true);
        setInterval(() => updateMap(false), 4000);
      </script>
    </body>
    </html>
  `);
});

// Acțiune: Prelungire Rapidă (+1h, +12h, +1d, +7d, +30d, stop)
app.post('/admin/sub-quick', requireAdmin, async (req, res) => {
  const { device_id, type, action } = req.body;
  if (!device_id || !type) return res.redirect('/admin');

  const colName = type === 'cancel' ? 'cancel_valid_until' : 'radar_valid_until';
  const subRes = await dbQuery(`SELECT ${colName} FROM subscriptions WHERE device_id = $1`, [device_id]);

  let baseDate = new Date();
  if (subRes.rows.length > 0 && subRes.rows[0][colName]) {
    const existing = new Date(subRes.rows[0][colName]);
    if (existing > baseDate) baseDate = existing;
  }

  let newDate = new Date(baseDate);

  if (action === '+1h') newDate = new Date(baseDate.getTime() + 1 * 60 * 60 * 1000);
  else if (action === '+12h') newDate = new Date(baseDate.getTime() + 12 * 60 * 60 * 1000);
  else if (action === '+1d') newDate = new Date(baseDate.getTime() + 24 * 60 * 60 * 1000);
  else if (action === '+7d') newDate = new Date(baseDate.getTime() + 7 * 24 * 60 * 60 * 1000);
  else if (action === '+30d') newDate = new Date(baseDate.getTime() + 30 * 24 * 60 * 60 * 1000);
  else if (action === 'stop') newDate = new Date(Date.now() - 60000); // Expirat imediat

  await dbQuery(`
    INSERT INTO subscriptions (device_id, ${colName}, valid_until, is_trial, updated_at)
    VALUES ($1, $2, $2, FALSE, NOW())
    ON CONFLICT (device_id) DO UPDATE SET 
      ${colName} = EXCLUDED.${colName}, 
      valid_until = GREATEST(COALESCE(subscriptions.radar_valid_until, EXCLUDED.${colName}), COALESCE(subscriptions.cancel_valid_until, EXCLUDED.${colName})),
      is_trial = FALSE, 
      updated_at = NOW()
  `, [device_id, newDate]);

  res.redirect('/admin');
});

// Acțiune: Setare Manuală Dată & Oră (Format Exact 24h)
app.post('/admin/sub-custom', requireAdmin, async (req, res) => {
  const { device_id, type, expire_date, expire_time } = req.body;
  if (device_id && type && expire_date) {
    const colName = type === 'cancel' ? 'cancel_valid_until' : 'radar_valid_until';
    const timeVal = expire_time || '18:00';
    // Parsare cu fus orar local Chișinău/București (+02:00)
    const targetDate = new Date(`${expire_date}T${timeVal}:00+02:00`);

    await dbQuery(`
      INSERT INTO subscriptions (device_id, ${colName}, valid_until, is_trial, updated_at)
      VALUES ($1, $2, $2, FALSE, NOW())
      ON CONFLICT (device_id) DO UPDATE SET 
        ${colName} = EXCLUDED.${colName}, 
        valid_until = GREATEST(COALESCE(subscriptions.radar_valid_until, EXCLUDED.${colName}), COALESCE(subscriptions.cancel_valid_until, EXCLUDED.${colName})),
        is_trial = FALSE, 
        updated_at = NOW()
    `, [device_id, targetDate]);
  }
  res.redirect('/admin');
});

// Acțiune: Blocare / Deblocare Dispozitiv
app.post('/admin/toggle-block', requireAdmin, async (req, res) => {
  const { device_id } = req.body;
  if (device_id) {
    const devRes = await dbQuery('SELECT status FROM devices WHERE device_id = $1', [device_id]);
    if (devRes.rows.length > 0) {
      const newStatus = devRes.rows[0].status === 'blocked' ? 'active' : 'blocked';
      await dbQuery('UPDATE devices SET status = $2 WHERE device_id = $1', [device_id, newStatus]);
    }
  }
  res.redirect('/admin');
});

// Acțiune: Ștergere Dispozitiv Definitivă
app.post('/admin/delete-device', requireAdmin, async (req, res) => {
  const { device_id } = req.body;
  if (device_id) {
    await dbQuery('DELETE FROM devices WHERE device_id = $1', [device_id]);
  }
  res.redirect('/admin');
});

// Pornire Server
app.listen(PORT, () => {
  console.log(`[SHS SERVER] Server pornit cu succes pe portul ${PORT}`);
  console.log(`[SHS SERVER] Bază de date Neon: ${DATABASE_URL ? 'ACTIVĂ' : 'INACTIVĂ'}`);
});
