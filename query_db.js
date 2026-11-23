const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_e2sG9CHcNzMA@ep-aged-dust-banl2zss-pooler.c-8.eu-central-1.aws.neon.tech/neondb?sslmode=require',
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    const res = await pool.query('SELECT * FROM devices ORDER BY last_seen DESC LIMIT 5');
    console.log('DEVICES:', JSON.stringify(res.rows, null, 2));
    const subs = await pool.query('SELECT * FROM subscriptions');
    console.log('SUBS:', JSON.stringify(subs.rows, null, 2));
  } catch (e) {
    console.error(e);
  } finally {
    await pool.end();
  }
}
run();
