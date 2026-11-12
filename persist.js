// persist.js — stocare persistentă în PostgreSQL (Render Postgres / Supabase / Neon)
// Înlocuiește scrierea în fișiere .json locale (care se șterg pe Render la fiecare restart/deploy).
//
// Setezi variabila de mediu DATABASE_URL în Render. Fără ea, cade înapoi pe fișiere (local/test).
const fs = require('fs');
const path = require('path');

let pool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
}

const cache = {};      // name -> ultimul JSON string trimis
const timers = {};     // debounce per nume

async function init() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS kv (
    name TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now()
  )`);
}

// Citește (async) o dată, la pornire
async function load(name, fileFallback) {
  if (pool) {
    const r = await pool.query('SELECT data FROM kv WHERE name=$1', [name]);
    if (r.rows.length) return r.rows[0].data;
    // prima rulare: dacă există fișier local vechi, îl migrăm
    try {
      if (fileFallback && fs.existsSync(fileFallback)) {
        const d = JSON.parse(fs.readFileSync(fileFallback, 'utf8'));
        await save(name, d, fileFallback, true);
        return d;
      }
    } catch (e) {}
    return null;
  }
  try {
    if (fileFallback && fs.existsSync(fileFallback)) return JSON.parse(fs.readFileSync(fileFallback, 'utf8'));
  } catch (e) {}
  return null;
}

// Salvează (sincron pentru apelant, scrie în fundal; debounce 300ms)
function save(name, obj, fileFallback, immediate = false) {
  const json = JSON.stringify(obj);
  if (!pool) {
    try { if (fileFallback) fs.writeFileSync(fileFallback, JSON.stringify(obj, null, 2), 'utf8'); } catch (e) {}
    return Promise.resolve();
  }
  const run = async () => {
    try {
      await pool.query(
        `INSERT INTO kv(name, data, updated_at) VALUES ($1, $2::jsonb, now())
         ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [name, json]
      );
    } catch (e) {
      console.error('[persist] eroare salvare', name, e.message);
    }
  };
  if (immediate) return run();
  clearTimeout(timers[name]);
  timers[name] = setTimeout(run, 300);
  return Promise.resolve();
}

// La oprire (SIGTERM de la Render) scriem imediat tot ce e în așteptare
async function flushAll(getters) {
  for (const [name, getter] of Object.entries(getters)) {
    clearTimeout(timers[name]);
    await save(name, getter(), null, true);
  }
}

module.exports = { init, load, save, flushAll };
