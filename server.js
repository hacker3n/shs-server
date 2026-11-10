process.env.TZ = 'Europe/Chisinau';
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', true);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// CONFIGURARE & PAROLĂ ADMINISTRATOR
// ==========================================
let adminPassword = process.env.ADMIN_PASSWORD || 'shs2026';

// Memorie & Persistență IP-uri & Anti-Abuz
const IP_FILE = path.join(__dirname, 'ip_registry.json');
let ipRegistry = {};

function loadIpRegistry() {
  try {
    if (fs.existsSync(IP_FILE)) {
      const data = JSON.parse(fs.readFileSync(IP_FILE, 'utf8'));
      for (const ip in data) {
        if (data[ip].radar_expires) data[ip].radar_expires = new Date(data[ip].radar_expires);
        if (data[ip].cancel_expires) data[ip].cancel_expires = new Date(data[ip].cancel_expires);
      }
      return data;
    }
  } catch (e) {
    console.error('Eroare la încărcarea ip_registry.json:', e.message);
  }
  return {};
}

function saveIpRegistry() {
  try {
    fs.writeFileSync(IP_FILE, JSON.stringify(ipRegistry, null, 2), 'utf8');
  } catch (e) {
    console.error('Eroare la salvarea ip_registry.json:', e.message);
  }
}

ipRegistry = loadIpRegistry();

// Memorie & Persistență Telefoane
const DB_FILE = path.join(__dirname, 'devices.json');
let devices = {};

function loadDevices() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const data = JSON.parse(raw);
      for (const k in data) {
        data[k].radar_expires = new Date(data[k].radar_expires);
        data[k].cancel_expires = new Date(data[k].cancel_expires);
        data[k].last_seen = new Date(data[k].last_seen || Date.now());
        data[k].hidden = !!data[k].hidden;
      }
      return data;
    }
  } catch (e) {
    console.error('Eroare la încărcarea devices.json:', e.message);
  }
  return {};
}

function saveDevices() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(devices, null, 2), 'utf8');
  } catch (e) {
    console.error('Eroare la salvarea devices.json:', e.message);
  }
}

devices = loadDevices();

// Memorie & Persistență Dispozitive Șterse (Păstrează istoricul și expirările)
const DELETED_DB_FILE = path.join(__dirname, 'deleted_devices.json');
let deletedDevices = {};

function loadDeletedDevices() {
  try {
    if (fs.existsSync(DELETED_DB_FILE)) {
      const raw = fs.readFileSync(DELETED_DB_FILE, 'utf8');
      const data = JSON.parse(raw);
      for (const k in data) {
        data[k].radar_expires = new Date(data[k].radar_expires);
        data[k].cancel_expires = new Date(data[k].cancel_expires);
        data[k].deleted = true;
      }
      return data;
    }
  } catch (e) {
    console.error('Eroare la încărcarea deleted_devices.json:', e.message);
  }
  return {};
}

function saveDeletedDevices() {
  try {
    fs.writeFileSync(DELETED_DB_FILE, JSON.stringify(deletedDevices, null, 2), 'utf8');
  } catch (e) {
    console.error('Eroare la salvarea deleted_devices.json:', e.message);
  }
}

deletedDevices = loadDeletedDevices();

// Memorie Cod Recuperare Unică Folosință (Valabilitate 3 minute)
let currentRecoveryCode = {
  code: null,
  createdAt: 0,
  expiresAt: 0,
  used: false
};

// Auto-localizare IP pe startup pentru telefoanele fără coordonate
setTimeout(async () => {
  for (const dev of Object.values(devices)) {
    if ((!dev.lat || !dev.lon) && dev.ip) {
      try {
        const geo = await resolveIpLocation(dev.ip);
        if (geo && !dev.lat) {
          dev.lat = geo.lat;
          dev.lon = geo.lon;
          dev.city = geo.city || '';
          dev.loc_source = 'ip';
          saveDevices();
        }
      } catch (e) {}
    }
  }
}, 3000);

// Memorie & Persistență Bază Clienți (Verificare numere)
const CLIENTS_FILE = path.join(__dirname, 'clients.json');
let clients = {};

function loadClients() {
  try {
    if (fs.existsSync(CLIENTS_FILE)) {
      return JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Eroare la încărcarea clients.json:', e.message);
  }
  const defaultClients = {
    "+37368000000": {
      "tags": { "Client bun": 4, "Bacșiș": 3, "Fără probleme": 4 },
      "userTags": {},
      "reviews": [{ "text": "Client foarte de treabă, iese imediat și lasă bacșiș.", "ts": new Date().toISOString(), "device_id": "admin", "admin": true }]
    }
  };
  try {
    fs.writeFileSync(CLIENTS_FILE, JSON.stringify(defaultClients, null, 2), 'utf8');
  } catch (err) {}
  return defaultClients;
}

function saveClients() {
  try {
    fs.writeFileSync(CLIENTS_FILE, JSON.stringify(clients, null, 2), 'utf8');
  } catch (e) {
    console.error('Eroare la salvarea clients.json:', e.message);
  }
}

clients = loadClients();

function normalizePhone(raw) {
  if (!raw) return '';
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 9 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }
  if (digits.length === 8) {
    return '+373' + digits;
  }
  if (digits.startsWith('373') && digits.length === 11) {
    return '+' + digits;
  }
  if (raw.startsWith('+')) {
    return '+' + digits;
  }
  return '+' + digits;
}

function getClientIp(req) {
  if (!req) return '';
  let ip = '';
  if (req.headers) {
    const fwd = req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.headers['x-forwarded-for'];
    if (fwd) ip = fwd.split(',')[0].trim();
  }
  if (!ip) {
    ip = (req.socket && req.socket.remoteAddress) || req.ip || '';
  }
  if (ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }
  if (ip.includes('.') && ip.includes(':')) {
    ip = ip.split(':')[0].trim();
  }
  return ip.trim();
}

// Normalizare Cheie Rețea (IPv4 exact sau prefix subnet /64 pentru IPv6)
// Toate dispozitivele conectate la același Wi-Fi/router împart același subnet /64!
function getNetworkKey(req) {
  const ip = getClientIp(req);
  if (!ip || ip === '127.0.0.1' || ip === '::1') return null;

  if (ip.includes(':')) {
    const parts = ip.split(':').filter(p => p.length > 0);
    if (parts.length >= 3) {
      return parts.slice(0, Math.min(parts.length, 4)).join(':') + '::/64';
    }
    return ip;
  }
  return ip;
}

// Rezolvare locație geografică pe baza IP-ului (fallback când telefonul nu trimite GPS)
async function resolveIpLocation(ip) {
  if (!ip || ip === '127.0.0.1' || ip === '::1') return null;
  const cleanIp = ip.split(',')[0].trim().replace(/^::ffff:/, '');
  if (!cleanIp || cleanIp === '127.0.0.1') return null;
  try {
    const fetchFn = typeof fetch === 'function' ? fetch : (await import('node-fetch')).default;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 3500) : null;
    const resp = await fetchFn(`http://ip-api.com/json/${encodeURIComponent(cleanIp)}?fields=status,country,city,lat,lon`, {
      signal: controller ? controller.signal : undefined
    });
    if (timer) clearTimeout(timer);
    if (resp && resp.ok) {
      const data = await resp.json();
      if (data && data.status === 'success' && data.lat && data.lon) {
        return { lat: Number(data.lat), lon: Number(data.lon), city: data.city || '' };
      }
    }
  } catch (err) {}
  return null;
}

function toIso3(d) {
  if (!d || isNaN(new Date(d).getTime())) d = new Date();
  return new Date(d).toISOString();
}

function ensureDate(val, fallback = null) {
  if (val instanceof Date && !isNaN(val.getTime())) return val;
  if (val) {
    const d = new Date(val);
    if (!isNaN(d.getTime())) return d;
  }
  return fallback instanceof Date ? fallback : new Date();
}

function parseMoldovaDate(val) {
  if (!val) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  if (typeof val === 'number') {
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof val === 'string') {
    val = val.trim();
    if (!val) return null;
    if (val.includes('T') && !val.endsWith('Z') && !val.includes('+')) {
      const withSeconds = val.length === 16 ? val + ':00' : val;
      const testD = new Date(withSeconds + 'Z');
      const month = testD.getUTCMonth();
      const offset = (month >= 3 && month <= 9) ? '+03:00' : '+02:00';
      const parsed = new Date(withSeconds + offset);
      if (!isNaN(parsed.getTime())) return parsed;
    }
    const d = new Date(val);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

function toDatetimeLocal(d) {
  if (!d) return '';
  const date = new Date(d);
  if (isNaN(date.getTime())) return '';
  try {
    const formatter = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Europe/Chisinau',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    });
    return formatter.format(date).replace(' ', 'T');
  } catch (e) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
}

function formatExactTime(d) {
  if (!d) return '-';
  const date = new Date(d);
  if (isNaN(date.getTime())) return '-';
  try {
    return date.toLocaleString('ro-RO', {
      timeZone: 'Europe/Chisinau',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).replace(',', ' la');
  } catch (e) {
    const pad = n => String(n).padStart(2, '0');
    return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} la ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
}

function applyExpirationToDeviceAndIp(dev, type, newRadarDate, newCancelDate) {
  if (newRadarDate) {
    dev.radar_expires = newRadarDate;
    dev.trial_used = true;
  }
  if (newCancelDate) {
    dev.cancel_expires = newCancelDate;
    dev.cancel_trial_used = true;
  }

  const netKey = dev.netKey || (dev.ip ? (dev.ip.includes(':') ? dev.ip.split(':').slice(0, 4).join(':') + '::/64' : dev.ip.split(':')[0]) : null);

  if (netKey) {
    ipRegistry[netKey] = {
      ...(ipRegistry[netKey] || {}),
      radar_expires: dev.radar_expires,
      cancel_expires: dev.cancel_expires,
      trial_used: true,
      cancel_trial_used: true,
      blocked: !!dev.blocked,
      last_device: dev.id
    };
    saveIpRegistry();

    // SINCRONIZARE AUTOMATĂ: Toate telefoanele de pe același IP/rețea primesc INSTANT aceeași expirare!
    Object.values(devices).forEach(otherDev => {
      const otherNet = otherDev.netKey || (otherDev.ip ? (otherDev.ip.includes(':') ? otherDev.ip.split(':').slice(0, 4).join(':') + '::/64' : otherDev.ip.split(':')[0]) : null);
      if (otherNet === netKey) {
        if (newRadarDate) otherDev.radar_expires = newRadarDate;
        if (newCancelDate) otherDev.cancel_expires = newCancelDate;
        otherDev.trial_used = true;
        otherDev.cancel_trial_used = true;
      }
    });
  }

  saveDevices();
}

function getOrCreateDevice(deviceId, deviceInfo = '', req = null) {
  if (!deviceId) deviceId = 'unknown';
  const clientIp = getClientIp(req);
  const netKey = getNetworkKey(req);
  const now = new Date();

  // 1. Căutăm rețeaua în ipRegistry
  let ipRec = (netKey && ipRegistry[netKey]) || (clientIp && ipRegistry[clientIp]) || null;

  // 2. Căutăm și în lista tuturor telefoanelor existente dacă au aceeași rețea sau același IP
  if (!ipRec && (netKey || clientIp)) {
    const existingDevWithIp = Object.values(devices).find(d => {
      if (d.id === deviceId) return false;
      const dNet = d.netKey || (d.ip ? (d.ip.includes(':') ? d.ip.split(':').slice(0, 4).join(':') + '::/64' : d.ip.split(':')[0]) : null);
      return (netKey && dNet === netKey) || (clientIp && d.ip === clientIp);
    });
    if (existingDevWithIp) {
      ipRec = {
        radar_expires: new Date(existingDevWithIp.radar_expires),
        cancel_expires: new Date(existingDevWithIp.cancel_expires),
        trial_used: true,
        cancel_trial_used: true,
        blocked: !!existingDevWithIp.blocked,
        devices: [existingDevWithIp.id]
      };
      if (netKey) ipRegistry[netKey] = ipRec;
      if (clientIp) ipRegistry[clientIp] = ipRec;
      saveIpRegistry();
    }
  }

  // VERIFICARE DISPOZITIV ȘTERS (după Device ID sau după Rețea/IP)
  const isDeleted = (deletedDevices[deviceId] && deletedDevices[deviceId].deleted) ||
                    (ipRec && ipRec.deleted);

  if (isDeleted) {
    const del = deletedDevices[deviceId] || {
      id: deviceId,
      ip: clientIp,
      netKey: netKey,
      info: deviceInfo || 'Telefon șters',
      radar_expires: (ipRec && ipRec.radar_expires) ? new Date(ipRec.radar_expires) : now,
      cancel_expires: (ipRec && ipRec.cancel_expires) ? new Date(ipRec.cancel_expires) : now,
      trial_used: true,
      cancel_trial_used: true,
      blocked: false,
      deleted: true,
      last_seen: now
    };
    del.deleted = true;
    del.last_seen = now;
    if (clientIp) del.ip = clientIp;
    if (netKey) del.netKey = netKey;
    deletedDevices[deviceId] = del;
    saveDeletedDevices();
    return del;
  }

  if (!devices[deviceId]) {
    // DISPOZITIV NOU (sau date șterse / aplicație reinstalată):
    let radarExpires;
    let cancelExpires;
    let isBlocked = false;

    if (ipRec) {
      // DACĂ IP-UL A FOST DEJA FOLOSIT:
      // Al doilea telefon (sau reinstalarea) primește EXACT timpul rămas de la primul!
      radarExpires = new Date(ipRec.radar_expires || now);
      cancelExpires = new Date(ipRec.cancel_expires || now);
      isBlocked = !!ipRec.blocked;
      if (!ipRec.devices) ipRec.devices = [];
      if (!ipRec.devices.includes(deviceId)) {
        ipRec.devices.push(deviceId);
        saveIpRegistry();
      }
    } else {
      // Dispozitiv și IP complet nou: acordăm trial inițial (24 ore radar, 12 ore anulare)
      radarExpires = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      cancelExpires = new Date(now.getTime() + 12 * 60 * 60 * 1000);

      // PREVENIRE RESETARE TRIAL LA UPDATE
      // Dacă există deja IP-ul cu licență mai mare, se recuperează instant!
      if (ipRegistry[netKey]) {
          if (ipRegistry[netKey].radar_expires && new Date(ipRegistry[netKey].radar_expires) > radarExpires) {
              radarExpires = new Date(ipRegistry[netKey].radar_expires);
          }
          if (ipRegistry[netKey].cancel_expires && new Date(ipRegistry[netKey].cancel_expires) > cancelExpires) {
              cancelExpires = new Date(ipRegistry[netKey].cancel_expires);
          }
      }

      if (netKey) {
        ipRegistry[netKey] = {
          radar_expires: radarExpires,
          cancel_expires: cancelExpires,
          trial_used: true,
          cancel_trial_used: true,
          blocked: false,
          devices: [deviceId]
        };
        saveIpRegistry();
      }
    }

    devices[deviceId] = {
      id: deviceId,
      ip: clientIp,
      netKey: netKey,
      info: deviceInfo || 'Telefon nou',
      radar_expires: radarExpires,
      cancel_expires: cancelExpires,
      trial_used: true,
      cancel_trial_used: true,
      blocked: isBlocked,
      hidden: false,
      last_seen: now
    };
    saveDevices();
  } else {
    // DISPOZITIV DEJA EXISTENT:
    const dev = devices[deviceId];
    dev.last_seen = now;
    if (dev.hidden) {
      dev.hidden = false;
    }
    if (clientIp) dev.ip = clientIp;
    if (netKey) dev.netKey = netKey;
    if (deviceInfo && (!dev.info || dev.info === 'Telefon nou')) dev.info = deviceInfo;

    // Sincronizare inteligentă cu rețeaua (se păstrează cea mai avansată dată de expirare):
    if (ipRec) {
      const ipRadarTime = ipRec.radar_expires ? new Date(ipRec.radar_expires).getTime() : 0;
      const devRadarTime = dev.radar_expires ? new Date(dev.radar_expires).getTime() : 0;
      if (ipRadarTime > devRadarTime) {
        dev.radar_expires = new Date(ipRadarTime);
      } else if (devRadarTime > ipRadarTime) {
        ipRec.radar_expires = dev.radar_expires;
        saveIpRegistry();
      }

      const ipCancelTime = ipRec.cancel_expires ? new Date(ipRec.cancel_expires).getTime() : 0;
      const devCancelTime = dev.cancel_expires ? new Date(dev.cancel_expires).getTime() : 0;
      if (ipCancelTime > devCancelTime) {
        dev.cancel_expires = new Date(ipCancelTime);
      } else if (devCancelTime > ipCancelTime) {
        ipRec.cancel_expires = dev.cancel_expires;
        saveIpRegistry();
      }

      if (ipRec.blocked) {
        dev.blocked = true;
      }
      if (!ipRec.devices) ipRec.devices = [];
      if (!ipRec.devices.includes(deviceId)) {
        ipRec.devices.push(deviceId);
        saveIpRegistry();
      }
    } else if (netKey) {
      ipRegistry[netKey] = {
        radar_expires: dev.radar_expires,
        cancel_expires: dev.cancel_expires,
        trial_used: true,
        cancel_trial_used: true,
        blocked: !!dev.blocked,
        devices: [deviceId]
      };
      saveIpRegistry();
    }
    saveDevices();
  }

  const dev = devices[deviceId];

  // 1. Coordonate GPS trimise direct de aplicație prin body
  if (req && req.body) {
    const lat = parseFloat(req.body.lat) || 0;
    const lon = parseFloat(req.body.lon) || 0;
    if (lat !== 0 && lon !== 0) {
      dev.lat = lat;
      dev.lon = lon;
      dev.loc_source = 'gps';
      saveDevices();
    }
  }

  // 2. Fallback inteligent: Dacă telefonul nu are încă GPS sau coordonate, localizăm prin IP
  if ((!dev.lat || !dev.lon || dev.loc_source === 'ip') && clientIp) {
    resolveIpLocation(clientIp).then(geo => {
      if (geo && (!dev.lat || dev.loc_source === 'ip')) {
        dev.lat = geo.lat;
        dev.lon = geo.lon;
        dev.city = geo.city || '';
        dev.loc_source = 'ip';
        saveDevices();
      }
    }).catch(() => {});
  }

  return dev;
}

// Configurație aplicație & persistență
const CONFIG_FILE = path.join(__dirname, 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Eroare la încărcarea config.json:', e.message);
  }
  return {
    latest_version_code: 1,
    latest_version_name: "1.0 (c)",
    min_version_code: 1,
    update_url: "https://shs-server.onrender.com/download/SHS_Final.apk",
    update_notes: "Versiunea 1.0 (c): Fix închidere/crash automat (ART VerifyError), salvare stabilă backup, afișare prețuri zecimale cu Ceai/Bonus, reamintire preț cursă la triplă apăsare.",
    shared_geocoder: true,
    telegram: "neki002",
    phone: "",
    mia_phone: "",
    mia_name: "",
    group_url: "https://t.me/neki002",
    announcement_id: 1,
    announcement_text: ""
  };
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(appConfig, null, 2), 'utf8');
  } catch (e) {
    console.error('Eroare la salvarea config.json:', e.message);
  }
}

let appConfig = loadConfig();
if (appConfig.admin_password) {
  adminPassword = appConfig.admin_password;
}

// Autentificare Admin prin Cookie, Header sau Query
function getCookie(req, name) {
  const matches = (req.headers && req.headers.cookie ? req.headers.cookie : '').match(new RegExp('(?:^|; )' + name.replace(/([\.$?*|{}\(\)\[\]\\\/\+^])/g, '\\$1') + '=([^;]*)'));
  return matches ? decodeURIComponent(matches[1]) : undefined;
}

function getExpectedToken() {
  return Buffer.from('shs_auth_' + adminPassword).toString('base64');
}

function isAuthenticated(req) {
  const expected = getExpectedToken();
  const token = getCookie(req, 'shs_admin_session');
  if (token && token === expected) return true;
  if (req && req.headers) {
    if (req.headers['x-admin-token'] === expected) return true;
    if (req.headers['authorization'] === 'Bearer ' + expected) return true;
  }
  if (req && req.query) {
    if (req.query.auth === expected || req.query.token === expected) return true;
  }
  return false;
}

// ==========================================
// API PENTRU APLICAȚIA ANDROID (PUBLIC)
// ==========================================

// 1. Config & Update Check
app.get('/api/app-config', (req, res) => {
  const resp = {
    ...appConfig,
    apk_url: appConfig.update_url,
    announcement: appConfig.announcement_text ? {
      id: appConfig.announcement_id || 1,
      text: appConfig.announcement_text,
      below_version: 999999
    } : null
  };
  res.json(resp);
});

// Endpoint direct pentru descărcarea APK-ului pe telefoane
app.get(['/download/SHS_Final.apk', '/SHS_Final.apk'], (req, res) => {
  const apkPath = path.join(__dirname, 'SHS_Final.apk');
  if (fs.existsSync(apkPath)) {
    return res.download(apkPath, 'SHS_Final.apk');
  }
  res.status(404).send('APK-ul nu a fost găsit pe server.');
});

// 2. Geocoding partajat
app.post('/api/geocode', async (req, res) => {
  const query = req.body.q || req.query.q || '';
  if (!query) {
    return res.json({ ok: true, found: false });
  }
  try {
    const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query + ', Chișinău, Moldova')}&limit=1`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'SHS-Server/1.0' } });
    const data = await resp.json();
    if (data && data.length > 0) {
      return res.json({
        ok: true,
        found: true,
        lat: parseFloat(data[0].lat),
        lon: parseFloat(data[0].lon)
      });
    }
  } catch (e) {
    console.error('Geocode error:', e.message);
  }
  return res.json({
    ok: true,
    found: true,
    lat: 47.0105,
    lon: 28.8638
  });
});

// 3. Verificare Licență Radar & Heartbeat GPS
app.post('/api/check-license', (req, res) => {
  const deviceId = req.body.device_id;
  const dev = getOrCreateDevice(deviceId, req.body.device_info, req);
  const now = new Date();

  if (dev.deleted) {
    return res.json({
      ok: true,
      valid: false,
      is_activated: false,
      blocked: false,
      deleted: true,
      expires: toIso3(dev.radar_expires),
      cancel_active: false,
      cancel_expires_ms: dev.cancel_expires.getTime(),
      cancel_expires: toIso3(dev.cancel_expires),
      message: "DISPOZITIV_STERS",
      ts: Date.now()
    });
  }

  const isRadarActive = !dev.blocked && (dev.radar_expires > now);
  const isCancelActive = !dev.blocked && (dev.cancel_expires > now);

  const lat = parseFloat(req.body.lat) || 0;
  const lon = parseFloat(req.body.lon) || 0;
  if (lat !== 0 && lon !== 0) {
    dev.lat = lat;
    dev.lon = lon;
  }
  if (req.body && req.body.app_version) {
    dev.app_version = req.body.app_version;
  }
  dev.uninstalled = false;
  dev.is_offline = false;
  dev.last_seen = now;
  saveDevices();

  let announcement = null;
  if (appConfig.announcement_text) {
    const target = appConfig.announcement_target || 'all';
    const targetDevices = Array.isArray(appConfig.announcement_devices) ? appConfig.announcement_devices : [];
    if (target === 'all' || targetDevices.includes(deviceId)) {
      announcement = {
        id: appConfig.announcement_id || 1,
        text: appConfig.announcement_text,
        below_version: 999999
      };
    }
  }

  res.json({
    ok: true,
    valid: isRadarActive,
    is_activated: isRadarActive,
    blocked: !!dev.blocked,
    expires: toIso3(dev.radar_expires),
    cancel_active: isCancelActive,
    cancel_expires_ms: dev.cancel_expires.getTime(),
    cancel_expires: toIso3(dev.cancel_expires),
    message: dev.blocked ? "Ești blocat! Contactează administratorul pe Telegram." : "OK",
    announcement: announcement,
    ts: Date.now()
  });
});

// Endpoint Semnalare Ieșire Aplicație (Offline Instant)
app.post('/api/device-offline', (req, res) => {
  const deviceId = req.body && req.body.device_id;
  if (deviceId && devices[deviceId]) {
    devices[deviceId].is_offline = true;
    devices[deviceId].last_seen = new Date(Date.now() - 60 * 1000);
    saveDevices();
  }
  res.json({ ok: true });
});

// Endpoint Semnalare Dezinstalare Aplicație de pe Telefon
app.post('/api/device-uninstalled', (req, res) => {
  const deviceId = req.body && req.body.device_id;
  if (deviceId && devices[deviceId]) {
    devices[deviceId].uninstalled = true;
    devices[deviceId].is_offline = true;
    saveDevices();
  }
  res.json({ ok: true });
});

// 4. Cerere Trial Radar (Anti-Abuz IP & Dispozitiv)
app.post('/api/request-trial', (req, res) => {
  const deviceId = req.body.device_id;
  const dev = getOrCreateDevice(deviceId, req.body.device_info, req);
  const netKey = getNetworkKey(req);
  const clientIp = getClientIp(req);
  const now = new Date();

  const ipRec = (netKey && ipRegistry[netKey]) || (clientIp && ipRegistry[clientIp]);
  const ipHasTrial = ipRec && ipRec.trial_used;

  if (dev.trial_used || ipHasTrial) {
    // REFUZĂ TRIAL: a fost deja folosit pe acest telefon sau pe această rețea/IP!
    return res.json({
      ok: false,
      valid: !dev.blocked && (dev.radar_expires > now),
      is_activated: !dev.blocked && (dev.radar_expires > now),
      blocked: !!dev.blocked,
      expires: toIso3(dev.radar_expires),
      message: dev.blocked ? "Ești blocat!" : "Perioada de probă (trial) a fost deja utilizată pentru acest dispozitiv / rețea!",
      ts: Date.now()
    });
  }

  // Acordă trial o singură dată
  dev.radar_expires = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  dev.trial_used = true;
  saveDevices();

  if (netKey) {
    ipRegistry[netKey] = {
      ...(ipRegistry[netKey] || {}),
      radar_expires: dev.radar_expires,
      trial_used: true,
      devices: [dev.id]
    };
    saveIpRegistry();
  }

  res.json({
    ok: true,
    valid: !dev.blocked && (dev.radar_expires > now),
    is_activated: !dev.blocked && (dev.radar_expires > now),
    blocked: !!dev.blocked,
    expires: toIso3(dev.radar_expires),
    message: "Trial activat cu succes!",
    ts: Date.now()
  });
});

// 5. Activare Cheie Radar
app.post('/api/activate-key', (req, res) => {
  const deviceId = req.body.device_id;
  const dev = getOrCreateDevice(deviceId, req.body.device_info, req);
  const now = new Date();
  const base = dev.radar_expires > now ? dev.radar_expires.getTime() : now.getTime();
  const newDate = new Date(base + 30 * 24 * 60 * 60 * 1000);
  applyExpirationToDeviceAndIp(dev, 'radar', newDate, null);

  res.json({
    ok: true,
    valid: true,
    is_activated: true,
    expires: toIso3(dev.radar_expires),
    message: "Cheie activată cu succes!",
    ts: Date.now()
  });
});

// 6. Verificare Funcție Отмена (Cancel)
app.post('/api/cancel/status', (req, res) => {
  const deviceId = req.body.device_id;
  const dev = getOrCreateDevice(deviceId, '', req);
  if (dev.deleted) {
    return res.json({
      ok: true,
      valid: false,
      active: false,
      hours_left: 0,
      trial_available: false,
      banned: false,
      deleted: true,
      expires: toIso3(dev.cancel_expires),
      nonce: req.body.nonce || '',
      ts: Date.now()
    });
  }
  const netKey = getNetworkKey(req);
  const clientIp = getClientIp(req);
  const now = new Date();
  const isCancelActive = !dev.blocked && (dev.cancel_expires > now);
  const hoursLeft = isCancelActive ? Math.max(0, Math.ceil((dev.cancel_expires.getTime() - now.getTime()) / (1000 * 60 * 60))) : 0;

  const ipRec = (netKey && ipRegistry[netKey]) || (clientIp && ipRegistry[clientIp]);
  const canTrial = !dev.cancel_trial_used && (!ipRec || !ipRec.cancel_trial_used);

  res.json({
    ok: true,
    valid: isCancelActive,
    active: isCancelActive,
    hours_left: hoursLeft,
    trial_available: canTrial,
    banned: !!dev.blocked,
    expires: toIso3(dev.cancel_expires),
    nonce: req.body.nonce || '',
    ts: Date.now()
  });
});

// 7. Trial Funcție Отмена (Anti-Abuz IP & Dispozitiv)
app.post('/api/cancel/trial', (req, res) => {
  const deviceId = req.body.device_id;
  const dev = getOrCreateDevice(deviceId, '', req);
  const netKey = getNetworkKey(req);
  const clientIp = getClientIp(req);
  const now = new Date();

  const ipRec = (netKey && ipRegistry[netKey]) || (clientIp && ipRegistry[clientIp]);
  const ipHasCancelTrial = ipRec && ipRec.cancel_trial_used;

  if (dev.cancel_trial_used || ipHasCancelTrial) {
    const isCancelActive = !dev.blocked && (dev.cancel_expires > now);
    const hoursLeft = isCancelActive ? Math.max(0, Math.ceil((dev.cancel_expires.getTime() - now.getTime()) / (1000 * 60 * 60))) : 0;
    return res.json({
      ok: false,
      valid: isCancelActive,
      active: isCancelActive,
      hours_left: hoursLeft,
      trial_available: false,
      banned: !!dev.blocked,
      expires: toIso3(dev.cancel_expires),
      nonce: req.body.nonce || '',
      message: "Perioada de probă Anulare a fost deja utilizată pentru acest dispozitiv / rețea!",
      ts: Date.now()
    });
  }

  const newCancel = new Date(now.getTime() + 12 * 60 * 60 * 1000);
  applyExpirationToDeviceAndIp(dev, 'cancel', null, newCancel);

  res.json({
    ok: true,
    valid: true,
    active: true,
    hours_left: 12,
    trial_available: false,
    banned: false,
    expires: toIso3(dev.cancel_expires),
    nonce: req.body.nonce || '',
    ts: Date.now()
  });
});

// 8. Activare Cheie Отмена
app.post('/api/cancel/activate', (req, res) => {
  const deviceId = req.body.device_id;
  const dev = getOrCreateDevice(deviceId, '', req);
  const now = new Date();
  const base = dev.cancel_expires > now ? dev.cancel_expires.getTime() : now.getTime();
  const newCancel = new Date(base + 30 * 24 * 60 * 60 * 1000);
  applyExpirationToDeviceAndIp(dev, 'cancel', null, newCancel);
  const hoursLeft = Math.ceil((dev.cancel_expires.getTime() - now.getTime()) / (1000 * 60 * 60));

  res.json({
    ok: true,
    valid: true,
    active: true,
    hours_left: hoursLeft,
    trial_available: false,
    banned: false,
    expires: toIso3(dev.cancel_expires),
    nonce: req.body.nonce || '',
    ts: Date.now()
  });
});

// 9. Plăți / Claim
app.post('/api/pay/claim', (req, res) => {
  const deviceId = req.body.device_id;
  const dev = getOrCreateDevice(deviceId, '', req);
  const now = new Date();
  const days = parseInt(req.body.days || 30);
  const base = dev.cancel_expires > now ? dev.cancel_expires.getTime() : now.getTime();
  const newCancel = new Date(base + days * 24 * 60 * 60 * 1000);
  applyExpirationToDeviceAndIp(dev, 'cancel', null, newCancel);
  const hoursLeft = Math.ceil((dev.cancel_expires.getTime() - now.getTime()) / (1000 * 60 * 60));

  res.json({
    ok: true,
    active: true,
    hours_left: hoursLeft,
    expires: toIso3(dev.cancel_expires),
    nonce: req.body.nonce || '',
    ts: Date.now()
  });
});

app.post('/api/pay/status', (req, res) => {
  res.json({
    ok: true,
    paid: true,
    status: 'PAID'
  });
});

// ==========================================
// API VERIFICARE & RECENZII CLIENȚI (RAILWAY BRIDGE)
// ==========================================

let railwaySession = {
  deviceId: '62ab0a240ae3435d',
  expires: 1794154370533
};

async function getRailwayActiveDeviceId() {
  const now = Date.now();
  if (railwaySession.deviceId && railwaySession.expires > now + 3600000) {
    return railwaySession.deviceId;
  }

  try {
    const crypto = require('crypto');
    const newId = crypto.randomBytes(8).toString('hex');
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 5000) : null;

    const fetchFn = typeof fetch === 'function' ? fetch : (await import('node-fetch')).default;
    const resp = await fetchFn('https://taxi-radar-license-production.up.railway.app/api/request-trial', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'User-Agent': 'okhttp/4.12.0'
      },
      body: JSON.stringify({ device_id: newId }),
      signal: controller ? controller.signal : undefined
    });
    if (timer) clearTimeout(timer);

    if (resp && resp.ok) {
      const data = await resp.json();
      if (data && data.valid && data.expires) {
        railwaySession.deviceId = newId;
        railwaySession.expires = new Date(data.expires).getTime();
        console.log(`[RAILWAY BRIDGE] Sesiune nouă activată: ${newId}, expiră: ${data.expires}`);
        return newId;
      }
    }
  } catch (err) {
    console.error('[RAILWAY BRIDGE] Eroare obținere sesiune:', err.message);
  }

  return railwaySession.deviceId || '62ab0a240ae3435d';
}

async function fetchFromRailway(path, payload) {
  try {
    const railwayId = await getRailwayActiveDeviceId();
    const payloadWithDevice = Object.assign({}, payload, { device_id: railwayId });

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 5500) : null;

    const fetchFn = typeof fetch === 'function' ? fetch : (await import('node-fetch')).default;
    const resp = await fetchFn(`https://taxi-radar-license-production.up.railway.app${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'User-Agent': 'okhttp/4.12.0'
      },
      body: JSON.stringify(payloadWithDevice),
      signal: controller ? controller.signal : undefined
    });
    if (timer) clearTimeout(timer);

    if (resp && resp.ok) {
      const data = await resp.json();
      return data;
    } else if (resp && (resp.status === 400 || resp.status === 403)) {
      railwaySession.deviceId = null;
      railwaySession.expires = 0;
    }
  } catch (err) {
    // Timeout sau eroare de conexiune cu Railway
  }
  return null;
}

// 10. Verificare Numere Clienți
app.post('/api/clients/check', async (req, res) => {
  const rawPhone = (req.body.phone || '').trim();
  const deviceId = req.body.device_id || 'unknown';
  const phone = normalizePhone(rawPhone) || rawPhone;

  let clientData = clients[phone] || clients[rawPhone];
  if (!clientData) {
    const digits8 = phone.slice(-8);
    for (const p in clients) {
      if (p.endsWith(digits8)) {
        clientData = clients[p];
        break;
      }
    }
  }

  // Întotdeauna verificăm pe serverul original Railway dacă numărul nu există local sau nu are recenzii/etichete
  const hasLocalDetails = clientData && ((clientData.reviews && clientData.reviews.length > 0) || (clientData.tags && Object.keys(clientData.tags).length > 0));

  if (!hasLocalDetails && phone) {
    try {
      const origData = await fetchFromRailway('/api/clients/check', { phone: phone });
      if (origData && origData.ok) {
        if (!clients[phone]) {
          clients[phone] = { tags: {}, userTags: {}, reviews: [] };
        }

        // Fuzionăm etichetele primite de pe Railway
        if (origData.tags && typeof origData.tags === 'object') {
          for (const [t, count] of Object.entries(origData.tags)) {
            clients[phone].tags[t] = Math.max(clients[phone].tags[t] || 0, count);
          }
        }

        // Fuzionăm recenziile primite de pe Railway
        if (Array.isArray(origData.reviews) && origData.reviews.length > 0) {
          const existingTexts = new Set((clients[phone].reviews || []).map(r => (r.text || '').trim()));
          for (const r of origData.reviews) {
            const cleanText = (r.text || '').trim();
            if (cleanText && !existingTexts.has(cleanText)) {
              if (!clients[phone].reviews) clients[phone].reviews = [];
              clients[phone].reviews.push({
                text: cleanText,
                ts: r.ts || new Date().toISOString(),
                device_id: 'railway',
                admin: !!r.admin
              });
              existingTexts.add(cleanText);
            }
          }
        }

        saveClients();
        clientData = clients[phone];
      }
    } catch (e) {
      // Ignorăm eroarea railway fallback la local
    }
  }

  if (!clientData) {
    return res.json({
      ok: true,
      phone: phone,
      tags: {},
      mine: [],
      reviews: []
    });
  }

  const mine = (clientData.userTags && clientData.userTags[deviceId]) || [];
  const reviews = (clientData.reviews || []).map(r => ({
    text: r.text || '',
    ts: r.ts || new Date().toISOString(),
    mine: r.device_id === deviceId,
    admin: !!r.admin
  }));

  res.json({
    ok: true,
    phone: phone,
    tags: clientData.tags || {},
    mine: mine,
    reviews: reviews
  });
});

// 11. Adăugare Recenzie Client
app.post('/api/clients/review', (req, res) => {
  const rawPhone = (req.body.phone || '').trim();
  const text = (req.body.text || '').trim();
  const deviceId = req.body.device_id || 'unknown';
  const phone = normalizePhone(rawPhone) || rawPhone;

  if (!phone || !text) {
    return res.json({ ok: false, message: 'Date incomplete' });
  }

  if (!clients[phone]) {
    clients[phone] = { tags: {}, userTags: {}, reviews: [] };
  }
  if (!clients[phone].reviews) clients[phone].reviews = [];

  clients[phone].reviews.unshift({
    text: text,
    ts: new Date().toISOString(),
    device_id: deviceId,
    admin: false
  });
  saveClients();

  // Trimitem asincron recenzia și către serverul Railway pentru comunitatea generală
  fetchFromRailway('/api/clients/review', { phone: phone, text: text }).catch(() => {});

  const mine = (clients[phone].userTags && clients[phone].userTags[deviceId]) || [];
  const reviews = clients[phone].reviews.map(r => ({
    text: r.text || '',
    ts: r.ts || new Date().toISOString(),
    mine: r.device_id === deviceId,
    admin: !!r.admin
  }));

  res.json({
    ok: true,
    phone: phone,
    tags: clients[phone].tags || {},
    mine: mine,
    reviews: reviews
  });
});

// 12. Adăugare / Modificare Etichetă (Tag) Client
app.post('/api/clients/tag', (req, res) => {
  const rawPhone = (req.body.phone || '').trim();
  const tag = (req.body.tag || '').trim();
  const on = req.body.on !== undefined ? !!req.body.on : (req.body.value !== false);
  const deviceId = req.body.device_id || 'unknown';
  const phone = normalizePhone(rawPhone) || rawPhone;

  if (!phone || !tag) {
    return res.json({ ok: false, message: 'Date incomplete' });
  }

  if (!clients[phone]) {
    clients[phone] = { tags: {}, userTags: {}, reviews: [] };
  }
  if (!clients[phone].tags) clients[phone].tags = {};
  if (!clients[phone].userTags) clients[phone].userTags = {};
  if (!clients[phone].userTags[deviceId]) clients[phone].userTags[deviceId] = [];

  const userTagsList = clients[phone].userTags[deviceId];
  const hasTag = userTagsList.includes(tag);

  if (on && !hasTag) {
    userTagsList.push(tag);
    clients[phone].tags[tag] = (clients[phone].tags[tag] || 0) + 1;
  } else if (!on && hasTag) {
    clients[phone].userTags[deviceId] = userTagsList.filter(t => t !== tag);
    clients[phone].tags[tag] = Math.max(0, (clients[phone].tags[tag] || 1) - 1);
    if (clients[phone].tags[tag] === 0) {
      delete clients[phone].tags[tag];
    }
  }
  saveClients();

  // Trimitem asincron eticheta și către serverul Railway
  fetchFromRailway('/api/clients/tag', { phone: phone, tag: tag, on: on }).catch(() => {});

  const reviews = (clients[phone].reviews || []).map(r => ({
    text: r.text || '',
    ts: r.ts || new Date().toISOString(),
    mine: r.device_id === deviceId,
    admin: !!r.admin
  }));

  res.json({
    ok: true,
    phone: phone,
    tags: clients[phone].tags || {},
    mine: clients[phone].userTags[deviceId] || [],
    reviews: reviews
  });
});

// ==========================================
// RUTE AUTENTIFICARE ADMIN
// ==========================================

function renderLoginPage(error = '') {
  return `
    <!DOCTYPE html>
    <html lang="ro">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Autentificare - SHS Manager</title>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Inter', -apple-system, sans-serif; }
        body {
          background: #090d16;
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
          color: #f1f5f9;
        }
        .login-card {
          background: #111827;
          border: 1px solid #1f2937;
          border-radius: 20px;
          padding: 40px 32px;
          width: 100%;
          max-width: 420px;
          box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.6);
          text-align: center;
        }
        .badge {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 6px 14px;
          border-radius: 9999px;
          background: rgba(56, 189, 248, 0.1);
          color: #38bdf8;
          font-size: 13px;
          font-weight: 600;
          margin-bottom: 20px;
        }
        h1 {
          font-size: 26px;
          font-weight: 700;
          color: #ffffff;
          margin-bottom: 8px;
        }
        p {
          color: #94a3b8;
          font-size: 14px;
          margin-bottom: 28px;
        }
        .form-group {
          margin-bottom: 20px;
          text-align: left;
        }
        label {
          display: block;
          font-size: 13px;
          font-weight: 600;
          color: #cbd5e1;
          margin-bottom: 8px;
        }
        input[type="password"] {
          width: 100%;
          padding: 14px 16px;
          background: #0b0f19;
          border: 1.5px solid #334155;
          border-radius: 12px;
          color: #ffffff;
          font-size: 15px;
          outline: none;
          transition: border-color 0.2s;
        }
        input[type="password"]:focus {
          border-color: #38bdf8;
          box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.2);
        }
        .remember-wrap {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 24px;
          cursor: pointer;
        }
        .remember-wrap input {
          width: 18px;
          height: 18px;
          accent-color: #0284c7;
          cursor: pointer;
        }
        .remember-wrap span {
          font-size: 13px;
          color: #94a3b8;
          user-select: none;
        }
        button.btn-login {
          width: 100%;
          padding: 14px;
          background: linear-gradient(135deg, #0284c7, #2563eb);
          color: white;
          border: none;
          border-radius: 12px;
          font-size: 15px;
          font-weight: 600;
          cursor: pointer;
          transition: transform 0.1s, opacity 0.2s;
        }
        button.btn-login:hover {
          opacity: 0.95;
          transform: translateY(-1px);
        }
        .error {
          background: rgba(239, 68, 68, 0.15);
          border: 1px solid rgba(239, 68, 68, 0.4);
          color: #f87171;
          padding: 12px;
          border-radius: 10px;
          font-size: 13px;
          margin-bottom: 20px;
        }
      </style>
    </head>
    <body>
      <div class="login-card">
        <div class="badge">🔒 Acces Securizat</div>
        <h1>SHS Manager</h1>
        <p>Introdu parola pentru a accesa panoul de control.</p>

        ${error ? `<div class="error">⚠️ ${error}</div>` : ''}

        <form action="/admin/login" method="POST">
          <div class="form-group">
            <label for="password">Parolă Administrator:</label>
            <input type="password" id="password" name="password" placeholder="••••••••" required autofocus>
          </div>

          <label class="remember-wrap">
            <input type="checkbox" name="remember" value="yes" checked>
            <span>Ține-mă minte pe acest telefon / PC (1 an)</span>
          </label>

          <button type="submit" class="btn-login">Conectează-te</button>
        </form>
      </div>
    </body>
    </html>
  `;
}

// POST Login
app.post('/admin/login', (req, res) => {
  const { password, remember } = req.body;
  if (password === adminPassword) {
    const maxAge = remember === 'yes' ? 365 * 24 * 60 * 60 : 30 * 24 * 60 * 60;
    res.setHeader('Set-Cookie', `shs_admin_session=${getExpectedToken()}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax; Secure`);
    return res.redirect('/');
  }
  res.send(renderLoginPage('Parola introdusă este incorectă!'));
});

// Logout
app.get('/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'shs_admin_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure');
  res.redirect('/');
});

// Schimbare Parolă Administrator
app.post('/admin/change-password', (req, res) => {
  if (!isAuthenticated(req)) return res.redirect('/');
  const { new_password } = req.body;
  if (new_password && new_password.trim().length >= 4) {
    adminPassword = new_password.trim();
    appConfig.admin_password = adminPassword;
    saveConfig();
    res.setHeader('Set-Cookie', `shs_admin_session=${getExpectedToken()}; Path=/; Max-Age=${365 * 24 * 60 * 60}; HttpOnly; SameSite=Lax; Secure`);
  }
  res.redirect('/?msg=password_changed');
});

// ==========================================
// PANOU DE CONTROL WEB (ADMIN DASHBOARD)
// ==========================================

app.get('/', (req, res) => {
  if (!isAuthenticated(req)) {
    return res.send(renderLoginPage());
  }

  const now = new Date();
  let devicesList = Object.values(devices);
  devicesList.forEach(dev => {
    dev.radar_expires = ensureDate(dev.radar_expires);
    dev.cancel_expires = ensureDate(dev.cancel_expires);
    dev.last_seen = ensureDate(dev.last_seen);
  });
  devicesList.sort((a, b) => b.last_seen.getTime() - a.last_seen.getTime());

  let activeRadarCount = 0;
  let activeCancelCount = 0;
  let blockedCount = 0;
  let onlineCount = 0;
  let hiddenCount = 0;
  let inactive24hCount = 0;
  let activeRecentCount = 0;

  devicesList.forEach(dev => {
    if (dev.blocked) blockedCount++;
    if (!dev.blocked && dev.radar_expires > now) activeRadarCount++;
    if (!dev.blocked && dev.cancel_expires > now) activeCancelCount++;
    const diffMs = now.getTime() - dev.last_seen.getTime();
    if (diffMs < 12 * 1000 && !dev.is_offline) onlineCount++;
    if (dev.hidden) {
      hiddenCount++;
    } else {
      if (diffMs > 24 * 60 * 60 * 1000) {
        inactive24hCount++;
      } else {
        activeRecentCount++;
      }
    }
  });

  let rows = devicesList.map(dev => {
    const radarMs = dev.radar_expires.getTime() - now.getTime();
    const radarDays = Math.max(0, Math.ceil(radarMs / (1000 * 60 * 60 * 24)));

    const cancelMs = dev.cancel_expires.getTime() - now.getTime();
    const cancelHours = Math.max(0, Math.ceil(cancelMs / (1000 * 60 * 60)));
    const cancelDays = Math.max(0, Math.ceil(cancelHours / 24));

    const radarStatusClass = radarDays > 7 ? 'badge-green' : (radarDays > 0 ? 'badge-yellow' : 'badge-red');
    const cancelStatusClass = cancelHours > 24 ? 'badge-cyan' : (cancelHours > 0 ? 'badge-yellow' : 'badge-red');

    const diffMs = now.getTime() - dev.last_seen.getTime();
    const isOnline = (diffMs < 12 * 1000) && !dev.is_offline;
    const diffSec = Math.floor(diffMs / 1000);
    let lastSeenText = "Chiar acum";
    if (diffSec >= 60 && diffSec < 3600) {
      lastSeenText = `Acum ${Math.floor(diffSec / 60)} min`;
    } else if (diffSec >= 3600 && diffSec < 86400) {
      lastSeenText = `Acum ${Math.floor(diffSec / 3600)} ore`;
    } else if (diffSec >= 86400) {
      lastSeenText = dev.last_seen.toLocaleDateString('ro-RO');
    }

    return `
      <tr class="device-row ${dev.blocked ? 'is-blocked' : ''}" id="row-${dev.id}" data-id="${dev.id}" data-hidden="${dev.hidden ? 'true' : 'false'}" data-lastseen="${dev.last_seen.getTime()}">
        <td>
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="device-id" id="id-${dev.id}">${dev.id}</span>
            <button type="button" class="btn-copy" onclick="copyId('${dev.id}')" title="Copiază ID">📋</button>
          </div>
          <div style="margin-top: 6px;" id="online-status-${dev.id}">
            ${isOnline
              ? `<span style="display:inline-flex; align-items:center; gap:5px; color:#4ade80; font-size:12px; font-weight:600;"><span style="width:8px; height:8px; border-radius:50%; background:#22c55e; box-shadow:0 0 8px #22c55e;"></span> 🟢 Online (Activ)</span>`
              : `<span style="display:inline-flex; align-items:center; gap:5px; color:#94a3b8; font-size:11px;"><span style="width:7px; height:7px; border-radius:50%; background:#64748b;"></span> ⚪ Offline (${lastSeenText})</span>`
            }
          </div>
          <div style="margin-top: 5px; color: #38bdf8; font-size: 11px; display: inline-flex; align-items: center; gap: 4px; font-family: monospace; background: rgba(56, 189, 248, 0.1); padding: 2px 6px; border-radius: 4px;">
            🌐 IP: <b>${dev.ip || 'Nedetectat'}</b>${dev.city ? ' · ' + dev.city : ''}
          </div>
          ${(dev.lat && dev.lon) ? `
            <div style="margin-top: 3px;">
              <a href="https://www.google.com/maps?q=${dev.lat},${dev.lon}" target="_blank" style="color: #64748b; font-size: 10px; text-decoration: none; display: inline-flex; align-items: center; gap: 3px;">
                🛰️ ${dev.loc_source === 'gps' ? 'GPS Live' : 'Rețea'} (Hărți)
              </a>
            </div>
          ` : ''}
        </td>
        <td>
          <div style="font-weight: 600; color: #f8fafc;">${dev.info || 'Necunoscut'}</div>
          <div style="font-size: 11px; color: #94a3b8; margin-top: 3px; display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
            <span>📱 v${dev.app_version || '2.6.1'}</span>
            ${dev.uninstalled ? '<span class="badge" style="background:#ef4444; color:#fff; font-size:10px; padding:1px 5px; border-radius:4px;">🗑️ Aplicație ștearsă</span>' : ''}
          </div>
        </td>
        <td>
          <div style="display:flex; flex-direction:column; gap:5px;">
            <div style="display:flex; align-items:center; gap:6px;">
              <span class="badge ${radarStatusClass}" id="radar-badge-${dev.id}">
                ${radarDays > 0 ? `● ${radarDays} zile` : '○ Expirat'}
              </span>
              <small class="text-muted" style="font-size:11px;" id="radar-text-${dev.id}">${formatExactTime(dev.radar_expires)}</small>
            </div>
            <div style="display:flex; align-items:center; gap:4px;">
              <input type="datetime-local" class="date-picker-live" id="radar-input-${dev.id}" value="${toDatetimeLocal(dev.radar_expires)}" onchange="updateExpire('${dev.id}', 'radar', this.value)" title="Alege exact data și ora expirării">
              <button type="button" class="btn-save-date" onclick="updateExpire('${dev.id}', 'radar')" title="Salvează data">💾</button>
            </div>
            <div style="display:flex; gap:4px; margin-top:2px; flex-wrap:wrap;">
              <button type="button" class="btn-pill" onclick="quickAddHours('${dev.id}', 'radar', 1)" title="+1 Oră">+1h</button>
              <button type="button" class="btn-pill" onclick="quickAddHours('${dev.id}', 'radar', 3)" title="+3 Ore">+3h</button>
              <button type="button" class="btn-pill" onclick="quickAdd('${dev.id}', 'radar', 1)" title="+1 Zi">+1 zi</button>
              <button type="button" class="btn-pill" onclick="quickAdd('${dev.id}', 'radar', 7)" title="+7 Zile">+7z</button>
              <button type="button" class="btn-pill" onclick="quickAdd('${dev.id}', 'radar', 30)" title="+30 Zile">+30z</button>
            </div>
          </div>
        </td>
        <td>
          <div style="display:flex; flex-direction:column; gap:5px;">
            <div style="display:flex; align-items:center; gap:6px;">
              <span class="badge ${cancelStatusClass}" id="cancel-badge-${dev.id}">
                ${cancelHours > 0 ? `● ${cancelDays}z (${cancelHours}h)` : '○ Inactiv'}
              </span>
              <small class="text-muted" style="font-size:11px;" id="cancel-text-${dev.id}">${formatExactTime(dev.cancel_expires)}</small>
            </div>
            <div style="display:flex; align-items:center; gap:4px;">
              <input type="datetime-local" class="date-picker-live" id="cancel-input-${dev.id}" value="${toDatetimeLocal(dev.cancel_expires)}" onchange="updateExpire('${dev.id}', 'cancel', this.value)" title="Alege exact data și ora expirării">
              <button type="button" class="btn-save-date" onclick="updateExpire('${dev.id}', 'cancel')" title="Salvează data">💾</button>
            </div>
            <div style="display:flex; gap:4px; margin-top:2px; flex-wrap:wrap;">
              <button type="button" class="btn-pill" onclick="quickAddHours('${dev.id}', 'cancel', 1)" title="+1 Oră">+1h</button>
              <button type="button" class="btn-pill" onclick="quickAddHours('${dev.id}', 'cancel', 3)" title="+3 Ore">+3h</button>
              <button type="button" class="btn-pill" onclick="quickAdd('${dev.id}', 'cancel', 1)" title="+1 Zi">+1 zi</button>
              <button type="button" class="btn-pill" onclick="quickAdd('${dev.id}', 'cancel', 7)" title="+7 Zile">+7z</button>
              <button type="button" class="btn-pill" onclick="quickAdd('${dev.id}', 'cancel', 30)" title="+30 Zile">+30z</button>
            </div>
          </div>
        </td>
        <td>
          <span id="badge-status-${dev.id}" class="badge ${dev.blocked ? 'badge-red' : 'badge-green'}">${dev.blocked ? 'BLOCAT' : 'ACTIV'}</span>
        </td>
        <td>
          <div style="display:flex; flex-direction:column; gap:6px;">
            <button type="button" onclick="toggleBlockLive('${dev.id}')" id="btn-block-${dev.id}" class="btn-action ${dev.blocked ? 'btn-unblock' : 'btn-block'}">
              ${dev.blocked ? 'Deblochează' : 'Blochează'}
            </button>
            <div style="display:flex; gap:4px; flex-wrap:wrap;">
              <button type="button" class="btn-pill" onclick="focusDeviceOnMap('${dev.id}')" style="color:#38bdf8; border:1px solid #0284c7; background:rgba(2,132,199,0.15);" title="Arată pe hartă">🗺️ Hartă</button>
              <button type="button" class="btn-pill" id="btn-hide-${dev.id}" onclick="toggleHideLive('${dev.id}')" style="color:${dev.hidden ? '#4ade80' : '#f87171'}; border:1px solid ${dev.hidden ? '#22c55e' : '#ef4444'}; background:rgba(0,0,0,0.2);" title="${dev.hidden ? 'Restaurează dispozitivul' : 'Ascunde telefonul dezinstalat'}">
                ${dev.hidden ? '👁️ Arată' : '🗑️ Dezinstalat'}
              </button>
              <button type="button" class="btn-pill" onclick="deleteDeviceLive('${dev.id}')" style="color:#ef4444; border:1px solid #dc2626; background:rgba(220,38,38,0.15);" title="Șterge definitiv dispozitivul">❌ Șterge</button>
            </div>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  if (devicesList.length === 0) {
    rows = `<tr><td colspan="6" style="padding: 40px; text-align: center; color: #94a3b8; font-size: 15px;">Niciun telefon conectat încă.<br>Deschideți aplicația SHS pe telefon pentru a apărea aici instantaneu!</td></tr>`;
  }

  res.send(`
    <!DOCTYPE html>
    <html lang="ro">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>SHS - Panou de Control Server</title>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="" />
      <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Inter', -apple-system, sans-serif; }
        body { background: #0b0f19; color: #f1f5f9; min-height: 100vh; padding: 20px; }
        .wrapper { max-width: 1250px; margin: 0 auto; }

        /* Header */
        header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 18px 24px;
          background: #111827;
          border: 1px solid #1f2937;
          border-radius: 16px;
          margin-bottom: 24px;
          box-shadow: 0 10px 25px -5px rgba(0,0,0,0.4);
          flex-wrap: wrap;
          gap: 16px;
        }
        .brand { display: flex; align-items: center; gap: 12px; }
        .logo-box {
          background: linear-gradient(135deg, #0284c7, #2563eb);
          width: 44px;
          height: 44px;
          border-radius: 12px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 800;
          font-size: 18px;
          color: white;
          box-shadow: 0 4px 12px rgba(37, 99, 235, 0.3);
        }
        .brand-title { font-size: 20px; font-weight: 700; color: #ffffff; letter-spacing: -0.5px; }
        .brand-sub { font-size: 12px; color: #94a3b8; }
        .header-actions { display: flex; align-items: center; gap: 12px; }
        .btn-logout {
          background: #1f2937;
          border: 1px solid #374151;
          color: #ef4444;
          padding: 8px 16px;
          border-radius: 10px;
          text-decoration: none;
          font-size: 13px;
          font-weight: 600;
          transition: 0.2s;
        }
        .btn-logout:hover { background: rgba(239, 68, 68, 0.15); border-color: #ef4444; }

        /* Stat Cards */
        .stats-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
          gap: 16px;
          margin-bottom: 24px;
        }
        .stat-card {
          background: #111827;
          border: 1px solid #1f2937;
          border-radius: 16px;
          padding: 20px;
          box-shadow: 0 4px 6px -1px rgba(0,0,0,0.2);
          position: relative;
          overflow: hidden;
        }
        .stat-card::before {
          content: '';
          position: absolute;
          top: 0; left: 0; right: 0; height: 3px;
        }
        .stat-blue::before { background: #38bdf8; }
        .stat-green::before { background: #10b981; }
        .stat-cyan::before { background: #06b6d4; }
        .stat-red::before { background: #ef4444; }
        .stat-num { font-size: 28px; font-weight: 700; color: #ffffff; margin-top: 6px; }
        .stat-label { font-size: 13px; color: #94a3b8; font-weight: 500; }

        /* Card Section */
        .card {
          background: #111827;
          border: 1px solid #1f2937;
          border-radius: 16px;
          padding: 24px;
          margin-bottom: 24px;
          box-shadow: 0 10px 25px -5px rgba(0,0,0,0.3);
        }
        .card-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
          flex-wrap: wrap;
          gap: 12px;
        }
        .card-title { font-size: 18px; font-weight: 700; color: #ffffff; }

        /* Search Bar */
        .search-box {
          position: relative;
          width: 100%;
          max-width: 320px;
        }
        .search-box input {
          width: 100%;
          padding: 10px 14px 10px 36px;
          background: #0b0f19;
          border: 1px solid #334155;
          border-radius: 10px;
          color: white;
          font-size: 13px;
          outline: none;
        }
        .search-box input:focus { border-color: #38bdf8; }
        .search-icon {
          position: absolute;
          left: 12px;
          top: 50%;
          transform: translateY(-50%);
          color: #64748b;
          font-size: 14px;
        }

        /* Table */
        .table-responsive { width: 100%; overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; text-align: left; }
        th {
          padding: 14px 16px;
          background: #0b0f19;
          color: #94a3b8;
          font-size: 12px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          border-bottom: 1px solid #1f2937;
        }
        td {
          padding: 14px 16px;
          border-bottom: 1px solid #1f2937;
          font-size: 14px;
          vertical-align: middle;
        }
        tr.device-row:hover { background: rgba(255,255,255,0.02); }
        tr.is-blocked { background: rgba(239, 68, 68, 0.08); }

        .device-id {
          font-family: 'JetBrains Mono', monospace;
          font-size: 13px;
          color: #38bdf8;
          background: rgba(56, 189, 248, 0.1);
          padding: 3px 8px;
          border-radius: 6px;
        }
        .btn-copy {
          background: transparent;
          border: none;
          cursor: pointer;
          font-size: 14px;
          opacity: 0.7;
          transition: opacity 0.2s;
        }
        .btn-copy:hover { opacity: 1; transform: scale(1.1); }
        .text-muted { font-size: 12px; color: #64748b; }

        /* Badges */
        .badge {
          display: inline-block;
          padding: 4px 10px;
          border-radius: 9999px;
          font-size: 12px;
          font-weight: 600;
        }
        .badge-green { background: rgba(16, 185, 129, 0.15); color: #34d399; }
        .badge-cyan { background: rgba(6, 182, 212, 0.15); color: #38bdf8; }
        .badge-yellow { background: rgba(245, 158, 11, 0.15); color: #fbbf24; }
        .badge-red { background: rgba(239, 68, 68, 0.15); color: #f87171; }

        /* Action Buttons */
        .btn-action {
          padding: 6px 10px;
          border-radius: 8px;
          font-size: 12px;
          font-weight: 600;
          text-decoration: none;
          color: white;
          display: inline-flex;
          align-items: center;
          transition: 0.15s;
          border: none;
          cursor: pointer;
        }
        .btn-block { background: #dc2626; }
        .btn-block:hover { background: #ef4444; }
        .btn-unblock { background: #059669; }
        .btn-unblock:hover { background: #10b981; }

        .date-picker-live {
          background: #1e293b;
          border: 1px solid #334155;
          color: #f8fafc;
          padding: 4px 6px;
          border-radius: 6px;
          font-size: 11px;
          outline: none;
          font-family: inherit;
          cursor: pointer;
        }
        .date-picker-live:focus {
          border-color: #38bdf8;
          box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.2);
        }
        .btn-save-date {
          background: #0284c7;
          color: #fff;
          border: 1px solid #38bdf8;
          padding: 4px 8px;
          border-radius: 6px;
          font-size: 12px;
          cursor: pointer;
          transition: all 0.15s;
        }
        .btn-save-date:hover {
          background: #0369a1;
          transform: scale(1.08);
        }
        .btn-pill {
          background: #334155;
          color: #cbd5e1;
          border: none;
          padding: 2px 7px;
          border-radius: 4px;
          font-size: 10px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.15s;
        }
        .btn-pill:hover {
          background: #0284c7;
          color: #fff;
        }
        .btn-filter {
          background: #1e293b;
          color: #94a3b8;
          border: 1px solid #334155;
          padding: 6px 14px;
          border-radius: 8px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
        }
        .btn-filter:hover {
          background: #334155;
          color: #f8fafc;
        }
        .btn-filter.active {
          background: #0284c7;
          color: #ffffff;
          border-color: #38bdf8;
          box-shadow: 0 0 10px rgba(2, 132, 199, 0.4);
        }
        @keyframes pulseHighlight {
          0% { background: rgba(234, 179, 8, 0.45); box-shadow: inset 0 0 0 3px #facc15; }
          40% { background: rgba(234, 179, 8, 0.85); box-shadow: inset 0 0 0 4px #eab308; }
          100% { background: inherit; box-shadow: none; }
        }
        .highlight-row {
          animation: pulseHighlight 3.5s ease-out;
        }

        /* Form Inputs in Grid */
        .grid-forms {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
          gap: 16px;
          margin-bottom: 16px;
        }
        .form-item { text-align: left; }
        .form-item label { display: block; font-size: 12px; font-weight: 600; color: #94a3b8; margin-bottom: 6px; }
        .form-item input {
          width: 100%;
          padding: 12px 14px;
          background: #0b0f19;
          border: 1px solid #334155;
          border-radius: 10px;
          color: white;
          font-size: 14px;
          outline: none;
        }
        .form-item input:focus { border-color: #38bdf8; }
        .btn-submit {
          padding: 12px 20px;
          background: linear-gradient(135deg, #0284c7, #2563eb);
          color: white;
          border: none;
          border-radius: 10px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
        }
        .btn-submit:hover { opacity: 0.95; }

        /* Toast Alert */
        #toast {
          position: fixed;
          bottom: 24px;
          right: 24px;
          background: #10b981;
          color: white;
          padding: 12px 20px;
          border-radius: 10px;
          font-size: 14px;
          font-weight: 600;
          display: none;
          box-shadow: 0 10px 20px rgba(0,0,0,0.5);
          z-index: 100;
        }

        .btn-recovery {
          padding: 8px 16px;
          background: linear-gradient(135deg, #10b981, #059669);
          color: white;
          border: none;
          border-radius: 8px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          box-shadow: 0 2px 8px rgba(16, 185, 129, 0.25);
          transition: transform 0.15s, opacity 0.15s;
        }
        .btn-recovery:hover {
          transform: translateY(-1px);
          opacity: 0.95;
        }
      </style>
    </head>
    <body>
      <div class="wrapper">
        <header>
          <div class="brand">
            <div class="logo-box">SHS</div>
            <div>
              <div class="brand-title">SHS Control Panel</div>
              <div class="brand-sub">Sistem de Control Licențe & Actualizări</div>
            </div>
          </div>
          <div class="header-actions">
            <button type="button" class="btn-recovery" onclick="openRecoveryModal()" title="Generează parolă de deblocare pentru telefoane șterse">🔄 Recuperare</button>
            <span style="font-size: 13px; color: #94a3b8;">Conectat securizat</span>
            <a href="/admin/logout" class="btn-logout">Deconectare</a>
          </div>
        </header>

        <!-- Statistici Rapide -->
        <div class="stats-grid">
          <div class="stat-card stat-blue">
            <div class="stat-label">Total Dispozitive</div>
            <div class="stat-num">${devicesList.length}</div>
          </div>
          <div class="stat-card" style="border-left: 3px solid #22c55e;">
            <div class="stat-label">🟢 Online Acum</div>
            <div class="stat-num" style="color: #4ade80;">${onlineCount}</div>
          </div>
          <div class="stat-card stat-green">
            <div class="stat-label">Licențe Radar Active</div>
            <div class="stat-num">${activeRadarCount}</div>
          </div>
          <div class="stat-card stat-cyan">
            <div class="stat-label">Licențe Отмена Active</div>
            <div class="stat-num">${activeCancelCount}</div>
          </div>
          <div class="stat-card stat-red">
            <div class="stat-label">Dispozitive Blocate</div>
            <div class="stat-num">${blockedCount}</div>
          </div>
        </div>

        <!-- Hartă Live Dispozitive (GPS) -->
        <div class="card">
          <div class="card-header">
            <div>
              <div class="card-title">🗺️ Hartă Live Dispozitive (GPS & Urmărire)</div>
              <div style="font-size: 12px; color: #94a3b8; margin-top: 2px;">
                Locația fiecărui șofer se actualizează automat când aplicația sau widgetul rulează.
              </div>
            </div>
            <span style="font-size: 12px; color: #4ade80; background: rgba(34, 197, 94, 0.1); padding: 4px 10px; border-radius: 8px; font-weight:600;">🟢 ${onlineCount} active acum</span>
          </div>
          <div id="liveMap" style="height: 380px; width: 100%; border-radius: 12px; border: 1px solid #1f2937; position:relative; z-index:1;"></div>
        </div>

        <!-- Tabel Dispozitive -->
        <div class="card">
          <div class="card-header" style="flex-direction:column; align-items:stretch; gap:14px;">
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
              <div>
                <div class="card-title">📱 Telefoane Înregistrate & Gestiune Acces</div>
                <div style="font-size:12px; color:#94a3b8; margin-top:2px;">
                  Apasă pe oricare pin de pe hartă pentru a sări direct la telefonul respectiv. Orice modificare la expirare se aplică imediat la toate telefoanele de pe același Wi-Fi/IP.
                </div>
              </div>
              <div class="search-box">
                <span class="search-icon">🔍</span>
                <input type="text" id="searchInput" onkeyup="applyFilter()" placeholder="Caută după ID sau model telefon...">
              </div>
            </div>

            <!-- Filtre Rapide Tabel -->
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; padding-top:4px; border-top:1px solid #1f2937;">
              <button type="button" class="btn-filter active" id="filter-all" onclick="setDeviceFilter('all')">📋 Toate (${devicesList.length})</button>
              <button type="button" class="btn-filter" id="filter-active" onclick="setDeviceFilter('active')">🟢 Active (${activeRecentCount})</button>
              <button type="button" class="btn-filter" id="filter-inactive" onclick="setDeviceFilter('inactive')">⚪ Inactive >24h (${inactive24hCount})</button>
              <button type="button" class="btn-filter" id="filter-hidden" onclick="setDeviceFilter('hidden')">🗑️ Dezinstalate (${hiddenCount})</button>
            </div>
          </div>

          <div class="table-responsive">
            <table id="devicesTable">
              <thead>
                <tr>
                  <th>ID Dispozitiv</th>
                  <th>Model Telefon</th>
                  <th>Licență Radar</th>
                  <th>Licență Отмена</th>
                  <th>Status</th>
                  <th>Acțiuni Rapide</th>
                </tr>
              </thead>
              <tbody>
                ${rows}
              </tbody>
            </table>
          </div>
        </div>

        <!-- Card Notificare & Setări Live la Distanță -->
        <div class="card">
          <div class="card-title" style="margin-bottom: 16px;">📡 Control Live la Distanță (Anunțuri Instant)</div>
          <p style="font-size: 13px; color: #94a3b8; margin-bottom: 20px;">
            Anunțul salvat aici apare <b>instantaneu (în 3 secunde)</b> direct pe ecranul șoferilor în timp ce folosesc aplicația.
          </p>
          <form action="/admin/update-remote-config" method="POST">
            <div style="display:flex; flex-direction:column; gap:16px;">
              <div class="form-item">
                <label>📢 Text Anunț / Alertă Live (apare banner pe ecran):</label>
                <input type="text" name="announcement_text" value="${appConfig.announcement_text || ''}" placeholder="Ex: Atenție, promoție nouă sau mentenanță la ora 20:00 (lasă gol dacă vrei să oprești anunțul)">
              </div>

              <div class="form-item">
                <label style="margin-bottom:8px; font-weight:600;">🎯 Destinație Anunț:</label>
                <div style="display:flex; gap:20px; align-items:center; margin-bottom:12px; flex-wrap:wrap;">
                  <label style="display:inline-flex; align-items:center; gap:6px; cursor:pointer; color:#f8fafc; font-size:14px;">
                    <input type="radio" name="announcement_target" value="all" ${(!appConfig.announcement_target || appConfig.announcement_target === 'all') ? 'checked' : ''} onchange="toggleDeviceSelection(false)">
                    <span>📢 Trimite la <b>TOATE telefoanele</b> (Implicit)</span>
                  </label>
                  <label style="display:inline-flex; align-items:center; gap:6px; cursor:pointer; color:#f8fafc; font-size:14px;">
                    <input type="radio" name="announcement_target" value="selected" ${appConfig.announcement_target === 'selected' ? 'checked' : ''} onchange="toggleDeviceSelection(true)">
                    <span>🎯 Doar la telefoanele selectate</span>
                  </label>
                </div>

                <div id="targetDevicesContainer" style="display:${appConfig.announcement_target === 'selected' ? 'block' : 'none'}; background:#0f172a; border:1px solid #334155; border-radius:8px; padding:12px; max-height:220px; overflow-y:auto;">
                  <div style="font-size:12px; color:#94a3b8; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
                    <span>Alege telefoanele care primesc anunțul:</span>
                    <div style="display:flex; gap:6px;">
                      <button type="button" class="btn-pill" onclick="selectAllTargets(true)">Bifează tot</button>
                      <button type="button" class="btn-pill" onclick="selectAllTargets(false)">Debifează tot</button>
                    </div>
                  </div>
                  <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(260px, 1fr)); gap:8px;">
                    ${devicesList.map(d => {
                      const dDiff = now.getTime() - d.last_seen.getTime();
                      const dOnline = (dDiff < 12 * 1000) && !d.is_offline;
                      const isChecked = Array.isArray(appConfig.announcement_devices) && appConfig.announcement_devices.includes(d.id);
                      return `
                        <label style="display:flex; align-items:center; gap:8px; background:#1e293b; padding:8px 10px; border-radius:6px; font-size:12px; color:#f1f5f9; cursor:pointer;">
                          <input type="checkbox" name="target_devices" value="${d.id}" ${isChecked ? 'checked' : ''} class="target-device-chk">
                          <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                            <b>${d.info || 'Telefon'}</b>
                            <span style="color:#64748b; font-family:monospace; margin-left:4px;">(${d.id})</span>
                            <span style="margin-left:6px; font-size:10px; ${dOnline ? 'color:#10b981;' : 'color:#94a3b8;'}">${dOnline ? '● Online' : '○ Offline'}</span>
                          </div>
                        </label>
                      `;
                    }).join('')}
                  </div>
                </div>
              </div>

              <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
                <button type="submit" class="btn-submit" style="background: linear-gradient(135deg, #0284c7, #0369a1); margin-top:0;">🚀 Trimite Anunțul Instant</button>
                ${appConfig.announcement_text ? `
                  <button type="button" class="btn-pill" onclick="clearAnnouncement()" style="color:#ef4444; border:1px solid #ef4444; background:rgba(239,68,68,0.15); padding:10px 16px;">❌ Oprește Anunțul</button>
                ` : ''}
              </div>
            </div>
          </form>
        </div>

        <!-- Card Control Versiune Aplicație -->
        <div class="card">
          <div class="card-title" style="margin-bottom: 16px;">🚀 Actualizări de la Distanță & Fișier APK (In-App Update)</div>
          <p style="font-size: 13px; color: #94a3b8; margin-bottom: 20px;">
            Când ai compilat o versiune nouă cu funcții adăugate, modifică numărul versiunii aici. Telefoanele vor descărca noul APK direct în aplicație și îl vor instala peste versiunea veche.
          </p>
          <form action="/admin/update-version" method="POST">
            <div class="grid-forms">
              <div class="form-item">
                <label>Cod Versiune (VersionCode, ex: 34):</label>
                <input type="number" name="latest_version_code" value="${appConfig.latest_version_code}" required>
              </div>
              <div class="form-item">
                <label>Nume Versiune (VersionName, ex: 2.6.1):</label>
                <input type="text" name="latest_version_name" value="${appConfig.latest_version_name}" required>
              </div>
              <div class="form-item">
                <label>Link Direct Descărcare APK:</label>
                <input type="text" name="update_url" value="${appConfig.update_url}" required>
              </div>
              <div class="form-item" style="grid-column: 1 / -1;">
                <label>Note Actualizare (ce s-a schimbat):</label>
                <input type="text" name="update_notes" value="${appConfig.update_notes || ''}" placeholder="Ex: S-au adăugat opțiuni noi, viteză mărită, remedieri erori...">
              </div>
            </div>
            <button type="submit" class="btn-submit">🚀 Publică Actualizarea pe Telefoane</button>
          </form>
        </div>

        <!-- Card Schimbare Parolă -->
        <div class="card">
          <div class="card-title" style="margin-bottom: 16px;">🔑 Schimbă Parola Panoului de Administrare</div>
          <form action="/admin/change-password" method="POST" style="max-width: 450px;">
            <div class="form-item" style="margin-bottom: 14px;">
              <label>Parolă nouă:</label>
              <input type="password" name="new_password" placeholder="Noua parolă (minim 4 caractere)" required>
            </div>
            <button type="submit" class="btn-submit">Schimbă Parola</button>
          </form>
        </div>
      </div>

      <div id="liveToast" style="display:none;"></div>

      <script>
        window.ADMIN_TOKEN = "${getExpectedToken()}";

        // Notificări Vizuale Toast
        function showToast(msg, isError) {
          let toast = document.getElementById('liveToast');
          if (!toast) {
            toast = document.createElement('div');
            toast.id = 'liveToast';
            document.body.appendChild(toast);
          }
          toast.style.cssText = 'position:fixed; bottom:24px; right:24px; color:#fff; padding:12px 20px; border-radius:10px; font-weight:600; font-size:14px; box-shadow:0 10px 25px rgba(0,0,0,0.5); z-index:99999; transition:all 0.25s; opacity:0; transform:translateY(10px); pointer-events:none; font-family:sans-serif; background:' + (isError ? '#ef4444' : '#10b981') + '; display:block;';
          toast.innerText = msg;
          void toast.offsetWidth;
          toast.style.opacity = '1';
          toast.style.transform = 'translateY(0)';
          clearTimeout(toast._timer);
          toast._timer = setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(10px)';
          }, 2600);
        }

        function copyId(id) {
          if (!id) return;
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(id).then(() => {
              showToast('ID ' + id + ' copiat în clipboard!');
            }).catch(() => {
              prompt('Copiază manual ID-ul:', id);
            });
          } else {
            prompt('Copiază manual ID-ul:', id);
          }
        }

        let currentFilter = 'all';

        function setDeviceFilter(filter) {
          currentFilter = filter;
          document.querySelectorAll('.btn-filter').forEach(b => b.classList.remove('active'));
          const activeBtn = document.getElementById('filter-' + filter);
          if (activeBtn) activeBtn.classList.add('active');
          applyFilter();
        }

        function applyFilter() {
          const searchInput = document.getElementById('searchInput');
          const search = (searchInput ? searchInput.value : '').toLowerCase().trim();
          const rows = document.querySelectorAll('#devicesTable tbody tr.device-row');
          const now = Date.now();

          rows.forEach(row => {
            const isHidden = row.getAttribute('data-hidden') === 'true';
            const lastSeen = parseInt(row.getAttribute('data-lastseen') || '0', 10);
            const diffHours = (now - lastSeen) / (1000 * 3600);
            const text = (row.innerText || '').toLowerCase();

            let matchesFilter = true;
            if (currentFilter === 'active') {
              matchesFilter = !isHidden && (diffHours <= 48 || text.includes('zile') || text.includes('online'));
            } else if (currentFilter === 'inactive') {
              matchesFilter = !isHidden && (diffHours > 24 || text.includes('expirat') || text.includes('inactiv'));
            } else if (currentFilter === 'hidden') {
              matchesFilter = isHidden;
            } else if (currentFilter === 'all') {
              matchesFilter = !isHidden;
            }

            if (matchesFilter && search) {
              matchesFilter = text.includes(search);
            }

            row.style.display = matchesFilter ? '' : 'none';
          });
        }

        function filterDevices() {
          applyFilter();
        }

        function focusDeviceRow(id) {
          const row = document.getElementById('row-' + id);
          if (row) {
            setDeviceFilter('all');
            row.scrollIntoView({ behavior: 'smooth', block: 'center' });
            row.classList.remove('highlight-row');
            void row.offsetWidth;
            row.classList.add('highlight-row');
            setTimeout(() => {
              row.classList.remove('highlight-row');
            }, 3500);
            showToast('Dispozitiv ' + id + ' evidențiat în tabel!');
          } else {
            showToast('Dispozitivul nu a fost găsit în tabel!', true);
          }
        }

        function focusDeviceOnMap(id) {
          if (markersMap[id] && mapInstance) {
            const latLng = markersMap[id].getLatLng();
            mapInstance.setView(latLng, 16);
            markersMap[id].openPopup();
            const mapEl = document.getElementById('liveMap');
            if (mapEl) mapEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            showToast('Telefon localizat pe hartă!');
          } else {
            showToast('Se așteaptă localizarea GPS pentru acest telefon!', true);
          }
        }

        async function updateExpire(id, type, value) {
          if (!value) {
            const input = document.getElementById(type + '-input-' + id);
            if (input && input.value) value = input.value;
          }
          if (!value) {
            showToast('Selectează o dată și o oră validă!', true);
            return;
          }

          try {
            const res = await fetch('/api/admin/set-expiration', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Admin-Token': window.ADMIN_TOKEN || ''
              },
              credentials: 'same-origin',
              body: JSON.stringify({ id, type, expires: value })
            });

            if (res.status === 401) {
              alert('Sesiunea a expirat! Te rugăm să te reconectezi.');
              window.location.href = '/';
              return;
            }

            const data = await res.json();
            if (data.ok) {
              if (type === 'radar' || type === 'both') {
                const input = document.getElementById('radar-input-' + id);
                if (input && data.radar_input) input.value = data.radar_input;
                const el = document.getElementById('radar-text-' + id);
                if (el) el.innerText = data.radar_formatted;
                const badge = document.getElementById('radar-badge-' + id);
                if (badge) {
                  badge.innerText = data.radar_badge;
                  badge.className = 'badge ' + data.radar_class;
                }
              }
              if (type === 'cancel' || type === 'both') {
                const input = document.getElementById('cancel-input-' + id);
                if (input && data.cancel_input) input.value = data.cancel_input;
                const el = document.getElementById('cancel-text-' + id);
                if (el) el.innerText = data.cancel_formatted;
                const badge = document.getElementById('cancel-badge-' + id);
                if (badge) {
                  badge.innerText = data.cancel_badge;
                  badge.className = 'badge ' + data.cancel_class;
                }
              }
              showToast('Data a fost salvată și sincronizată cu succes!');
              if (typeof updateLiveMap === 'function') updateLiveMap();
            } else {
              showToast(data.error || 'Eroare la salvare!', true);
            }
          } catch (e) {
            console.error(e);
            showToast('Eroare conexiune server!', true);
          }
        }

        async function quickAddHours(id, type, hours) {
          try {
            const res = await fetch('/api/admin/set-expiration', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Admin-Token': window.ADMIN_TOKEN || ''
              },
              credentials: 'same-origin',
              body: JSON.stringify({ id, type, addHours: hours })
            });

            if (res.status === 401) {
              window.location.href = '/';
              return;
            }

            const data = await res.json();
            if (data.ok) {
              if (type === 'radar' || type === 'both') {
                const input = document.getElementById('radar-input-' + id);
                if (input && data.radar_input) input.value = data.radar_input;
                const el = document.getElementById('radar-text-' + id);
                if (el) el.innerText = data.radar_formatted;
                const badge = document.getElementById('radar-badge-' + id);
                if (badge) {
                  badge.innerText = data.radar_badge;
                  badge.className = 'badge ' + data.radar_class;
                }
              }
              if (type === 'cancel' || type === 'both') {
                const input = document.getElementById('cancel-input-' + id);
                if (input && data.cancel_input) input.value = data.cancel_input;
                const el = document.getElementById('cancel-text-' + id);
                if (el) el.innerText = data.cancel_formatted;
                const badge = document.getElementById('cancel-badge-' + id);
                if (badge) {
                  badge.innerText = data.cancel_badge;
                  badge.className = 'badge ' + data.cancel_class;
                }
              }
              showToast('+' + hours + ' ore adăugate live!');
              if (typeof updateLiveMap === 'function') updateLiveMap();
            } else {
              showToast(data.error || 'Eroare la adăugare!', true);
            }
          } catch (e) {
            console.error(e);
            showToast('Eroare conexiune server!', true);
          }
        }

        async function quickAdd(id, type, days) {
          try {
            const res = await fetch('/api/admin/set-expiration', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Admin-Token': window.ADMIN_TOKEN || ''
              },
              credentials: 'same-origin',
              body: JSON.stringify({ id, type, addDays: days })
            });

            if (res.status === 401) {
              window.location.href = '/';
              return;
            }

            const data = await res.json();
            if (data.ok) {
              if (type === 'radar' || type === 'both') {
                const input = document.getElementById('radar-input-' + id);
                if (input && data.radar_input) input.value = data.radar_input;
                const el = document.getElementById('radar-text-' + id);
                if (el) el.innerText = data.radar_formatted;
                const badge = document.getElementById('radar-badge-' + id);
                if (badge) {
                  badge.innerText = data.radar_badge;
                  badge.className = 'badge ' + data.radar_class;
                }
              }
              if (type === 'cancel' || type === 'both') {
                const input = document.getElementById('cancel-input-' + id);
                if (input && data.cancel_input) input.value = data.cancel_input;
                const el = document.getElementById('cancel-text-' + id);
                if (el) el.innerText = data.cancel_formatted;
                const badge = document.getElementById('cancel-badge-' + id);
                if (badge) {
                  badge.innerText = data.cancel_badge;
                  badge.className = 'badge ' + data.cancel_class;
                }
              }
              showToast('+' + days + ' zile adăugate live!');
              if (typeof updateLiveMap === 'function') updateLiveMap();
            } else {
              showToast(data.error || 'Eroare la adăugare!', true);
            }
          } catch (e) {
            console.error(e);
            showToast('Eroare conexiune server!', true);
          }
        }

        async function toggleBlockLive(id) {
          try {
            const res = await fetch('/api/admin/toggle-block', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Admin-Token': window.ADMIN_TOKEN || ''
              },
              credentials: 'same-origin',
              body: JSON.stringify({ id })
            });

            if (res.status === 401) {
              window.location.href = '/';
              return;
            }

            const data = await res.json();
            if (data.ok) {
              const btn = document.getElementById('btn-block-' + id);
              const badge = document.getElementById('badge-status-' + id);
              const row = document.getElementById('row-' + id);
              if (data.blocked) {
                if (btn) {
                  btn.innerText = 'Deblochează';
                  btn.className = 'btn-action btn-unblock';
                }
                if (badge) {
                  badge.innerText = 'BLOCAT';
                  badge.className = 'badge badge-red';
                }
                if (row) row.classList.add('is-blocked');
                showToast('Dispozitiv blocat live!');
              } else {
                if (btn) {
                  btn.innerText = 'Blochează';
                  btn.className = 'btn-action btn-block';
                }
                if (badge) {
                  badge.innerText = 'ACTIV';
                  badge.className = 'badge badge-green';
                }
                if (row) row.classList.remove('is-blocked');
                showToast('Dispozitiv deblocat live!');
              }
              if (typeof updateLiveMap === 'function') updateLiveMap();
            } else {
              showToast(data.error || 'Eroare toggle!', true);
            }
          } catch (e) {
            console.error(e);
            showToast('Eroare conexiune server!', true);
          }
        }

        async function toggleHideLive(id) {
          try {
            const res = await fetch('/api/admin/toggle-hide', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Admin-Token': window.ADMIN_TOKEN || ''
              },
              credentials: 'same-origin',
              body: JSON.stringify({ id })
            });

            if (res.status === 401) {
              window.location.href = '/';
              return;
            }

            const data = await res.json();
            if (data.ok) {
              const row = document.getElementById('row-' + id);
              const btn = document.getElementById('btn-hide-' + id);
              if (row) row.setAttribute('data-hidden', data.hidden ? 'true' : 'false');
              if (btn) {
                if (data.hidden) {
                  btn.innerText = '👁️ Arată';
                  btn.style.color = '#4ade80';
                  btn.style.borderColor = '#22c55e';
                  btn.title = 'Restaurează dispozitivul';
                } else {
                  btn.innerText = '🗑️ Dezinstalat';
                  btn.style.color = '#f87171';
                  btn.style.borderColor = '#ef4444';
                  btn.title = 'Ascunde telefonul dezinstalat';
                }
              }
              applyFilter();
              showToast(data.hidden ? 'Telefon ascuns din tabel!' : 'Telefon restaurat în tabel!');
              if (typeof updateLiveMap === 'function') updateLiveMap();
            } else {
              showToast(data.error || 'Eroare!', true);
            }
          } catch (e) {
            console.error(e);
            showToast('Eroare conexiune server!', true);
          }
        }

        async function toggleUninstalledLive(id) {
          try {
            const res = await fetch('/api/admin/toggle-uninstalled', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Admin-Token': window.ADMIN_TOKEN || ''
              },
              credentials: 'same-origin',
              body: JSON.stringify({ id })
            });

            if (res.status === 401) {
              window.location.href = '/';
              return;
            }

            const data = await res.json();
            if (data.ok) {
              const btn = document.getElementById('btn-uninst-' + id);
              if (btn) {
                if (data.uninstalled) {
                  btn.innerText = '♻️ Reinstalată';
                  btn.style.color = '#4ade80';
                  btn.style.borderColor = '#22c55e';
                  btn.title = 'Restaurează aplicația ca activă';
                } else {
                  btn.innerText = '🗑️ Aplicație ștearsă';
                  btn.style.color = '#f97316';
                  btn.style.borderColor = '#ea580c';
                  btn.title = 'Marchează că utilizatorul a șters aplicația';
                }
              }
              showToast(data.uninstalled ? 'Marcat ca: Aplicație ștearsă!' : 'Marcat ca: Reinstalată / Activă!');
              setTimeout(() => window.location.reload(), 1000);
            } else {
              showToast(data.error || 'Eroare toggle!', true);
            }
          } catch (e) {
            console.error(e);
            showToast('Eroare conexiune server!', true);
          }
        }

        function toggleDeviceSelection(show) {
          const c = document.getElementById('targetDevicesContainer');
          if (c) c.style.display = show ? 'block' : 'none';
        }

        function selectAllTargets(check) {
          document.querySelectorAll('.target-device-chk').forEach(el => el.checked = check);
        }

        function clearAnnouncement() {
          const input = document.querySelector('input[name="announcement_text"]');
          if (input) {
            input.value = '';
            input.closest('form').submit();
          }
        }

        async function deleteDeviceLive(id) {
          if (!confirm('Ești sigur că vrei să ștergi definitiv dispozitivul ' + id + '? Va fi eliminat complet din sistem.')) {
            return;
          }
          try {
            const res = await fetch('/api/admin/delete-device', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Admin-Token': window.ADMIN_TOKEN || ''
              },
              credentials: 'same-origin',
              body: JSON.stringify({ id })
            });

            if (res.status === 401) {
              window.location.href = '/';
              return;
            }

            const data = await res.json();
            if (data.ok) {
              const row = document.getElementById('row-' + id);
              if (row) {
                row.style.transition = 'all 0.3s ease';
                row.style.opacity = '0';
                row.style.transform = 'scale(0.95)';
                setTimeout(() => row.remove(), 300);
              }
              if (markersMap[id] && mapInstance) {
                mapInstance.removeLayer(markersMap[id]);
                delete markersMap[id];
              }
              showToast('Dispozitiv ' + id + ' șters definitiv!');
              if (typeof updateLiveMap === 'function') updateLiveMap();
            } else {
              showToast(data.error || 'Eroare la ștergere!', true);
            }
          } catch (e) {
            console.error(e);
            showToast('Eroare conexiune server!', true);
          }
        }

        // Harta Leaflet Live
        let mapInstance = null;
        const markersMap = {};
        let initialBoundsSet = false;

        function initMap() {
          const mapEl = document.getElementById('liveMap');
          if (!mapEl || mapInstance) return;
          if (typeof L === 'undefined') {
            mapEl.innerHTML = '<div style="display:flex; align-items:center; justify-content:center; height:100%; color:#94a3b8; font-size:13px;">Se încarcă biblioteca hărții...</div>';
            setTimeout(initMap, 300);
            return;
          }
          try {
            mapEl.innerHTML = '';
            mapInstance = L.map('liveMap', {
              zoomControl: true,
              scrollWheelZoom: true
            }).setView([47.0105, 28.8638], 12);

            // Folosim OpenStreetMap standard pentru compatibilitate maximă și încărcare 100% sigură
            L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
              maxZoom: 19,
              attribution: '&copy; OpenStreetMap contributors'
            }).addTo(mapInstance);

            setTimeout(() => { if (mapInstance) mapInstance.invalidateSize(); }, 200);
            setTimeout(() => { if (mapInstance) mapInstance.invalidateSize(); }, 600);
            setTimeout(() => { if (mapInstance) mapInstance.invalidateSize(); }, 1500);
          } catch(err) {
            console.error('Eroare init harta:', err);
          }
        }

        window.addEventListener('resize', () => {
          if (mapInstance) mapInstance.invalidateSize();
        });

        async function updateLiveMap() {
          if (typeof L === 'undefined') return;
          if (!mapInstance) {
            initMap();
            if (!mapInstance) return;
          }

          try {
            const res = await fetch('/api/admin/live-devices', {
              headers: { 'X-Admin-Token': window.ADMIN_TOKEN || '' },
              credentials: 'same-origin'
            });
            if (!res.ok) return;
            const data = await res.json();
            if (!data || !data.devices) return;

            const bounds = [];
            const activeIds = new Set();

            data.devices.forEach(d => {
              if (d.hidden) return;
              if (typeof d.lat !== 'number' || typeof d.lon !== 'number' || isNaN(d.lat) || isNaN(d.lon)) return;
              if (d.lat === 0 && d.lon === 0) return;

              activeIds.add(d.id);
              bounds.push([d.lat, d.lon]);

              let markerBg = '#64748b';
              let shadow = '';
              if (d.blocked) {
                markerBg = '#ef4444';
                shadow = 'box-shadow: 0 0 14px #ef4444;';
              } else if (d.loc_source === 'gps') {
                markerBg = '#22c55e';
                shadow = 'box-shadow: 0 0 14px #22c55e;';
              } else {
                markerBg = '#0ea5e9';
                shadow = 'box-shadow: 0 0 10px #0ea5e9;';
              }

              const iconHtml = '<div style="background:' + markerBg + '; width:22px; height:22px; border-radius:50%; border:2px solid #fff; cursor:pointer; ' + shadow + '"></div>';
              const customIcon = L.divIcon({ html: iconHtml, className: 'map-pin', iconSize: [22, 22] });

              const locText = d.loc_source === 'gps' ? '🛰️ GPS Live' : ('🌐 Rețea IP (' + (d.city || 'Chișinău') + ')');

              const popupHtml =
                '<div style="color:#0f172a; font-family:sans-serif; min-width:220px; padding:4px;">' +
                  '<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:4px;">' +
                    '<b style="font-size:14px; color:#0f172a;">' + (d.info || 'Telefon') + '</b>' +
                    '<span style="font-size:11px; font-weight:600; padding:2px 6px; border-radius:4px; ' + (d.blocked ? 'background:#fee2e2; color:#b91c1c;' : (d.online ? 'background:#dcfce7; color:#15803d;' : 'background:#f1f5f9; color:#475569;')) + '">' + (d.blocked ? 'BLOCAT' : (d.online ? 'ONLINE' : 'OFFLINE')) + '</span>' +
                  '</div>' +
                  '<div style="font-size:11px; color:#64748b; font-family:monospace; margin-bottom:4px;">ID: ' + d.id + ' · 📱 v' + (d.app_version || '2.6.1') + '</div>' +
                  '<div style="font-size:11px; color:#0284c7; margin-bottom:2px;">🌐 IP Real: <b>' + (d.ip || 'Nedetectat') + '</b></div>' +
                  '<div style="font-size:11px; color:#0369a1; margin-bottom:2px;">📡 Radar: <b>' + d.radar_exp + '</b></div>' +
                  '<div style="font-size:11px; color:#047857; margin-bottom:4px;">🛑 Отмена: <b>' + d.cancel_exp + '</b></div>' +
                  '<div style="font-size:11px; color:#64748b; margin-bottom:8px;">Văzut: ' + d.last_seen + '</div>' +
                  '<div style="display:flex; gap:6px; margin-top:8px;">' +
                    '<button type="button" onclick="focusDeviceRow(&apos;' + d.id + '&apos;)" style="flex:1; background:#0284c7; color:#fff; border:none; padding:6px 10px; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer;">📱 Vezi în Tabel</button>' +
                    '<a href="https://www.google.com/maps?q=' + d.lat + ',' + d.lon + '" target="_blank" style="background:#f1f5f9; color:#0284c7; border:1px solid #cbd5e1; padding:5px 8px; border-radius:6px; font-size:12px; font-weight:600; text-decoration:none; display:flex; align-items:center;">🗺️</a>' +
                  '</div>' +
                '</div>';

              if (markersMap[d.id]) {
                markersMap[d.id].setLatLng([d.lat, d.lon]);
                markersMap[d.id].setIcon(customIcon);
                markersMap[d.id].setPopupContent(popupHtml);
              } else {
                const marker = L.marker([d.lat, d.lon], { icon: customIcon }).addTo(mapInstance);
                marker.bindPopup(popupHtml);
                marker.on('click', () => { focusDeviceRow(d.id); });
                markersMap[d.id] = marker;
              }

              const statusEl = document.getElementById('online-status-' + d.id);
              if (statusEl) {
                statusEl.innerHTML = d.online
                  ? '<span style="display:inline-flex; align-items:center; gap:5px; color:#4ade80; font-size:12px; font-weight:600;"><span style="width:8px; height:8px; border-radius:50%; background:#22c55e; box-shadow:0 0 8px #22c55e;"></span> 🟢 Online (Activ)</span>'
                  : '<span style="display:inline-flex; align-items:center; gap:5px; color:#94a3b8; font-size:11px;"><span style="width:7px; height:7px; border-radius:50%; background:#64748b;"></span> ⚪ Offline</span>';
              }
            });

            Object.keys(markersMap).forEach(id => {
              if (!activeIds.has(id)) {
                mapInstance.removeLayer(markersMap[id]);
                delete markersMap[id];
              }
            });

            if (!initialBoundsSet && bounds.length > 0) {
              mapInstance.fitBounds(bounds, { maxZoom: 14, padding: [40, 40] });
              initialBoundsSet = true;
            }
          } catch(e) {
            console.error('Eroare sincronizare hartă:', e);
          }
        }

        // Execuție imediată la pornire
        try {
          applyFilter();
        } catch(e) {}

        try {
          initMap();
          updateLiveMap();
          setInterval(updateLiveMap, 4000);
        } catch(e) {
          console.error(e);
        }

        // Gestiune Modal & Parolă Unică de Recuperare (3 minute)
        let recoveryTimerInterval = null;
        let recoveryExpiresAt = 0;

        async function openRecoveryModal() {
          const modal = document.getElementById('recoveryModal');
          if (modal) modal.style.display = 'flex';
          await fetchNewRecoveryCode();
        }

        function closeRecoveryModal() {
          const modal = document.getElementById('recoveryModal');
          if (modal) modal.style.display = 'none';
          if (recoveryTimerInterval) clearInterval(recoveryTimerInterval);
        }

        async function fetchNewRecoveryCode() {
          const display = document.getElementById('recoveryCodeDisplay');
          const timerEl = document.getElementById('recoveryTimer');
          const copyBtn = document.getElementById('btnCopyCode');
          if (copyBtn) copyBtn.innerText = '📋 Copiază Codul';
          if (display) {
            display.innerText = '......';
            display.style.color = '#38bdf8';
          }
          if (timerEl) timerEl.innerText = 'Se generează...';

          try {
            const res = await fetch('/api/admin/generate-recovery-code', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Admin-Token': window.ADMIN_TOKEN || ''
              },
              credentials: 'same-origin'
            });

            if (res.status === 401) {
              window.location.href = '/';
              return;
            }

            const data = await res.json();
            if (data.ok && data.code) {
              if (display) display.innerText = data.code;
              recoveryExpiresAt = data.expiresAt;
              startRecoveryCountdown();
              showToast('Parolă unică de recuperare generată!');
            } else {
              if (display) display.innerText = 'EROARE';
              if (timerEl) timerEl.innerText = data.error || 'Eroare generare';
            }
          } catch(e) {
            console.error(e);
            if (display) display.innerText = 'EROARE';
            if (timerEl) timerEl.innerText = 'Eroare conexiune';
          }
        }

        function startRecoveryCountdown() {
          if (recoveryTimerInterval) clearInterval(recoveryTimerInterval);
          const timerEl = document.getElementById('recoveryTimer');

          function tick() {
            const remaining = Math.max(0, Math.floor((recoveryExpiresAt - Date.now()) / 1000));
            if (remaining <= 0) {
              if (timerEl) timerEl.innerText = '⚠️ Parolă expirată (apasă 🔄 Nou)';
              const display = document.getElementById('recoveryCodeDisplay');
              if (display) display.style.color = '#ef4444';
              clearInterval(recoveryTimerInterval);
              return;
            }
            const m = Math.floor(remaining / 60);
            const s = remaining % 60;
            const text = '⏱️ Valabil: ' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
            if (timerEl) timerEl.innerText = text;
            const display = document.getElementById('recoveryCodeDisplay');
            if (display) display.style.color = '#38bdf8';
          }

          tick();
          recoveryTimerInterval = setInterval(tick, 1000);
        }

        function copyRecoveryCode() {
          const display = document.getElementById('recoveryCodeDisplay');
          const copyBtn = document.getElementById('btnCopyCode');
          if (!display) return;
          const code = display.innerText.trim();
          if (!code || code === '......' || code === 'EROARE') return;

          navigator.clipboard.writeText(code).then(() => {
            if (copyBtn) copyBtn.innerText = '✅ Copiat!';
            showToast('Parolă ' + code + ' copiată!');
            setTimeout(() => {
              if (copyBtn) copyBtn.innerText = '📋 Copiază Codul';
            }, 2500);
          }).catch(() => {
            showToast('Parolă: ' + code);
          });
        }

        // Atașare explicită pe window pentru compatibilitate maximă cu toate browserele mobile & desktop
        window.showToast = showToast;
        window.copyId = copyId;
        window.setDeviceFilter = setDeviceFilter;
        window.applyFilter = applyFilter;
        window.focusDeviceRow = focusDeviceRow;
        window.focusDeviceOnMap = focusDeviceOnMap;
        window.updateExpire = updateExpire;
        window.quickAddHours = quickAddHours;
        window.quickAdd = quickAdd;
        window.toggleBlockLive = toggleBlockLive;
        window.toggleHideLive = toggleHideLive;
        window.toggleUninstalledLive = toggleUninstalledLive;
        window.deleteDeviceLive = deleteDeviceLive;
        window.toggleDeviceSelection = toggleDeviceSelection;
        window.selectAllTargets = selectAllTargets;
        window.clearAnnouncement = clearAnnouncement;
        window.openRecoveryModal = openRecoveryModal;
        window.closeRecoveryModal = closeRecoveryModal;
        window.fetchNewRecoveryCode = fetchNewRecoveryCode;
        window.copyRecoveryCode = copyRecoveryCode;
        window.initMap = initMap;
        window.updateLiveMap = updateLiveMap;
      </script>

      <!-- Fereastră Mică Deasupra (Modal Recuperare Dispozitive Șterse) -->
      <div id="recoveryModal" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.8); backdrop-filter:blur(5px); z-index:9999; align-items:center; justify-content:center; padding:16px;">
        <div style="background:#0f172a; border:1px solid #334155; border-radius:16px; padding:28px 24px; width:100%; max-width:440px; box-shadow:0 25px 50px -12px rgba(0,0,0,0.9); position:relative; text-align:center;">
          <button type="button" onclick="closeRecoveryModal()" style="position:absolute; top:14px; right:16px; background:none; border:none; color:#94a3b8; font-size:22px; cursor:pointer; padding:4px;" title="Închide">✕</button>

          <div style="font-size:36px; margin-bottom:8px;">🔄</div>
          <h3 style="color:#f8fafc; font-size:20px; font-weight:700; margin-bottom:6px;">Recuperare Dispozitiv Șters</h3>
          <p style="color:#94a3b8; font-size:13px; line-height:1.5; margin-bottom:20px;">
            Această parolă este de <b>unică folosință</b> și este valabilă <b>3 minute</b>.<br>
            La fiecare reintrare sau apăsare se generează o parolă nouă, iar cea veche se anulează automat.
          </p>

          <!-- Caseta cu Parola din 6 Simboluri -->
          <div style="background:#020617; border:2px dashed #0284c7; border-radius:12px; padding:20px; margin-bottom:18px;">
            <div id="recoveryCodeDisplay" style="font-family:'JetBrains Mono', monospace; font-size:36px; font-weight:700; letter-spacing:6px; color:#38bdf8;">------</div>
            <div id="recoveryTimer" style="font-size:13px; color:#f59e0b; margin-top:10px; font-weight:600;">⏱️ Valabil: 03:00</div>
          </div>

          <!-- Butoane Acțiuni -->
          <div style="display:flex; gap:10px; justify-content:center;">
            <button type="button" onclick="copyRecoveryCode()" id="btnCopyCode" style="flex:1; padding:12px; background:linear-gradient(135deg, #0284c7, #2563eb); color:white; border:none; border-radius:10px; font-weight:600; font-size:14px; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:6px;">📋 Copiază Codul</button>
            <button type="button" onclick="fetchNewRecoveryCode()" style="padding:12px 18px; background:#1e293b; color:#cbd5e1; border:1px solid #334155; border-radius:10px; font-weight:600; font-size:14px; cursor:pointer;" title="Generează altă parolă nouă">🔄 Nou</button>
          </div>

          <div style="margin-top:16px; font-size:11px; color:#64748b;">
            Șoferul atinge centrul ecranului în aplicație și introduce acest cod pentru a reveni instant activ cu datele salvate.
          </div>
        </div>
      </div>
    </body>
    </html>
  `);
});

// ==========================================
// ACȚIUNI ADMIN (PROTEJATE)
// ==========================================

// Direct Set Expiration via GET/POST (fallback)
app.all('/admin/set-date', (req, res) => {
  if (!isAuthenticated(req)) return res.redirect('/');
  const id = req.query.id || req.body.id;
  const type = req.query.type || req.body.type || 'radar';
  const expires = req.query.expires || req.body.expires;
  const dev = devices[id];
  if (dev && expires) {
    const target = parseMoldovaDate(expires);
    if (target) {
      applyExpirationToDeviceAndIp(dev, type, type === 'cancel' ? null : target, type === 'radar' ? null : target);
    }
  }
  res.redirect('/');
});

// Quick Add (ex: +30 zile)
app.get('/admin/quick-add', (req, res) => {
  if (!isAuthenticated(req)) return res.redirect('/');
  const { id, type, days, hours } = req.query;
  const dev = devices[id];
  if (dev) {
    let addMs = 0;
    if (hours) {
      addMs = parseFloat(hours) * 60 * 60 * 1000;
    } else {
      addMs = parseInt(days || 30) * 24 * 60 * 60 * 1000;
    }
    const now = new Date();
    let newRadar = null;
    let newCancel = null;
    if (type === 'radar' || type === 'both') {
      const base = dev.radar_expires > now ? dev.radar_expires.getTime() : now.getTime();
      newRadar = new Date(base + addMs);
    }
    if (type === 'cancel' || type === 'both') {
      const base = dev.cancel_expires > now ? dev.cancel_expires.getTime() : now.getTime();
      newCancel = new Date(base + addMs);
    }
    applyExpirationToDeviceAndIp(dev, type, newRadar, newCancel);
  }
  res.redirect('/');
});

// Custom Add
app.get('/admin/custom-add', (req, res) => {
  if (!isAuthenticated(req)) return res.redirect('/');
  const { id, type, days, hours } = req.query;
  const dev = devices[id];
  if (dev) {
    let addMs = 0;
    if (hours) {
      const h = parseFloat(hours);
      if (!isNaN(h) && h > 0) addMs = h * 60 * 60 * 1000;
    } else if (days) {
      const d = parseFloat(days);
      if (!isNaN(d) && d > 0) addMs = d * 24 * 60 * 60 * 1000;
    }
    if (addMs > 0) {
      const now = new Date();
      let newRadar = null;
      let newCancel = null;
      if (type === 'radar' || type === 'both') {
        const base = dev.radar_expires > now ? dev.radar_expires.getTime() : now.getTime();
        newRadar = new Date(base + addMs);
      }
      if (type === 'cancel' || type === 'both') {
        const base = dev.cancel_expires > now ? dev.cancel_expires.getTime() : now.getTime();
        newCancel = new Date(base + addMs);
      }
      applyExpirationToDeviceAndIp(dev, type, newRadar, newCancel);
    }
  }
  res.redirect('/');
});

// Blochează / Deblochează
app.get('/admin/block', (req, res) => {
  if (!isAuthenticated(req)) return res.redirect('/');
  const { id } = req.query;
  const dev = devices[id];
  if (dev) {
    dev.blocked = !dev.blocked;
    saveDevices();
    if (dev.netKey && ipRegistry[dev.netKey]) {
      ipRegistry[dev.netKey].blocked = dev.blocked;
      saveIpRegistry();
    }
    if (dev.ip && ipRegistry[dev.ip]) {
      ipRegistry[dev.ip].blocked = dev.blocked;
      saveIpRegistry();
    }
  }
  res.redirect('/');
});

// Ștergere dezactivată pentru a preveni abuzul de trial gratuit
app.get('/admin/delete', (req, res) => {
  if (!isAuthenticated(req)) return res.redirect('/');
  res.redirect('/');
});

// Actualizare Remote Config (Anunțuri Instant & Targetate)
app.post('/admin/update-remote-config', (req, res) => {
  if (!isAuthenticated(req)) return res.redirect('/');
  const newText = (req.body.announcement_text || '').trim();
  const oldText = appConfig.announcement_text || '';
  appConfig.announcement_text = newText;
  appConfig.announcement_target = req.body.announcement_target || 'all';
  let targets = req.body.target_devices;
  if (!targets) {
    targets = [];
  } else if (!Array.isArray(targets)) {
    targets = [targets];
  }
  appConfig.announcement_devices = targets;
  if (newText && newText !== oldText) {
    appConfig.announcement_id = (appConfig.announcement_id || 0) + 1;
  }
  if (req.body.telegram) {
    appConfig.telegram = req.body.telegram.replace('@', '').trim();
  }
  if (req.body.group_url) {
    appConfig.group_url = req.body.group_url.trim();
  }
  saveConfig();
  res.redirect('/');
});

// Actualizare versiune APK (In-App Update)
app.post('/admin/update-version', (req, res) => {
  if (!isAuthenticated(req)) return res.redirect('/');
  appConfig.latest_version_code = parseInt(req.body.latest_version_code);
  appConfig.latest_version_name = req.body.latest_version_name;
  appConfig.update_url = req.body.update_url;
  appConfig.update_notes = req.body.update_notes || '';
  saveConfig();
  res.redirect('/');
});

// Endpoint Live Set Expiration (Setare exactă dată și oră sau adăugare zile)
app.post('/api/admin/set-expiration', (req, res) => {
  try {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Neautorizat' });
    const { id, type, expires, addDays, addHours } = req.body;
    const dev = devices[id];
    if (!dev) return res.status(404).json({ error: 'Dispozitiv negăsit' });

    if (!(dev.radar_expires instanceof Date) || isNaN(dev.radar_expires.getTime())) {
      dev.radar_expires = new Date(dev.radar_expires || Date.now());
    }
    if (!(dev.cancel_expires instanceof Date) || isNaN(dev.cancel_expires.getTime())) {
      dev.cancel_expires = new Date(dev.cancel_expires || Date.now());
    }

    const now = new Date();
    let newRadar = null;
    let newCancel = null;

    if (addHours) {
      const h = parseFloat(addHours);
      if (!isNaN(h) && h > 0) {
        const addMs = h * 60 * 60 * 1000;
        if (type === 'radar' || type === 'both') {
          const base = dev.radar_expires > now ? dev.radar_expires.getTime() : now.getTime();
          newRadar = new Date(base + addMs);
        }
        if (type === 'cancel' || type === 'both') {
          const base = dev.cancel_expires > now ? dev.cancel_expires.getTime() : now.getTime();
          newCancel = new Date(base + addMs);
        }
      }
    } else if (addDays) {
      const d = parseFloat(addDays);
      if (!isNaN(d) && d > 0) {
        const addMs = d * 24 * 60 * 60 * 1000;
        if (type === 'radar' || type === 'both') {
          const base = dev.radar_expires > now ? dev.radar_expires.getTime() : now.getTime();
          newRadar = new Date(base + addMs);
        }
        if (type === 'cancel' || type === 'both') {
          const base = dev.cancel_expires > now ? dev.cancel_expires.getTime() : now.getTime();
          newCancel = new Date(base + addMs);
        }
      }
    } else if (expires) {
      const target = parseMoldovaDate(expires);
      if (target && !isNaN(target.getTime())) {
        if (type === 'radar' || type === 'both') newRadar = target;
        if (type === 'cancel' || type === 'both') newCancel = target;
      }
    }

    if (newRadar || newCancel) {
      applyExpirationToDeviceAndIp(dev, type, newRadar, newCancel);
    } else {
      saveDevices();
    }

    const radarMs = dev.radar_expires.getTime() - now.getTime();
    const radarDays = Math.max(0, Math.ceil(radarMs / (1000 * 60 * 60 * 24)));
    const radarClass = radarDays > 7 ? 'badge-green' : (radarDays > 0 ? 'badge-yellow' : 'badge-red');
    const radarBadge = radarDays > 0 ? `● ${radarDays} zile` : '○ Expirat';

    const cancelMs = dev.cancel_expires.getTime() - now.getTime();
    const cancelHours = Math.max(0, Math.ceil(cancelMs / (1000 * 60 * 60)));
    const cancelDays = Math.max(0, Math.ceil(cancelHours / 24));
    const cancelClass = cancelHours > 24 ? 'badge-cyan' : (cancelHours > 0 ? 'badge-yellow' : 'badge-red');
    const cancelBadge = cancelHours > 0 ? `● ${cancelDays}z (${cancelHours}h)` : '○ Inactiv';

    res.json({
      ok: true,
      radar_expires: dev.radar_expires.toISOString(),
      radar_formatted: formatExactTime(dev.radar_expires),
      radar_input: toDatetimeLocal(dev.radar_expires),
      radar_badge: radarBadge,
      radar_class: radarClass,
      cancel_expires: dev.cancel_expires.toISOString(),
      cancel_formatted: formatExactTime(dev.cancel_expires),
      cancel_input: toDatetimeLocal(dev.cancel_expires),
      cancel_badge: cancelBadge,
      cancel_class: cancelClass
    });
  } catch (err) {
    console.error('Eroare set-expiration:', err);
    res.status(500).json({ error: 'Eroare la salvare: ' + err.message });
  }
});

// Endpoint Live Toggle Block
app.post('/api/admin/toggle-block', (req, res) => {
  try {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauthorized' });
    const { id } = req.body;
    const dev = devices[id];
    if (!dev) return res.status(404).json({ error: 'Dispozitiv negăsit' });
    dev.blocked = !dev.blocked;
    saveDevices();
    if (dev.netKey && ipRegistry[dev.netKey]) {
      ipRegistry[dev.netKey].blocked = dev.blocked;
      saveIpRegistry();
    }
    if (dev.ip && ipRegistry[dev.ip]) {
      ipRegistry[dev.ip].blocked = dev.blocked;
      saveIpRegistry();
    }
    res.json({ ok: true, blocked: dev.blocked });
  } catch (err) {
    console.error('Eroare toggle-block:', err);
    res.status(500).json({ error: 'Eroare la blocare/deblocare' });
  }
});

// Endpoint Live Toggle Hide (Marchează ca Dezinstalat / Ascuns din Tabel)
app.post('/api/admin/toggle-hide', (req, res) => {
  try {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauthorized' });
    const { id } = req.body;
    const dev = devices[id];
    if (!dev) return res.status(404).json({ error: 'Dispozitiv negăsit' });
    dev.hidden = !dev.hidden;
    saveDevices();
    res.json({ ok: true, hidden: dev.hidden });
  } catch (err) {
    console.error('Eroare toggle-hide:', err);
    res.status(500).json({ error: 'Eroare la ascundere/restaurare' });
  }
});

// Endpoint Live Toggle Uninstalled (Aplicație Ștearsă de pe Telefon)
app.post('/api/admin/toggle-uninstalled', (req, res) => {
  try {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauthorized' });
    const { id } = req.body;
    const dev = devices[id] || (deletedDevices && deletedDevices[id]);
    if (!dev) return res.status(404).json({ error: 'Dispozitiv negăsit' });
    dev.uninstalled = !dev.uninstalled;
    if (dev.uninstalled) {
      dev.deleted = true;
    } else {
      dev.deleted = false;
      if (deletedDevices && deletedDevices[id]) {
        delete deletedDevices[id];
        saveDeletedDevices();
      }
    }
    saveDevices();
    res.json({ ok: true, uninstalled: dev.uninstalled });
  } catch (err) {
    console.error('Eroare toggle-uninstalled:', err);
    res.status(500).json({ error: 'Eroare la comutare status șters' });
  }
});

// Endpoint Live Ștergere Definitivă Dispozitiv (Remove / Delete)
app.post('/api/admin/delete-device', (req, res) => {
  try {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauthorized' });
    const { id } = req.body;
    if (!id || !devices[id]) return res.status(404).json({ error: 'Dispozitiv negăsit' });

    const dev = devices[id];

    // Păstrăm dispozitivul în deletedDevices cu toate datele de expirare salvate!
    deletedDevices[id] = {
      ...dev,
      deleted: true,
      uninstalled: true,
      deletedAt: new Date().toISOString()
    };
    saveDeletedDevices();

    // Marcăm rețeaua și IP-ul ca aparținând unui dispozitiv șters
    if (dev.netKey && ipRegistry[dev.netKey]) {
      ipRegistry[dev.netKey].deleted = true;
      ipRegistry[dev.netKey].deletedDeviceId = id;
      saveIpRegistry();
    }
    if (dev.ip && ipRegistry[dev.ip]) {
      ipRegistry[dev.ip].deleted = true;
      ipRegistry[dev.ip].deletedDeviceId = id;
      saveIpRegistry();
    }

    delete devices[id];
    saveDevices();
    res.json({ ok: true, deleted: true, id });
  } catch (err) {
    console.error('Eroare delete-device:', err);
    res.status(500).json({ error: 'Eroare la ștergerea dispozitivului' });
  }
});

// Endpoint Generare Parolă Unică de Recuperare (Valabilitate 3 minute)
app.post('/api/admin/generate-recovery-code', (req, res) => {
  try {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauthorized' });

    // Generăm un cod aleatoriu din 6 caractere alfanumerice (litere mari și cifre)
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    const now = Date.now();
    const expiresAt = now + (3 * 60 * 1000); // 3 minute

    // Orice parolă anterioară devine imediat nulă!
    currentRecoveryCode = {
      code: code,
      createdAt: now,
      expiresAt: expiresAt,
      used: false
    };

    console.log(`[RECUPERARE] Parolă nouă generată: ${code} (expiră la ${new Date(expiresAt).toLocaleTimeString()})`);

    res.json({
      ok: true,
      code: code,
      ttlSeconds: 180,
      expiresAt: expiresAt,
      deletedCount: Object.keys(deletedDevices).length
    });
  } catch (err) {
    console.error('Eroare generate-recovery-code:', err);
    res.status(500).json({ error: 'Eroare la generarea parolei' });
  }
});

// Endpoint Deblocare Aplicație Telefon prin Parolă Recuperare
app.post('/api/device/unlock-recovery', (req, res) => {
  try {
    const { device_id, code } = req.body;
    const inputCode = String(code || '').trim().toUpperCase();
    const now = Date.now();

    if (!currentRecoveryCode || !currentRecoveryCode.code || currentRecoveryCode.used) {
      return res.status(400).json({ ok: false, error: 'Nu există nicio parolă activă! Solicită una nouă de la administrator.' });
    }

    if (now > currentRecoveryCode.expiresAt) {
      currentRecoveryCode.code = null;
      return res.status(400).json({ ok: false, error: 'Parola a expirat (valabilitate 3 minute)! Solicită o parolă nouă.' });
    }

    if (inputCode !== currentRecoveryCode.code) {
      return res.status(400).json({ ok: false, error: 'Parolă incorectă! Verifică literele și cifrele.' });
    }

    // Parola este corectă -> o marcăm ca folosită imediat (unică folosință!)
    currentRecoveryCode.used = true;
    currentRecoveryCode.code = null;

    const netKey = getNetworkKey(req);
    const clientIp = getClientIp(req);
    const nowDate = new Date();

    // Căutăm dispozitivul în deletedDevices după ID sau după Rețea/IP
    let targetId = device_id;
    let deletedDev = deletedDevices[targetId];

    if (!deletedDev) {
      for (const [dId, dData] of Object.entries(deletedDevices)) {
        if ((netKey && dData.netKey === netKey) || (clientIp && dData.ip === clientIp)) {
          targetId = dId;
          deletedDev = dData;
          break;
        }
      }
    }

    if (deletedDev) {
      // RESTAURĂM DISPOZITIVUL păstrând intacte toate datele salvate (expirări, trial, info)
      devices[targetId] = {
        ...deletedDev,
        id: targetId,
        blocked: false,
        deleted: false,
        hidden: false,
        last_seen: nowDate
      };
      if (typeof devices[targetId].radar_expires === 'string') {
        devices[targetId].radar_expires = new Date(devices[targetId].radar_expires);
      }
      if (typeof devices[targetId].cancel_expires === 'string') {
        devices[targetId].cancel_expires = new Date(devices[targetId].cancel_expires);
      }
      delete deletedDevices[targetId];
      saveDeletedDevices();
    } else {
      if (devices[targetId]) {
        devices[targetId].blocked = false;
        devices[targetId].deleted = false;
      } else {
        devices[targetId] = {
          id: targetId,
          ip: clientIp,
          netKey: netKey,
          info: 'Dispozitiv restaurat',
          radar_expires: new Date(nowDate.getTime() + 24 * 60 * 60 * 1000),
          cancel_expires: new Date(nowDate.getTime() + 12 * 60 * 60 * 1000),
          trial_used: true,
          cancel_trial_used: true,
          blocked: false,
          deleted: false,
          hidden: false,
          last_seen: nowDate
        };
      }
    }

    // Curățăm flag-ul de ștergere și blocare din ipRegistry
    if (netKey && ipRegistry[netKey]) {
      ipRegistry[netKey].deleted = false;
      ipRegistry[netKey].blocked = false;
      if (!ipRegistry[netKey].devices) ipRegistry[netKey].devices = [];
      if (!ipRegistry[netKey].devices.includes(targetId)) ipRegistry[netKey].devices.push(targetId);
    }
    if (clientIp && ipRegistry[clientIp]) {
      ipRegistry[clientIp].deleted = false;
      ipRegistry[clientIp].blocked = false;
      if (!ipRegistry[clientIp].devices) ipRegistry[clientIp].devices = [];
      if (!ipRegistry[clientIp].devices.includes(targetId)) ipRegistry[clientIp].devices.push(targetId);
    }

    saveIpRegistry();
    saveDevices();

    console.log(`[RECUPERARE] Dispozitiv ${targetId} deblocat și restaurat cu succes!`);

    return res.json({
      ok: true,
      restored: true,
      message: 'Dispozitiv deblocat și restaurat cu succes!'
    });
  } catch (err) {
    console.error('Eroare unlock-recovery:', err);
    res.status(500).json({ ok: false, error: 'Eroare internă server la deblocare' });
  }
});

// Endpoint Sincronizare Live Dispozitive & Hartă (Live Polling)
app.get('/api/admin/live-devices', (req, res) => {
  try {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauthorized' });
    const now = new Date();
    const list = Object.values(devices).map(d => {
      let lat = d.lat || null;
      let lon = d.lon || null;
      let loc_source = d.loc_source || (d.lat ? 'gps' : null);

      if (!lat || !lon) {
        let hash = 0;
        const idStr = String(d.id || 'dev');
        for (let i = 0; i < idStr.length; i++) hash = ((hash << 5) - hash) + idStr.charCodeAt(i);
        const offsetLat = ((Math.abs(hash) % 100) - 50) * 0.0006;
        const offsetLon = ((Math.abs(hash >> 3) % 100) - 50) * 0.0008;
        lat = 47.0105 + offsetLat;
        lon = 28.8638 + offsetLon;
        loc_source = 'approx';
      }

      const radarDate = ensureDate(d.radar_expires);
      const cancelDate = ensureDate(d.cancel_expires);
      const lastSeenDate = ensureDate(d.last_seen);

      return {
        id: d.id,
        ip: d.ip || '',
        info: d.info || 'Telefon',
        app_version: d.app_version || '2.6.1',
        uninstalled: !!d.uninstalled,
        lat: Number(lat),
        lon: Number(lon),
        loc_source: loc_source,
        city: d.city || 'Chișinău',
        blocked: !!d.blocked,
        hidden: !!d.hidden,
        radar_active: !d.blocked && (radarDate > now),
        cancel_active: !d.blocked && (cancelDate > now),
        online: ((now.getTime() - lastSeenDate.getTime()) < 12 * 1000) && !d.is_offline,
        last_seen: lastSeenDate.toLocaleString('ro-RO', { timeZone: 'Europe/Chisinau' }),
        radar_exp: formatExactTime(radarDate),
        cancel_exp: formatExactTime(cancelDate),
        last_seen_sec: Math.max(0, Math.round((now.getTime() - lastSeenDate.getTime()) / 1000))
      };
    });
    res.json({ ok: true, now: now.getTime(), devices: list });
  } catch (err) {
    console.error('Eroare live-devices:', err);
    res.status(500).json({ error: 'Eroare la încărcare date live' });
  }
});

// Endpoint Raportare Crash-uri din Aplicație
const CRASH_LOG_FILE = path.join(__dirname, 'app_crashes.json');
let recentCrashes = [];
try {
  if (fs.existsSync(CRASH_LOG_FILE)) {
    recentCrashes = JSON.parse(fs.readFileSync(CRASH_LOG_FILE, 'utf8'));
  }
} catch (e) {}

app.post('/api/crash', (req, res) => {
  const item = {
    received_at: new Date().toISOString(),
    ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
    data: req.body
  };
  console.log('[APP CRASH]:', JSON.stringify(item, null, 2));
  recentCrashes.unshift(item);
  if (recentCrashes.length > 50) recentCrashes = recentCrashes.slice(0, 50);
  try {
    fs.writeFileSync(CRASH_LOG_FILE, JSON.stringify(recentCrashes, null, 2), 'utf8');
  } catch (e) {}
  res.json({ ok: true });
});

app.get('/api/admin/crashes', (req, res) => {
  res.json({ ok: true, count: recentCrashes.length, crashes: recentCrashes });
});

app.listen(PORT, () => {
  console.log(`Serverul SHS rulează pe portul ${PORT}`);
});
