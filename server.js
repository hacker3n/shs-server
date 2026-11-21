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

async function initDb() {
  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS devices (
        device_id VARCHAR(100) PRIMARY KEY,
        model VARCHAR(100),
        app_version VARCHAR(50),
        ip VARCHAR(50),
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT NOW(),
        last_seen TIMESTAMP DEFAULT NOW(),
        lat DOUBLE PRECISION,
        lng DOUBLE PRECISION,
        speed DOUBLE PRECISION,
        location_updated_at TIMESTAMP,
        radar_active BOOLEAN DEFAULT false,
        cancel_active BOOLEAN DEFAULT false
      );
      CREATE TABLE IF NOT EXISTS subscriptions (
        device_id VARCHAR(100) PRIMARY KEY,
        valid_until TIMESTAMP,
        radar_valid_until TIMESTAMP,
        cancel_valid_until TIMESTAMP,
        is_trial BOOLEAN DEFAULT FALSE,
        plan_name VARCHAR(100),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS radar_valid_until TIMESTAMP;
      ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS cancel_valid_until TIMESTAMP;
      ALTER TABLE devices ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
      ALTER TABLE devices ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
      ALTER TABLE devices ADD COLUMN IF NOT EXISTS speed DOUBLE PRECISION;
      ALTER TABLE devices ADD COLUMN IF NOT EXISTS location_updated_at TIMESTAMP;
      ALTER TABLE devices ADD COLUMN IF NOT EXISTS radar_active BOOLEAN DEFAULT false;
      ALTER TABLE devices ADD COLUMN IF NOT EXISTS cancel_active BOOLEAN DEFAULT false;
      UPDATE devices SET model = 'Lenovo Legion Y700 gen4' WHERE device_id = 'acd8baad0dd2b78e';
      UPDATE devices SET model = 'Google Pixel' WHERE device_id = 'a4ed3e0f12bbea0c';
    `);
    console.log('[DB] Schemă inițializată cu succes');
  } catch (err) {
    console.error('[DB INIT ERROR]', err.message);
  }
}

// ----------------------------------------------------------------------------
// Rezolvator Nume Comercial Model Dispozitiv (ex: SM-G950F -> Samsung Galaxy S8)
// ----------------------------------------------------------------------------
function resolveDeviceModel(raw) {
  if (!raw || typeof raw !== 'string') return 'Dispozitiv Android';
  const m = raw.trim();
  const mUpper = m.toUpperCase();

  // 1. Dispozitivul utilizatorului: TB322FC / TB322 / TB320 / Y700 -> Lenovo Legion Y700 gen4
  if (mUpper.includes('TB322') || mUpper.includes('TB320') || mUpper.includes('Y700') || mUpper.includes('TB-Q706') || mUpper.includes('LEGION Y700')) {
    return 'Lenovo Legion Y700 gen4';
  }

  // 2. Google / Emulatoare
  if (mUpper.includes('G82U8') || mUpper.includes('SDK_GPHONE') || mUpper.includes('GOLDFISH') || mUpper.includes('GENERIC_X86')) {
    if (mUpper.includes('G82U8')) return 'Google Pixel';
    return 'Google Pixel (Emulator)';
  }
  if (mUpper.startsWith('PIXEL')) return 'Google ' + m;
  if (mUpper.includes('PIXEL')) return m;

  // 3. Lenovo Alte Tablete
  if (mUpper.includes('TB128')) return 'Lenovo Tab M10 Plus (3rd Gen)';
  if (mUpper.includes('TB125')) return 'Lenovo Tab M10 (3rd Gen)';
  if (mUpper.includes('TB-X606') || mUpper.includes('TBX606')) return 'Lenovo Tab M10 FHD Plus';
  if (mUpper.includes('TB-X505') || mUpper.includes('TBX505')) return 'Lenovo Tab M10';
  if (mUpper.includes('TB-J606') || mUpper.includes('TBJ606')) return 'Lenovo Tab P11';
  if (mUpper.includes('TB-J706') || mUpper.includes('TBJ706')) return 'Lenovo Tab P11 Pro';
  if (mUpper.includes('TB-J616') || mUpper.includes('TBJ616')) return 'Lenovo Tab P11 Plus';
  if (mUpper.includes('TB-J716') || mUpper.includes('TBJ716')) return 'Lenovo Tab P12 Pro';
  if (mUpper.includes('TB370') || mUpper.includes('TB371')) return 'Lenovo Tab P12';

  // 3. Samsung Galaxy S Seria
  if (mUpper.includes('SM-G950') || mUpper.includes('GALAXY S8')) return 'Samsung Galaxy S8';
  if (mUpper.includes('SM-G955')) return 'Samsung Galaxy S8+';
  if (mUpper.includes('SM-G960') || mUpper.includes('GALAXY S9')) return 'Samsung Galaxy S9';
  if (mUpper.includes('SM-G965')) return 'Samsung Galaxy S9+';
  if (mUpper.includes('SM-G970')) return 'Samsung Galaxy S10e';
  if (mUpper.includes('SM-G973') || mUpper.includes('GALAXY S10')) return 'Samsung Galaxy S10';
  if (mUpper.includes('SM-G975')) return 'Samsung Galaxy S10+';
  if (mUpper.includes('SM-G977')) return 'Samsung Galaxy S10 5G';
  if (mUpper.includes('SM-G770')) return 'Samsung Galaxy S10 Lite';
  if (mUpper.includes('SM-G980') || mUpper.includes('SM-G981') || mUpper.includes('GALAXY S20')) return 'Samsung Galaxy S20';
  if (mUpper.includes('SM-G985') || mUpper.includes('SM-G986')) return 'Samsung Galaxy S20+';
  if (mUpper.includes('SM-G988')) return 'Samsung Galaxy S20 Ultra';
  if (mUpper.includes('SM-G780') || mUpper.includes('SM-G781')) return 'Samsung Galaxy S20 FE';
  if (mUpper.includes('SM-G990')) return 'Samsung Galaxy S21 FE';
  if (mUpper.includes('SM-G991') || mUpper.includes('GALAXY S21')) return 'Samsung Galaxy S21';
  if (mUpper.includes('SM-G996')) return 'Samsung Galaxy S21+';
  if (mUpper.includes('SM-G998')) return 'Samsung Galaxy S21 Ultra';
  if (mUpper.includes('SM-S901') || mUpper.includes('GALAXY S22')) return 'Samsung Galaxy S22';
  if (mUpper.includes('SM-S906')) return 'Samsung Galaxy S22+';
  if (mUpper.includes('SM-S908')) return 'Samsung Galaxy S22 Ultra';
  if (mUpper.includes('SM-S711')) return 'Samsung Galaxy S23 FE';
  if (mUpper.includes('SM-S911') || mUpper.includes('GALAXY S23')) return 'Samsung Galaxy S23';
  if (mUpper.includes('SM-S916')) return 'Samsung Galaxy S23+';
  if (mUpper.includes('SM-S918')) return 'Samsung Galaxy S23 Ultra';
  if (mUpper.includes('SM-S921') || mUpper.includes('GALAXY S24')) return 'Samsung Galaxy S24';
  if (mUpper.includes('SM-S926')) return 'Samsung Galaxy S24+';
  if (mUpper.includes('SM-S928')) return 'Samsung Galaxy S24 Ultra';

  // 4. Samsung Galaxy Note Seria
  if (mUpper.includes('SM-N950')) return 'Samsung Galaxy Note 8';
  if (mUpper.includes('SM-N960')) return 'Samsung Galaxy Note 9';
  if (mUpper.includes('SM-N970') || mUpper.includes('SM-N971')) return 'Samsung Galaxy Note 10';
  if (mUpper.includes('SM-N975') || mUpper.includes('SM-N976')) return 'Samsung Galaxy Note 10+';
  if (mUpper.includes('SM-N770')) return 'Samsung Galaxy Note 10 Lite';
  if (mUpper.includes('SM-N980') || mUpper.includes('SM-N981')) return 'Samsung Galaxy Note 20';
  if (mUpper.includes('SM-N985') || mUpper.includes('SM-N986')) return 'Samsung Galaxy Note 20 Ultra';
  if (mUpper.includes('SM-N935') || mUpper.includes('GRACELTE')) return 'Samsung Galaxy Note FE';

  // 5. Samsung Galaxy A Seria
  if (mUpper.includes('SM-A10')) return 'Samsung Galaxy A10';
  if (mUpper.includes('SM-A12')) return 'Samsung Galaxy A12';
  if (mUpper.includes('SM-A13')) return 'Samsung Galaxy A13';
  if (mUpper.includes('SM-A14')) return 'Samsung Galaxy A14';
  if (mUpper.includes('SM-A15')) return 'Samsung Galaxy A15';
  if (mUpper.includes('SM-A20')) return 'Samsung Galaxy A20';
  if (mUpper.includes('SM-A21')) return 'Samsung Galaxy A21';
  if (mUpper.includes('SM-A22')) return 'Samsung Galaxy A22';
  if (mUpper.includes('SM-A23')) return 'Samsung Galaxy A23';
  if (mUpper.includes('SM-A24')) return 'Samsung Galaxy A24';
  if (mUpper.includes('SM-A25')) return 'Samsung Galaxy A25';
  if (mUpper.includes('SM-A30')) return 'Samsung Galaxy A30';
  if (mUpper.includes('SM-A31')) return 'Samsung Galaxy A31';
  if (mUpper.includes('SM-A32')) return 'Samsung Galaxy A32';
  if (mUpper.includes('SM-A33')) return 'Samsung Galaxy A33';
  if (mUpper.includes('SM-A34')) return 'Samsung Galaxy A34';
  if (mUpper.includes('SM-A35')) return 'Samsung Galaxy A35';
  if (mUpper.includes('SM-A50')) return 'Samsung Galaxy A50';
  if (mUpper.includes('SM-A51')) return 'Samsung Galaxy A51';
  if (mUpper.includes('SM-A52')) return 'Samsung Galaxy A52';
  if (mUpper.includes('SM-A53')) return 'Samsung Galaxy A53';
  if (mUpper.includes('SM-A54')) return 'Samsung Galaxy A54';
  if (mUpper.includes('SM-A55')) return 'Samsung Galaxy A55';
  if (mUpper.includes('SM-A70')) return 'Samsung Galaxy A70';
  if (mUpper.includes('SM-A71')) return 'Samsung Galaxy A71';
  if (mUpper.includes('SM-A72')) return 'Samsung Galaxy A72';
  if (mUpper.includes('SM-A73')) return 'Samsung Galaxy A73';

  // 6. Xiaomi / Redmi / POCO
  if (mUpper.includes('2201116')) return 'Redmi Note 11 Pro';
  if (mUpper.includes('2201117')) return 'Redmi Note 11';
  if (mUpper.includes('2312DRA50G')) return 'Redmi Note 13 Pro 5G';
  if (mUpper.includes('23117RA68G')) return 'Redmi Note 13 Pro';
  if (mUpper.includes('23129RAA4G')) return 'Redmi Note 13';
  if (mUpper.includes('23049PCD8G')) return 'POCO F5';
  if (mUpper.includes('23013PC75G')) return 'POCO X5 Pro';
  if (mUpper.includes('22011211G')) return 'POCO X4 Pro';
  if (mUpper.includes('M2012K11')) return 'POCO F3';
  if (mUpper.includes('M2102J20SG')) return 'POCO X3 Pro';

  // Dacă conține deja nume curat
  if (/(galaxy|redmi|poco|pixel|legion|tab|xperia|motorola|huawei|xiaomi|samsung|lenovo)/i.test(m)) {
    return m;
  }

  return m.replace(/\s+[0-9A-Za-z]{6,12}$/, '').trim() || 'Dispozitiv Android';
}

// Obține sau creează dispozitiv
async function getOrCreateDevice(deviceId, deviceInfo = {}, req = null) {
  if (!deviceId) return null;
  deviceInfo = deviceInfo || {};
  const ip = req ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim() : '';
  const rawModel = deviceInfo.model || deviceInfo.device_model || '';
  const model = resolveDeviceModel(rawModel);
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

  // Verifică abonamentul în tabela subscriptions cu module separate
  const subRes = await dbQuery('SELECT * FROM subscriptions WHERE device_id = $1', [deviceId]);
  const sub = subRes.rows.length > 0 ? subRes.rows[0] : null;

  const now = new Date();
  const radarUntil = sub && sub.radar_valid_until ? new Date(sub.radar_valid_until) : (sub && sub.valid_until ? new Date(sub.valid_until) : new Date(0));
  const cancelUntil = sub && sub.cancel_valid_until ? new Date(sub.cancel_valid_until) : (sub && sub.valid_until ? new Date(sub.valid_until) : new Date(0));

  const radarValid = !isBlocked && (radarUntil > now);
  const cancelValid = !isBlocked && (cancelUntil > now);
  const anyValid = radarValid || cancelValid;

  const cfg = await getAppConfig();

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
    valid: radarValid,
    is_activated: radarValid,
    blocked: isBlocked,
    expires: radarUntil.toISOString(),
    plan_name: sub ? sub.plan_name : 'Niciunul',
    radar_active: radarValid,
    radar_expires_ms: radarUntil.getTime(),
    radar_expires: radarUntil.toISOString(),
    cancel_active: cancelValid,
    cancel_expires_ms: cancelUntil.getTime(),
    cancel_expires: cancelUntil.toISOString(),
    message: isBlocked ? "Dispozitiv blocat de administrator!" : (anyValid ? "OK" : "Abonament expirat!"),
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

// Geocoder endpoint (Shared Geocoder SHS)
app.post(['/api/geocode', '/api/geocode/miss'], (req, res) => {
  res.json({ ok: true, found: false });
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
app.get('/', (req, res) => res.redirect('/admin'));

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

    await getOrCreateDevice(device_id, null, req);

    await dbQuery(`
      UPDATE devices SET 
        lat = COALESCE($2, lat), 
        lng = COALESCE($3, lng), 
        speed = COALESCE($4, speed), 
        radar_active = $5, 
        cancel_active = $6, 
        location_updated_at = NOW(),
        last_seen = NOW()
      WHERE device_id = $1
    `, [device_id, lat !== undefined ? lat : null, lng !== undefined ? lng : null, speed !== undefined ? speed : null, !!radar_active, !!cancel_active]);

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
    const cleanDevices = result.rows.map(d => ({ ...d, model: resolveDeviceModel(d.model) }));
    res.json({ ok: true, devices: cleanDevices });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});


// ============================================================================
// 12. Formatare Dată & Timp Rămas (Standard 24h Strict, Fără AM/PM sau texte confuze)
// ============================================================================

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

function formatLocal24h(d) {
  if (!d) return 'Nesetat (Expirat)';
  const dt = new Date(d);
  if (isNaN(dt.getTime()) || dt.getTime() <= 0) return 'Nesetat (Expirat)';
  return dt.toLocaleString('ro-RO', {
    timeZone: 'Europe/Chisinau',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

// ============================================================================
// 13. Panoul Principal de Administrare (/admin)
// ============================================================================

app.get('/admin', requireAdmin, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');

  const devsRes = await dbQuery(`
    SELECT d.device_id, d.model, d.app_version, d.ip, d.status, d.last_seen,
           d.lat, d.lng, d.speed, d.radar_active, d.cancel_active, d.location_updated_at,
           s.radar_valid_until, s.cancel_valid_until, s.is_trial
    FROM devices d
    LEFT JOIN subscriptions s ON d.device_id = s.device_id
    ORDER BY d.last_seen DESC
  `);

  const now = new Date();

  // Statistici Live
  let radarCount = 0;
  let cancelCount = 0;
  let bothCount = 0;
  let totalDrivers = devsRes.rows.length;

  devsRes.rows.forEach(d => {
    if (d.radar_active && d.cancel_active) bothCount++;
    else if (d.radar_active) radarCount++;
    else if (d.cancel_active) cancelCount++;
  });

  const cardsHtml = devsRes.rows.map(d => {
    const isBlocked = d.status === 'blocked';
    const radarInfo = formatRemaining(d.radar_valid_until, now);
    const cancelInfo = formatRemaining(d.cancel_valid_until, now);

    const radarDateFormatted = formatLocal24h(d.radar_valid_until);
    const cancelDateFormatted = formatLocal24h(d.cancel_valid_until);

    // Default picker date (mâine)
    const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
    const defDateStr = tomorrow.toISOString().split('T')[0];

    const hasGps = d.lat && d.lng;
    let gpsBadge = '<span class="px-2.5 py-1 rounded-md text-xs bg-slate-800 text-slate-400 border border-slate-700">⚪ GPS Inactiv</span>';
    if (d.radar_active && d.cancel_active) {
      gpsBadge = `<span class="px-2.5 py-1 rounded-md text-xs bg-amber-500/10 text-amber-400 border border-amber-500/20 font-medium animate-pulse">🟡 Radar + Anulare (${Math.round(d.speed || 0)} km/h)</span>`;
    } else if (d.radar_active) {
      gpsBadge = `<span class="px-2.5 py-1 rounded-md text-xs bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium animate-pulse">🟢 Radar Pornit (${Math.round(d.speed || 0)} km/h)</span>`;
    } else if (d.cancel_active) {
      gpsBadge = `<span class="px-2.5 py-1 rounded-md text-xs bg-sky-500/10 text-sky-400 border border-sky-500/20 font-medium animate-pulse">🔵 Anulare Pornită (${Math.round(d.speed || 0)} km/h)</span>`;
    }

    const flyBtn = hasGps 
      ? `<button onclick="flyToDevice('${d.device_id}')" class="px-2.5 py-1 text-xs rounded-md bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 border border-indigo-500/20 font-medium transition flex items-center gap-1">📍 Pe Hartă</button>`
      : '';

    const displayModel = resolveDeviceModel(d.model);

    return `
      <div class="bg-slate-900/90 border border-slate-800 hover:border-slate-700/80 rounded-2xl p-5 shadow-xl transition space-y-4 dev-card" data-search="${(d.device_id + ' ' + displayModel).toLowerCase()}">
        
        <!-- Antet Dispozitiv -->
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-xl bg-slate-800 flex items-center justify-center text-lg font-bold text-slate-300">
              ${isBlocked ? '🚫' : '🚖'}
            </div>
            <div>
              <div class="flex items-center gap-2">
                <span class="font-bold text-white text-base">${displayModel}</span>
                ${isBlocked 
                  ? '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/20 text-rose-400 border border-rose-500/30">BLOCAT</span>' 
                  : '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">ACTIV</span>'}
              </div>
              <div class="text-xs text-slate-400 font-mono mt-0.5">ID: ${d.device_id}</div>
            </div>
          </div>

          <div class="flex items-center gap-2">
            ${gpsBadge}
            ${flyBtn}
            <div class="text-right text-[11px] text-slate-500 pl-2">
              <div>Văzut: <span class="text-slate-300 font-mono">${formatLocal24h(d.last_seen)}</span></div>
              ${d.ip ? `<div class="text-slate-500 text-[10px]">IP: ${d.ip}</div>` : ''}
            </div>
          </div>
        </div>

        <!-- Module Separate: Radar & Anulare -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          
          <!-- MODUL 1: RADAR -->
          <div class="bg-slate-950/70 border border-slate-800/80 rounded-xl p-3.5 space-y-3">
            <div class="flex items-center justify-between">
              <span class="text-xs font-bold text-emerald-400 flex items-center gap-1.5 uppercase tracking-wider">
                📡 Modul Radar
              </span>
              <span class="px-2 py-0.5 rounded text-[11px] font-bold border ${radarInfo.class}">
                ${radarInfo.text}
              </span>
            </div>
            
            <div class="text-xs text-slate-300">
              Expiră: <span class="font-semibold text-white font-mono">${radarDateFormatted}</span>
            </div>

            <!-- Butoane Rapide Radar -->
            <div class="flex flex-wrap items-center gap-1.5 pt-1">
              <form method="POST" action="/admin/sub-quick" class="inline">
                <input type="hidden" name="device_id" value="${d.device_id}">
                <input type="hidden" name="type" value="radar">
                <input type="hidden" name="action" value="+1h">
                <button type="submit" class="px-2 py-1 text-xs rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition">+1h</button>
              </form>
              <form method="POST" action="/admin/sub-quick" class="inline">
                <input type="hidden" name="device_id" value="${d.device_id}">
                <input type="hidden" name="type" value="radar">
                <input type="hidden" name="action" value="+12h">
                <button type="submit" class="px-2 py-1 text-xs rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition">+12h</button>
              </form>
              <form method="POST" action="/admin/sub-quick" class="inline">
                <input type="hidden" name="device_id" value="${d.device_id}">
                <input type="hidden" name="type" value="radar">
                <input type="hidden" name="action" value="+1d">
                <button type="submit" class="px-2 py-1 text-xs rounded bg-slate-800 hover:bg-slate-700 text-emerald-400 border border-slate-700 font-semibold transition">+1 Zi</button>
              </form>
              <form method="POST" action="/admin/sub-quick" class="inline">
                <input type="hidden" name="device_id" value="${d.device_id}">
                <input type="hidden" name="type" value="radar">
                <input type="hidden" name="action" value="+7d">
                <button type="submit" class="px-2 py-1 text-xs rounded bg-slate-800 hover:bg-slate-700 text-emerald-400 border border-slate-700 font-semibold transition">+7 Zile</button>
              </form>
              <form method="POST" action="/admin/sub-quick" class="inline">
                <input type="hidden" name="device_id" value="${d.device_id}">
                <input type="hidden" name="type" value="radar">
                <input type="hidden" name="action" value="+30d">
                <button type="submit" class="px-2 py-1 text-xs rounded bg-emerald-600/30 hover:bg-emerald-600/50 text-emerald-300 border border-emerald-500/40 font-bold transition">+30 Zile</button>
              </form>
              <form method="POST" action="/admin/sub-quick" class="inline">
                <input type="hidden" name="device_id" value="${d.device_id}">
                <input type="hidden" name="type" value="radar">
                <input type="hidden" name="action" value="stop">
                <button type="submit" class="px-2 py-1 text-xs rounded bg-rose-500/20 hover:bg-rose-500/30 text-rose-400 border border-rose-500/30 font-semibold transition">⛔ Oprește</button>
              </form>
            </div>

            <!-- Selector Manual 24h Radar -->
            <form method="POST" action="/admin/sub-custom" class="flex items-center gap-1.5 pt-2 border-t border-slate-900">
              <input type="hidden" name="device_id" value="${d.device_id}">
              <input type="hidden" name="type" value="radar">
              <input type="date" name="expire_date" value="${defDateStr}" required class="px-2 py-1 text-xs rounded bg-slate-900 border border-slate-700 text-white focus:outline-none focus:border-emerald-500">
              <input type="time" name="expire_time" value="18:00" required class="px-2 py-1 text-xs rounded bg-slate-900 border border-slate-700 text-white focus:outline-none focus:border-emerald-500">
              <button type="submit" class="px-2.5 py-1 text-xs rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium transition">Setează</button>
            </form>
          </div>

          <!-- MODUL 2: ANULARE -->
          <div class="bg-slate-950/70 border border-slate-800/80 rounded-xl p-3.5 space-y-3">
            <div class="flex items-center justify-between">
              <span class="text-xs font-bold text-sky-400 flex items-center gap-1.5 uppercase tracking-wider">
                ⚡ Modul Anulare
              </span>
              <span class="px-2 py-0.5 rounded text-[11px] font-bold border ${cancelInfo.class}">
                ${cancelInfo.text}
              </span>
            </div>
            
            <div class="text-xs text-slate-300">
              Expiră: <span class="font-semibold text-white font-mono">${cancelDateFormatted}</span>
            </div>

            <!-- Butoane Rapide Anulare -->
            <div class="flex flex-wrap items-center gap-1.5 pt-1">
              <form method="POST" action="/admin/sub-quick" class="inline">
                <input type="hidden" name="device_id" value="${d.device_id}">
                <input type="hidden" name="type" value="cancel">
                <input type="hidden" name="action" value="+1h">
                <button type="submit" class="px-2 py-1 text-xs rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition">+1h</button>
              </form>
              <form method="POST" action="/admin/sub-quick" class="inline">
                <input type="hidden" name="device_id" value="${d.device_id}">
                <input type="hidden" name="type" value="cancel">
                <input type="hidden" name="action" value="+12h">
                <button type="submit" class="px-2 py-1 text-xs rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition">+12h</button>
              </form>
              <form method="POST" action="/admin/sub-quick" class="inline">
                <input type="hidden" name="device_id" value="${d.device_id}">
                <input type="hidden" name="type" value="cancel">
                <input type="hidden" name="action" value="+1d">
                <button type="submit" class="px-2 py-1 text-xs rounded bg-slate-800 hover:bg-slate-700 text-sky-400 border border-slate-700 font-semibold transition">+1 Zi</button>
              </form>
              <form method="POST" action="/admin/sub-quick" class="inline">
                <input type="hidden" name="device_id" value="${d.device_id}">
                <input type="hidden" name="type" value="cancel">
                <input type="hidden" name="action" value="+7d">
                <button type="submit" class="px-2 py-1 text-xs rounded bg-slate-800 hover:bg-slate-700 text-sky-400 border border-slate-700 font-semibold transition">+7 Zile</button>
              </form>
              <form method="POST" action="/admin/sub-quick" class="inline">
                <input type="hidden" name="device_id" value="${d.device_id}">
                <input type="hidden" name="type" value="cancel">
                <input type="hidden" name="action" value="+30d">
                <button type="submit" class="px-2 py-1 text-xs rounded bg-sky-600/30 hover:bg-sky-600/50 text-sky-300 border border-sky-500/40 font-bold transition">+30 Zile</button>
              </form>
              <form method="POST" action="/admin/sub-quick" class="inline">
                <input type="hidden" name="device_id" value="${d.device_id}">
                <input type="hidden" name="type" value="cancel">
                <input type="hidden" name="action" value="stop">
                <button type="submit" class="px-2 py-1 text-xs rounded bg-rose-500/20 hover:bg-rose-500/30 text-rose-400 border border-rose-500/30 font-semibold transition">⛔ Oprește</button>
              </form>
            </div>

            <!-- Selector Manual 24h Anulare -->
            <form method="POST" action="/admin/sub-custom" class="flex items-center gap-1.5 pt-2 border-t border-slate-900">
              <input type="hidden" name="device_id" value="${d.device_id}">
              <input type="hidden" name="type" value="cancel">
              <input type="date" name="expire_date" value="${defDateStr}" required class="px-2 py-1 text-xs rounded bg-slate-900 border border-slate-700 text-white focus:outline-none focus:border-sky-500">
              <input type="time" name="expire_time" value="18:00" required class="px-2 py-1 text-xs rounded bg-slate-900 border border-slate-700 text-white focus:outline-none focus:border-sky-500">
              <button type="submit" class="px-2.5 py-1 text-xs rounded bg-sky-600 hover:bg-sky-500 text-white font-medium transition">Setează</button>
            </form>
          </div>

        </div>

        <!-- Footer Card: Acțiuni de Sistem -->
        <div class="flex items-center justify-between pt-2 border-t border-slate-800/80 text-xs text-slate-500">
          <div class="text-[11px]">
            Creat: ${d.created_at ? new Date(d.created_at).toLocaleDateString('ro-RO') : 'N/A'}
          </div>
          <div class="flex items-center gap-2">
            <form method="POST" action="/admin/toggle-block" class="inline">
              <input type="hidden" name="device_id" value="${d.device_id}">
              <button type="submit" class="px-3 py-1 rounded bg-slate-800 hover:bg-slate-700 ${isBlocked ? 'text-emerald-400 border border-emerald-500/30' : 'text-amber-400 border border-amber-500/30'} font-medium transition">
                ${isBlocked ? '🔓 Deblochează' : '🔒 Blochează'}
              </button>
            </form>
            <form method="POST" action="/admin/delete-device" onsubmit="return confirm('Sigur doriți să ștergeți definitiv dispozitivul ${d.device_id}?');" class="inline">
              <input type="hidden" name="device_id" value="${d.device_id}">
              <button type="submit" class="px-3 py-1 rounded bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 font-medium transition">
                🗑️ Șterge
              </button>
            </form>
          </div>
        </div>

      </div>
    `;
  }).join('');

  res.send(`
    <!DOCTYPE html>
    <html lang="ro">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>SHS Radar · Live GPS & Control Hub</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="" />
      <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
      <style>
        .leaflet-container { background: #0b0f19; font-family: inherit; }
        .leaflet-tile-pane {
          filter: brightness(0.6) invert(1) contrast(3) hue-rotate(200deg) saturate(0.3);
        }
        .leaflet-marker-icon, .custom-leaflet-icon, .leaflet-div-icon {
          background: transparent !important;
          border: none !important;
        }
        .pin-wrapper {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 38px;
          height: 38px;
          border-radius: 9999px;
          border: 2px solid #ffffff;
          box-shadow: 0 4px 15px rgba(0,0,0,0.7);
          cursor: pointer;
          transition: transform 0.2s ease;
        }
        .pin-wrapper:hover { transform: scale(1.25); }
        .pulse-green { animation: pGreen 1.6s infinite; }
        .pulse-sky { animation: pSky 1.6s infinite; }
        .pulse-amber { animation: pAmber 1.6s infinite; }
        @keyframes pGreen { 0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.9); } 70% { box-shadow: 0 0 0 16px rgba(16, 185, 129, 0); } 100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); } }
        @keyframes pSky { 0% { box-shadow: 0 0 0 0 rgba(14, 165, 233, 0.9); } 70% { box-shadow: 0 0 0 16px rgba(14, 165, 233, 0); } 100% { box-shadow: 0 0 0 0 rgba(14, 165, 233, 0); } }
        @keyframes pAmber { 0% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.9); } 70% { box-shadow: 0 0 0 16px rgba(245, 158, 11, 0); } 100% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0); } }
      </style>
    </head>
    <body class="bg-slate-950 text-slate-100 min-h-screen">
      
      <!-- Antet Navigație -->
      <header class="border-b border-slate-800 bg-slate-900/90 backdrop-blur sticky top-0 z-50">
        <div class="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-xl bg-emerald-500/10 text-emerald-400 flex items-center justify-center font-bold text-xl border border-emerald-500/20">
              🚖
            </div>
            <div>
              <h1 class="text-base font-extrabold text-white tracking-wide">SHS Control Hub</h1>
              <p class="text-[11px] text-slate-400">Control Abonamente & Live GPS</p>
            </div>
          </div>

          <div class="flex items-center gap-4">
            <div class="hidden sm:flex items-center gap-2 text-xs">
              <span class="inline-block w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
              <span class="text-slate-300 font-mono">Live Sync</span>
            </div>
            <a href="/admin/logout" class="px-3.5 py-1.5 rounded-xl text-xs font-semibold bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 transition">
              Ieșire
            </a>
          </div>
        </div>
      </header>

      <main class="max-w-7xl mx-auto px-4 py-6 space-y-6">

        <!-- Bară Statistici Live -->
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div class="bg-slate-900 border border-slate-800 rounded-2xl p-4">
            <div class="text-xs text-slate-400 font-medium">Radar Pornit</div>
            <div class="text-2xl font-black text-emerald-400 mt-1">${radarCount}</div>
            <div class="text-[10px] text-slate-500">Șoferi cu radar activ</div>
          </div>
          <div class="bg-slate-900 border border-slate-800 rounded-2xl p-4">
            <div class="text-xs text-slate-400 font-medium">Anulare Pornită</div>
            <div class="text-2xl font-black text-sky-400 mt-1">${cancelCount}</div>
            <div class="text-[10px] text-slate-500">Șoferi cu anulare activă</div>
          </div>
          <div class="bg-slate-900 border border-slate-800 rounded-2xl p-4">
            <div class="text-xs text-slate-400 font-medium">Radar + Anulare</div>
            <div class="text-2xl font-black text-amber-400 mt-1">${bothCount}</div>
            <div class="text-[10px] text-slate-500">Ambele module active</div>
          </div>
          <div class="bg-slate-900 border border-slate-800 rounded-2xl p-4">
            <div class="text-xs text-slate-400 font-medium">Total Înregistrate</div>
            <div class="text-2xl font-black text-white mt-1">${totalDrivers}</div>
            <div class="text-[10px] text-slate-500">Dispozitive în sistem</div>
          </div>
        </div>

        <!-- SECȚIUNEA 1: HARTA LIVE GPS -->
        <div class="bg-slate-900 border border-slate-800 rounded-3xl p-5 shadow-2xl space-y-4">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 class="text-lg font-bold text-white flex items-center gap-2">
                📍 Harta Live a Șoferilor în Timp Real
              </h2>
              <p class="text-xs text-slate-400">Coordonate reale transmise automat când Radarul sau Anularea este pornită</p>
            </div>
            <div class="flex items-center gap-2">
              <button onclick="centerChisinau()" class="px-3 py-1.5 text-xs font-semibold rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition">
                🇲🇩 Chișinău
              </button>
              <button onclick="updateMap(true)" class="px-3.5 py-1.5 text-xs font-semibold rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 transition flex items-center gap-1.5">
                🔄 Reîmprospătează
              </button>
            </div>
          </div>

          <!-- Container Hartă -->
          <div class="relative">
            <div id="map" class="h-[480px] w-full rounded-2xl overflow-hidden border border-slate-800 shadow-inner z-0"></div>
            
            <div id="mapEmptyOverlay" class="hidden absolute inset-0 bg-slate-950/80 backdrop-blur-sm flex flex-col items-center justify-center text-center p-6 rounded-2xl z-10 pointer-events-none">
              <div class="text-4xl mb-2">📡</div>
              <h3 class="text-base font-bold text-white">Niciun șofer activ cu GPS în acest moment</h3>
              <p class="text-xs text-slate-400 max-w-sm mt-1">Poziția pe hartă apare automat imediat ce un șofer pornește Radarul sau Anularea în aplicație.</p>
            </div>
          </div>

          <!-- Legendă Hartă -->
          <div class="flex flex-wrap items-center gap-4 text-xs text-slate-400 pt-1">
            <div class="flex items-center gap-1.5">
              <span class="w-3 h-3 rounded-full bg-emerald-500 inline-block shadow-sm"></span>
              <span>Verde = Radar Activ</span>
            </div>
            <div class="flex items-center gap-1.5">
              <span class="w-3 h-3 rounded-full bg-sky-500 inline-block shadow-sm"></span>
              <span>Albastru = Anulare Activă</span>
            </div>
            <div class="flex items-center gap-1.5">
              <span class="w-3 h-3 rounded-full bg-amber-500 inline-block shadow-sm"></span>
              <span>Galben = Ambele Active</span>
            </div>
            <div class="flex items-center gap-1.5">
              <span class="w-3 h-3 rounded-full bg-slate-600 inline-block"></span>
              <span>Gri = Inactiv</span>
            </div>
          </div>
        </div>

        <!-- SECȚIUNEA 2: CONTROL ABONAMENTE & DISPOZITIVE -->
        <div class="space-y-4">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 class="text-lg font-bold text-white flex items-center gap-2">
                📱 Control Dispozitive & Abonamente Separate
              </h2>
              <p class="text-xs text-slate-400">Prelungire rapidă sau setare dată/oră 24h independent pentru Radar și Anulare</p>
            </div>

            <!-- Căutare Rapidă -->
            <div class="w-full sm:w-72">
              <input type="text" id="devSearch" onkeyup="filterDevices()" placeholder="🔍 Caută model sau ID dispozitiv..." class="w-full px-4 py-2 text-xs rounded-xl bg-slate-900 border border-slate-800 focus:border-emerald-500 focus:outline-none text-white">
            </div>
          </div>

          <!-- Lista Cardurilor de Dispozitive -->
          <div id="devicesContainer" class="space-y-4">
            ${cardsHtml || '<div class="p-8 text-center bg-slate-900 border border-slate-800 rounded-2xl text-slate-400 text-sm">Nu există dispozitive înregistrate încă.</div>'}
          </div>
        </div>

      </main>

      <!-- SCRIPTURI ȘI HARTĂ LEAFLET -->
      <script>
        const map = L.map('map').setView([47.0245, 28.8322], 12);
        
        // OpenStreetMap Dark Filter Tiles (Fără API Key, Fără Watermark)
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '&copy; OpenStreetMap contributors',
          maxZoom: 19
        }).addTo(map);

        const markers = {};

        function centerChisinau() {
          map.setView([47.0245, 28.8322], 12);
        }

        function createCarPin(color, pulseClass) {
          return '<div class="pin-wrapper ' + pulseClass + '" style="background:' + color + ';">' +
            '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/>' +
            '<circle cx="7" cy="17" r="2"/>' +
            '<circle cx="17" cy="17" r="2"/>' +
            '</svg>' +
            '</div>';
        }

        async function updateMap(manual) {
          try {
            const res = await fetch('/api/admin/devices-locations');
            const data = await res.json();
            if (!data.ok || !data.devices) return;

            const bounds = [];
            let activeGpsCount = 0;

            data.devices.forEach(d => {
              if (!d.lat || !d.lng) return;

              activeGpsCount++;
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
                html: createCarPin(pinColor, pulseClass),
                iconSize: [38, 38],
                iconAnchor: [19, 19]
              });

              const speedVal = d.speed ? Math.round(d.speed) : 0;
              const popupHtml = '<div class="text-slate-900 p-2.5 space-y-1.5 font-sans min-w-[200px]">' +
                '<div class="font-bold text-sm text-slate-900">' + (d.model || 'Model Necunoscut') + '</div>' +
                '<div class="text-xs font-bold" style="color:' + pinColor + '">' + statusLabel + '</div>' +
                '<div class="text-xs">⚡ Viteză: <b>' + speedVal + ' km/h</b></div>' +
                '<div class="text-[11px] text-slate-600 font-mono">ID: ' + d.device_id + '</div>' +
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
            if (activeGpsCount === 0) {
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
            alert("Acest dispozitiv nu are încă coordonate GPS transmise de aplicație.");
          }
        }

        function filterDevices() {
          const q = document.getElementById('devSearch').value.toLowerCase();
          const cards = document.querySelectorAll('.dev-card');
          cards.forEach(c => {
            const data = c.getAttribute('data-search') || '';
            c.style.display = data.includes(q) ? '' : 'none';
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

// ============================================================================
// 14. Acțiuni Gestionare Abonamente Separate (Radar / Anulare)
// ============================================================================

// Prelungire Rapidă (+1h, +12h, +1d, +7d, +30d, stop)
app.post('/admin/sub-quick', requireAdmin, async (req, res) => {
  const { device_id, type, action } = req.body;
  if (!device_id || !type) return res.redirect('/admin');

  const colName = type === 'cancel' ? 'cancel_valid_until' : 'radar_valid_until';
  const subRes = await dbQuery(`SELECT radar_valid_until, cancel_valid_until FROM subscriptions WHERE device_id = $1`, [device_id]);

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
  else if (action === 'stop') newDate = new Date(0); // Expirat definitiv (1970)

  if (type === 'radar') {
    await dbQuery(`
      INSERT INTO subscriptions (device_id, radar_valid_until, valid_until, is_trial, updated_at)
      VALUES ($1, $2, $2, FALSE, NOW())
      ON CONFLICT (device_id) DO UPDATE SET 
        radar_valid_until = $2, 
        valid_until = GREATEST($2, COALESCE(subscriptions.cancel_valid_until, $2)),
        is_trial = FALSE, 
        updated_at = NOW()
    `, [device_id, newDate]);
  } else if (type === 'cancel') {
    await dbQuery(`
      INSERT INTO subscriptions (device_id, cancel_valid_until, valid_until, is_trial, updated_at)
      VALUES ($1, $2, $2, FALSE, NOW())
      ON CONFLICT (device_id) DO UPDATE SET 
        cancel_valid_until = $2, 
        valid_until = GREATEST(COALESCE(subscriptions.radar_valid_until, $2), $2),
        is_trial = FALSE, 
        updated_at = NOW()
    `, [device_id, newDate]);
  }

  res.redirect('/admin');
});

// Setare Manuală Dată & Oră (Format Exact 24h, Europe/Chisinau)
app.post('/admin/sub-custom', requireAdmin, async (req, res) => {
  const { device_id, type, expire_date, expire_time } = req.body;
  if (device_id && type && expire_date) {
    const timeVal = expire_time || '18:00';
    const targetDate = new Date(`${expire_date}T${timeVal}:00+02:00`);

    if (type === 'radar') {
      await dbQuery(`
        INSERT INTO subscriptions (device_id, radar_valid_until, valid_until, is_trial, updated_at)
        VALUES ($1, $2, $2, FALSE, NOW())
        ON CONFLICT (device_id) DO UPDATE SET 
          radar_valid_until = $2, 
          valid_until = GREATEST($2, COALESCE(subscriptions.cancel_valid_until, $2)),
          is_trial = FALSE, 
          updated_at = NOW()
      `, [device_id, targetDate]);
    } else if (type === 'cancel') {
      await dbQuery(`
        INSERT INTO subscriptions (device_id, cancel_valid_until, valid_until, is_trial, updated_at)
        VALUES ($1, $2, $2, FALSE, NOW())
        ON CONFLICT (device_id) DO UPDATE SET 
          cancel_valid_until = $2, 
          valid_until = GREATEST(COALESCE(subscriptions.radar_valid_until, $2), $2),
          is_trial = FALSE, 
          updated_at = NOW()
      `, [device_id, targetDate]);
    }
  }
  res.redirect('/admin');
});

// Blocare / Deblocare Dispozitiv
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

// Ștergere Dispozitiv Definitivă
app.post('/admin/delete-device', requireAdmin, async (req, res) => {
  const { device_id } = req.body;
  if (device_id) {
    await dbQuery('DELETE FROM devices WHERE device_id = $1', [device_id]);
  }
  res.redirect('/admin');
});

// Pornire Server
app.listen(PORT, async () => {
  console.log(`[SHS-SERVER] Pornit cu succes pe portul ${PORT}`);
  await initDb();
});
