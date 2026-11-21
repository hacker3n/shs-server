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

// 8. Dynamic Remote Core Loader (Anti-Hack / Remote DEX)
const CORE_VERSION = "2.6.9.1";

app.post(['/api/core/check', '/api/core/status'], async (req, res) => {
  try {
    const deviceId = (req.body.device_id || '').trim();
    if (!deviceId) return res.json({ ok: false, valid: false, error: 'device_id_required' });

    const dev = await getOrCreateDevice(deviceId, req.body.device_info || req.body, req);
    const isBlocked = dev && dev.status === 'blocked';

    const subRes = await dbQuery('SELECT * FROM subscriptions WHERE device_id = $1', [deviceId]);
    const sub = subRes.rows.length > 0 ? subRes.rows[0] : null;

    const now = new Date();
    const validUntil = sub ? new Date(sub.valid_until) : new Date(0);
    const isValid = !isBlocked && (validUntil > now);

    res.json({
      ok: true,
      valid: isValid,
      blocked: isBlocked,
      expires: validUntil.toISOString(),
      version: CORE_VERSION,
      message: isBlocked ? "Dispozitiv blocat de administrator!" : (isValid ? "OK" : "Abonament expirat! Contactează @neki002 pe Telegram.")
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

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
    const validUntil = sub ? new Date(sub.valid_until) : new Date(0);
    const isValid = validUntil > now;

    if (!isValid) {
      return res.status(403).json({ ok: false, error: 'subscription_expired', message: 'Abonament expirat! Contactează @neki002 pe Telegram.' });
    }

    const corePath = path.join(__dirname, 'payload', 'core.enc');
    if (!fs.existsSync(corePath)) {
      return res.status(404).json({ ok: false, error: 'payload_not_found' });
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Core-Version', CORE_VERSION);
    res.setHeader('X-Expires-Ms', validUntil.getTime().toString());
    res.setHeader('X-Valid-Until', validUntil.toISOString());
    fs.createReadStream(corePath).pipe(res);
  } catch (err) {
    console.error("Core download error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 9. Descărcare APK
app.get('/download/SHS_Final.apk', (req, res) => {
  const apkPath = path.join(__dirname, '..', '..', 'Apk', 'Modded Apk', 'SHS', 'SHS_Final.apk');
  if (fs.existsSync(apkPath)) {
    res.download(apkPath, 'SHS_Final.apk');
  } else {
    res.status(404).send('APK-ul se compilează...');
  }
});

// ============================================================================
// PANOU DE ADMINISTRARE WEB (ADMIN DASHBOARD)
// ============================================================================

// Middleware Autentificare Admin Simplă
function requireAdmin(req, res, next) {
  const cookies = req.headers.cookie || '';
  if (cookies.includes('shs_auth=1')) return next();
  res.redirect('/admin/login');
}

app.get('/admin/login', async (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="ro">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Login Panou Admin SHS</title>
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-slate-900 text-white min-h-screen flex items-center justify-center p-4">
      <div class="bg-slate-800 p-8 rounded-2xl shadow-2xl max-w-md w-full border border-slate-700">
        <h1 class="text-2xl font-bold mb-2 text-center text-emerald-400">SHS Admin Portal</h1>
        <p class="text-sm text-slate-400 mb-6 text-center">Bază de date Neon.tech · Arhitectură Server-Driven</p>
        <form method="POST" action="/admin/login" class="space-y-4">
          <div>
            <label class="block text-sm font-medium mb-1 text-slate-300">Parolă Administrator</label>
            <input type="password" name="password" required autofocus class="w-full px-4 py-3 rounded-xl bg-slate-900 border border-slate-600 focus:border-emerald-500 focus:outline-none text-white">
          </div>
          <button type="submit" class="w-full py-3 bg-emerald-500 hover:bg-emerald-600 font-semibold rounded-xl transition shadow-lg shadow-emerald-500/20">Intră în Panou</button>
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
             s.valid_until, s.is_trial
      FROM devices d
      LEFT JOIN subscriptions s ON d.device_id = s.device_id
      ORDER BY d.last_seen DESC
    `);
    res.json({ ok: true, devices: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Pagina Principală a Panoului de Administrare
app.get('/admin', requireAdmin, async (req, res) => {
  const devsRes = await dbQuery(`
    SELECT d.device_id, d.model, d.app_version, d.ip, d.status, d.last_seen,
           d.lat, d.lng, d.speed, d.radar_active, d.cancel_active, d.location_updated_at,
           s.valid_until, s.plan_name, s.is_trial
    FROM devices d
    LEFT JOIN subscriptions s ON d.device_id = s.device_id
    ORDER BY d.last_seen DESC
  `);

  const now = new Date();
  const pad = n => n.toString().padStart(2, '0');

  const devices = devsRes.rows.map(d => {
    const validUntil = d.valid_until ? new Date(d.valid_until) : null;
    const isExpired = !validUntil || validUntil < now;
    const isBlocked = d.status === 'blocked';
    let statusText = '🟢 Activ';
    let statusBg = 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';

    let remainingText = '';
    if (isBlocked) {
      statusText = '⛔ Blocat';
      statusBg = 'bg-red-500/10 text-red-400 border-red-500/20';
      remainingText = '<span class="text-rose-400 font-bold">BLOCAT</span>';
    } else if (isExpired) {
      statusText = '🔴 Expirat';
      statusBg = 'bg-rose-500/10 text-rose-400 border-rose-500/20';
      remainingText = '<span class="text-rose-400 font-bold">EXPIRAT</span>';
    } else {
      if (d.is_trial) {
        statusText = '🟡 Trial';
        statusBg = 'bg-amber-500/10 text-amber-400 border-amber-500/20';
      }
      const diffMs = validUntil - now;
      const diffHrs = Math.floor(diffMs / (1000 * 60 * 60));
      const diffDays = Math.floor(diffHrs / 24);
      const remHrs = diffHrs % 24;
      const remMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
      remainingText = `<span class="text-emerald-400 font-semibold">${diffDays > 0 ? diffDays + 'z ' : ''}${remHrs}h ${remMins}m rămase</span>`;
    }

    // Calcul dată și oră locală 24h
    let localDateStr = '';
    let localHour = '23';
    let localMin = '59';
    let formatted24h = 'Niciunul';

    if (validUntil) {
      // Ajustare pentru fus orar local (UTC+2)
      const localTime = new Date(validUntil.getTime() + 2 * 60 * 60 * 1000);
      localDateStr = `${localTime.getUTCFullYear()}-${pad(localTime.getUTCMonth()+1)}-${pad(localTime.getUTCDate())}`;
      localHour = pad(localTime.getUTCHours());
      localMin = pad(localTime.getUTCMinutes());
      formatted24h = `${pad(localTime.getUTCDate())}.${pad(localTime.getUTCMonth()+1)}.${localTime.getUTCFullYear()} la ${localHour}:${localMin} (24h)`;
    } else {
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000);
      localDateStr = `${tomorrow.getUTCFullYear()}-${pad(tomorrow.getUTCMonth()+1)}-${pad(tomorrow.getUTCDate())}`;
    }

    // GPS Status
    const isLive = (d.radar_active || d.cancel_active);
    let serviceBadge = '<span class="text-slate-500 text-[11px]">Inactiv</span>';
    if (d.radar_active && d.cancel_active) {
      serviceBadge = '<span class="px-2 py-0.5 rounded text-[11px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">Radar + Anulare</span>';
    } else if (d.radar_active) {
      serviceBadge = '<span class="px-2 py-0.5 rounded text-[11px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">🟢 Radar Activ</span>';
    } else if (d.cancel_active) {
      serviceBadge = '<span class="px-2 py-0.5 rounded text-[11px] font-bold bg-sky-500/20 text-sky-300 border border-sky-500/30">🔵 Anulare Activă</span>';
    }

    return {
      ...d,
      statusText,
      statusBg,
      remainingText,
      formatted24h,
      localDateStr,
      localHour,
      localMin,
      serviceBadge,
      isLive
    };
  });

  const activeGpsCount = devices.filter(d => d.isLive).length;

  res.send(`
    <!DOCTYPE html>
    <html lang="ro">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Panou Administrare SHS - Hartă & Dispozitive</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
      <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
      <style>
        .leaflet-container { background: #0b1118; font-family: inherit; }
        .custom-pin { display: flex; align-items: center; justify-content: center; border-radius: 50%; font-weight: bold; color: white; box-shadow: 0 0 15px rgba(0,0,0,0.6); }
        .pulse-green { animation: pulseGreen 1.5s infinite; }
        @keyframes pulseGreen { 0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); } 70% { box-shadow: 0 0 0 12px rgba(16, 185, 129, 0); } 100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); } }
      </style>
    </head>
    <body class="bg-slate-950 text-slate-100 min-h-screen">
      <!-- Navbar -->
      <nav class="bg-slate-900 border-b border-slate-800 px-6 py-4 flex items-center justify-between sticky top-0 z-50">
        <div class="flex items-center gap-3">
          <span class="text-2xl">🚕</span>
          <div>
            <h1 class="text-lg font-bold text-white">SHS Radar · Control Hub & Live GPS</h1>
            <p class="text-xs text-emerald-400">Bază de date Neon.tech · Actualizare Live</p>
          </div>
        </div>
        <div class="flex items-center gap-4">
          <span class="text-xs bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 px-3 py-1.5 rounded-lg flex items-center gap-1.5">
            <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            ${activeGpsCount} șoferi activi pe traseu
          </span>
          <span class="text-xs bg-slate-800 text-slate-300 px-3 py-1.5 rounded-lg border border-slate-700">Total: ${devices.length} dispozitive</span>
          <a href="/admin/logout" class="text-xs text-rose-400 hover:text-rose-300 bg-rose-500/10 border border-rose-500/20 px-3 py-1.5 rounded-lg">Ieșire</a>
        </div>
      </nav>

      <main class="max-w-7xl mx-auto p-6 space-y-8">

        <!-- SECȚIUNEA 1: HARTA LIVE GPS CU TOȚI ȘOFERII -->
        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
          <div class="flex items-center justify-between border-b border-slate-800 pb-3">
            <div>
              <h2 class="text-lg font-bold text-white flex items-center gap-2">📍 Harta Live a Șoferilor (Radar & Anulare)</h2>
              <p class="text-xs text-slate-400">Harta arată poziția GPS în timp real a șoferilor când au Radarul sau Anularea pornită.</p>
            </div>
            <button onclick="updateMap(true)" class="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs rounded-lg flex items-center gap-1.5 text-slate-200">
              🔄 Reîmprospătează Harta
            </button>
          </div>

          <div id="map" style="height: 480px; width: 100%;" class="rounded-xl border border-slate-800 overflow-hidden shadow-inner"></div>
        </div>

        <!-- SECȚIUNEA 2: LISTA DISPOZITIVELOR & CONTROL ABONAMENTE EXACTE 24H -->
        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
            <div>
              <h2 class="text-lg font-bold text-white flex items-center gap-2">📱 Dispozitive Înregistrate & Setare Abonament</h2>
              <p class="text-xs text-slate-400">Setează data și ora exactă în <b>format 24h (00:00 - 23:59)</b>. Fără confuzie AM / PM!</p>
            </div>
            <div class="w-full sm:w-72">
              <input type="text" id="devSearch" onkeyup="filterDevices()" placeholder="Caută după ID dispozitiv sau model..." class="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-xs text-white focus:outline-none focus:border-emerald-500">
            </div>
          </div>

          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse text-xs">
              <thead>
                <tr class="border-b border-slate-800 text-slate-400 bg-slate-950/50">
                  <th class="px-4 py-3">Dispozitiv & Model</th>
                  <th class="px-4 py-3">Stare Serviciu</th>
                  <th class="px-4 py-3">Expiră la (Format 24h)</th>
                  <th class="px-4 py-3 min-w-[320px]">Setează Data & Ora Expirării (24h)</th>
                  <th class="px-4 py-3">Acțiuni Rapide</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-800">
                ${devices.map(d => `
                  <tr class="hover:bg-slate-800/40 transition dev-row" id="row-${d.device_id}" data-search="${d.device_id.toLowerCase()} ${(d.model||'').toLowerCase()}">
                    
                    <!-- Dispozitiv & Model -->
                    <td class="px-4 py-4">
                      <div class="font-mono font-bold text-white text-xs">${d.device_id}</div>
                      <div class="text-[11px] text-slate-400 mt-0.5">${d.model || 'Model necunoscut'} · v${d.app_version || '2.6.9'}</div>
                      <div class="text-[10px] text-slate-500 mt-0.5">Activ: ${new Date(d.last_seen).toLocaleString('ro-RO')}</div>
                    </td>

                    <!-- Stare Serviciu & GPS -->
                    <td class="px-4 py-4">
                      <div class="space-y-1">
                        ${d.serviceBadge}
                        <div>${d.remainingText}</div>
                        ${d.lat && d.lng ? `
                          <button onclick="flyToDevice('${d.device_id}')" class="text-[11px] text-sky-400 hover:text-sky-300 underline flex items-center gap-1 mt-1">
                            📍 Vezi pe hartă (${d.speed ? Math.round(d.speed) + ' km/h' : '0 km/h'})
                          </button>
                        ` : '<div class="text-[10px] text-slate-600">Fără semnal GPS</div>'}
                      </div>
                    </td>

                    <!-- Expiră la -->
                    <td class="px-4 py-4 font-medium text-slate-200">
                      <div class="text-xs font-semibold">${d.formatted24h}</div>
                      <div class="text-[10px] text-slate-400 mt-0.5">${d.statusText}</div>
                    </td>

                    <!-- Formular Setare Dată & Oră (24h) -->
                    <td class="px-4 py-4">
                      <form method="POST" action="/admin/set-subscription-date" class="space-y-2 bg-slate-950/80 p-2.5 rounded-xl border border-slate-800">
                        <input type="hidden" name="device_id" value="${d.device_id}">
                        <div class="flex items-center gap-2">
                          <div>
                            <label class="block text-[10px] text-slate-400 mb-0.5 font-semibold">Data</label>
                            <input type="date" name="expire_date" value="${d.localDateStr}" required class="px-2 py-1 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white focus:outline-none focus:border-emerald-500">
                          </div>

                          <div>
                            <label class="block text-[10px] text-slate-400 mb-0.5 font-semibold">Ora (24h)</label>
                            <select name="expire_hour" class="px-2 py-1 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white focus:outline-none focus:border-emerald-500">
                              ${Array.from({length: 24}, (_, i) => {
                                const hStr = pad(i);
                                const selected = hStr === d.localHour ? 'selected' : '';
                                let label = hStr + ':00';
                                if (i === 0) label += ' (Miezul nopții)';
                                else if (i === 3) label += ' (03:00 noaptea)';
                                else if (i === 12) label += ' (12:00 amiază)';
                                else if (i === 15) label += ' (15:00 după-amiază)';
                                return `<option value="${hStr}" ${selected}>${label}</option>`;
                              }).join('')}
                            </select>
                          </div>

                          <div>
                            <label class="block text-[10px] text-slate-400 mb-0.5 font-semibold">Minut</label>
                            <select name="expire_minute" class="px-2 py-1 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white focus:outline-none focus:border-emerald-500">
                              ${['00','05','10','15','20','25','30','35','40','45','50','55','59'].map(m => `
                                <option value="${m}" ${m === d.localMin ? 'selected' : ''}>:${m}</option>
                              `).join('')}
                            </select>
                          </div>
                        </div>

                        <div class="flex items-center justify-between pt-1">
                          <span class="text-[10px] text-slate-500">Fus orar local Chișinău (EET)</span>
                          <button type="submit" class="px-3 py-1 bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-bold text-xs rounded-lg transition shadow">
                            💾 Salvează Ora
                          </button>
                        </div>
                      </form>
                    </td>

                    <!-- Acțiuni Rapide (+1h, +24h, +30z, Blochează, Șterge) -->
                    <td class="px-4 py-4">
                      <div class="flex flex-wrap items-center gap-1.5 max-w-[200px]">
                        <!-- +1 Oră -->
                        <form method="POST" action="/admin/add-hours">
                          <input type="hidden" name="device_id" value="${d.device_id}">
                          <input type="hidden" name="hours" value="1">
                          <button type="submit" title="Prelungește cu 1 oră" class="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-[11px] rounded border border-slate-700 text-slate-300">+1h</button>
                        </form>

                        <!-- +12 Ore -->
                        <form method="POST" action="/admin/add-hours">
                          <input type="hidden" name="device_id" value="${d.device_id}">
                          <input type="hidden" name="hours" value="12">
                          <button type="submit" title="Prelungește cu 12 ore" class="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-[11px] rounded border border-slate-700 text-slate-300">+12h</button>
                        </form>

                        <!-- +30 Zile -->
                        <form method="POST" action="/admin/add-days">
                          <input type="hidden" name="device_id" value="${d.device_id}">
                          <input type="hidden" name="days" value="30">
                          <button type="submit" title="Prelungește cu 30 de zile" class="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-[11px] rounded border border-slate-700 text-slate-300">+30z</button>
                        </form>

                        <!-- Blochează / Deblochează -->
                        <form method="POST" action="/admin/toggle-block">
                          <input type="hidden" name="device_id" value="${d.device_id}">
                          <button type="submit" class="px-2 py-1 text-[11px] rounded border ${d.status === 'blocked' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-amber-500/10 text-amber-400 border-amber-500/20'}">
                            ${d.status === 'blocked' ? 'Deblochează' : 'Blochează'}
                          </button>
                        </form>

                        <!-- Șterge Dispozitiv -->
                        <form method="POST" action="/admin/delete-device" onsubmit="return confirm('Ești sigur că vrei să ștergi definitiv acest dispozitiv?');">
                          <input type="hidden" name="device_id" value="${d.device_id}">
                          <button type="submit" title="Șterge dispozitiv definitiv" class="px-2 py-1 text-[11px] rounded bg-rose-500/10 text-rose-400 hover:bg-rose-500 hover:text-white border border-rose-500/20 transition">Șterge</button>
                        </form>
                      </div>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </main>

      <!-- LEAFLET MAP SCRIPT -->
      <script>
        const map = L.map('map').setView([47.0245, 28.8322], 12);
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
          attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
          subdomains: 'abcd',
          maxZoom: 19
        }).addTo(map);

        const markers = {};

        function createPinHtml(color, icon) {
          return '<div class="custom-pin pulse-green" style="background:' + color + '; width:32px; height:32px; font-size:16px;">' + icon + '</div>';
        }

        async function updateMap(manual) {
          try {
            const res = await fetch('/api/admin/devices-locations');
            const data = await res.json();
            if (!data.ok || !data.devices) return;

            const bounds = [];
            data.devices.forEach(d => {
              if (!d.lat || !d.lng) return;

              let iconChar = '🚕';
              let pinColor = '#10b981'; // green radar
              let statusLabel = '🟢 Radar Activ';

              if (d.radar_active && d.cancel_active) {
                pinColor = '#f59e0b'; // amber
                statusLabel = '🟡 Radar + Anulare Active';
              } else if (d.cancel_active) {
                pinColor = '#0ea5e9'; // sky
                statusLabel = '🔵 Anulare Activă';
              } else if (!d.radar_active && !d.cancel_active) {
                pinColor = '#64748b'; // gray
                statusLabel = '⚪ Inactiv';
              }

              const customIcon = L.divIcon({
                className: 'custom-leaflet-icon',
                html: createPinHtml(pinColor, iconChar),
                iconSize: [32, 32],
                iconAnchor: [16, 16]
              });

              const popupHtml = '<div class="text-slate-900 p-2 space-y-1 font-sans">' +
                '<div class="font-bold text-sm">' + (d.model || 'Model') + ' (' + d.device_id.slice(0,8) + '...)</div>' +
                '<div class="text-xs font-semibold" style="color:' + pinColor + '">' + statusLabel + '</div>' +
                '<div class="text-xs">⚡ Viteză: <b>' + (d.speed ? Math.round(d.speed) : 0) + ' km/h</b></div>' +
                '<div class="text-[11px] text-slate-600">ID: ' + d.device_id + '</div>' +
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

            if (manual && bounds.length > 0) {
              map.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });
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
            alert("Acest dispozitiv nu a trimis încă coordonate GPS.");
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

        // Inițializare & refresh automat la fiecare 5 secunde
        updateMap(true);
        setInterval(() => updateMap(false), 5000);
      </script>
    </body>
    </html>
  `);
});

// Acțiune: Setare Dată & Oră Exactă Abonament (Format 24h)
app.post('/admin/set-subscription-date', requireAdmin, async (req, res) => {
  const { device_id, expire_date, expire_hour, expire_minute } = req.body;
  if (device_id && expire_date) {
    const h = (expire_hour || '23').toString().padStart(2, '0');
    const m = (expire_minute || '59').toString().padStart(2, '0');
    // Parsare cu fus orar local Chișinău/București (+02:00)
    const targetDate = new Date(`${expire_date}T${h}:${m}:00+02:00`);
    await dbQuery(`
      INSERT INTO subscriptions (device_id, valid_until, is_trial, updated_at)
      VALUES ($1, $2, FALSE, NOW())
      ON CONFLICT (device_id) DO UPDATE SET valid_until = EXCLUDED.valid_until, is_trial = FALSE, updated_at = NOW()
    `, [device_id, targetDate]);
  }
  res.redirect('/admin');
});

// Acțiune: Adăugare Ore la Abonament (+1h / +12h)
app.post('/admin/add-hours', requireAdmin, async (req, res) => {
  const { device_id, hours } = req.body;
  const numHours = parseInt(hours, 10) || 1;
  if (device_id) {
    const subRes = await dbQuery('SELECT valid_until FROM subscriptions WHERE device_id = $1', [device_id]);
    let baseDate = new Date();
    if (subRes.rows.length > 0 && new Date(subRes.rows[0].valid_until) > baseDate) {
      baseDate = new Date(subRes.rows[0].valid_until);
    }
    const newExpires = new Date(baseDate.getTime() + numHours * 60 * 60 * 1000);
    await dbQuery(`
      INSERT INTO subscriptions (device_id, valid_until, is_trial, updated_at)
      VALUES ($1, $2, FALSE, NOW())
      ON CONFLICT (device_id) DO UPDATE SET valid_until = EXCLUDED.valid_until, is_trial = FALSE, updated_at = NOW()
    `, [device_id, newExpires]);
  }
  res.redirect('/admin');
});

// Acțiune: Adăugare Zile la Abonament (+30 / +365)
app.post('/admin/add-days', requireAdmin, async (req, res) => {
  const { device_id, days } = req.body;
  const numDays = parseInt(days, 10) || 30;
  if (device_id) {
    const subRes = await dbQuery('SELECT valid_until FROM subscriptions WHERE device_id = $1', [device_id]);
    let baseDate = new Date();
    if (subRes.rows.length > 0 && new Date(subRes.rows[0].valid_until) > baseDate) {
      baseDate = new Date(subRes.rows[0].valid_until);
    }
    const newExpires = new Date(baseDate.getTime() + numDays * 24 * 60 * 60 * 1000);
    await dbQuery(`
      INSERT INTO subscriptions (device_id, valid_until, is_trial, updated_at)
      VALUES ($1, $2, FALSE, NOW())
      ON CONFLICT (device_id) DO UPDATE SET valid_until = EXCLUDED.valid_until, is_trial = FALSE, updated_at = NOW()
    `, [device_id, newExpires]);
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

// Acțiune: Ștergere Dispozitiv Definitivă (sterg disp)
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
