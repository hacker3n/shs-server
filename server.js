// server.js – actualizat pentru butoane rapide și vizualizare data scurtă
process.env.TZ = 'Europe/Chisinau';
const express = require('express');
const path = require('path');
const persist = require('./persist'); // Persistență în Neon (PostgreSQL)

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', true);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// -------------------------------------------------
// Config admin și parole
// -------------------------------------------------
let adminPassword = process.env.ADMIN_PASSWORD || 'shs2026';

// -------------------------------------------------
// Persistență IP‑registry (anti‑abuz) – în DB
// -------------------------------------------------
const IP_FILE = path.join(__dirname, 'ip_registry.json');
let ipRegistry = {};
function loadIpRegistry() {
  try { const data = persist.get('ip_registry', IP_FILE); if (data) { Object.values(data).forEach(v=>{ if(v.radar_expires) v.radar_expires = new Date(v.radar_expires); if(v.cancel_expires) v.cancel_expires = new Date(v.cancel_expires);}); return data; } } catch(e){ console.error('IP load err',e.message); }
  return {};
}
function saveIpRegistry(){ try{ persist.save('ip_registry', ipRegistry, IP_FILE); }catch(e){ console.error('IP save err',e.message); } }
ipRegistry = loadIpRegistry();

// -------------------------------------------------
// Dispozitive – persistență în DB
// -------------------------------------------------
const DB_FILE = path.join(__dirname, 'devices.json');
let devices = {};
function loadDevices(){ try{ const data = persist.get('devices', DB_FILE); if(data){ Object.values(data).forEach(v=>{ v.radar_expires = new Date(v.radar_expires); v.cancel_expires = new Date(v.cancel_expires); v.last_seen = new Date(v.last_seen||Date.now()); v.hidden = !!v.hidden; }); return data; } }catch(e){ console.error('devices load err',e.message);} return {}; }
function saveDevices(){ try{ persist.save('devices', devices, DB_FILE); }catch(e){ console.error('devices save err',e.message);} }
devices = loadDevices();

// -------------------------------------------------
// Dispozitive șterse – păstrare istoric
// -------------------------------------------------
const DELETED_DB_FILE = path.join(__dirname, 'deleted_devices.json');
let deletedDevices = {};
function loadDeletedDevices(){ try{ const data = persist.get('deleted_devices', DELETED_DB_FILE); if(data){ Object.values(data).forEach(v=>{ v.radar_expires = new Date(v.radar_expires); v.cancel_expires = new Date(v.cancel_expires); v.deleted = true; }); return data; } }catch(e){ console.error('deleted load err',e.message);} return {}; }
function saveDeletedDevices(){ try{ persist.save('deleted_devices', deletedDevices, DELETED_DB_FILE); }catch(e){ console.error('deleted save err',e.message);} }
deletedDevices = loadDeletedDevices();

// -------------------------------------------------
// Recuperare unică – 3 minute TTL
// -------------------------------------------------
let currentRecoveryCode = { code:null, createdAt:0, expiresAt:0, used:false };

// -------------------------------------------------
// Helper – IP, rețea, telefon etc.
// -------------------------------------------------
function getClientIp(req){ if(!req) return ''; let ip=''; if(req.headers){ const fwd=req.headers['cf-connecting-ip']||req.headers['x-real-ip']||req.headers['x-forwarded-for']; if(fwd) ip=fwd.split(',')[0].trim(); } if(!ip){ ip = (req.socket && req.socket.remoteAddress)||req.ip||''; } if(ip.startsWith('::ffff:')) ip = ip.substring(7); if(ip.includes('.') && ip.includes(':')) ip = ip.split(':')[0].trim(); return ip.trim(); }
function getNetworkKey(req){ const ip=getClientIp(req); if(!ip||ip==='127.0.0.1'||ip==='::1') return null; if(ip.includes(':')){ const parts=ip.split(':').filter(p=>p.length>0); if(parts.length>=3) return parts.slice(0,Math.min(parts.length,4)).join(':')+'::/64'; return ip; } return ip; }
function normalizePhone(raw){ if(!raw) return ''; let d=raw.replace(/\D/g,''); if(d.startsWith('00')) d=d.slice(2); if(d.length===9 && d.startsWith('0')) d=d.slice(1); if(d.length===8) return '+373'+d; if(d.startsWith('373') && d.length===11) return '+'+d; if(raw.startsWith('+')) return '+'+d; return '+'+d; }

// -------------------------------------------------
// Config – încărcare din DB / env
// -------------------------------------------------
const CONFIG_FILE = path.join(__dirname,'config.json');
let appConfig = {
  admin_password: 'shs2026',
  latest_version_code:1,
  latest_version_name:'1.0',
  min_version_code:1,
  update_url:'https://shs-server.onrender.com/download/SHS_Final.apk',
  update_notes:'Versiune 1.0 – interfață compactă, butoane rapide.',
  shared_geocoder:true,
  telegram:'neki002',
  phone:'', mia_phone:'', mia_name:'', group_url:'https://t.me/neki002',
  announcement_id:1, announcement_text:''
};
function loadConfig(){ try{ const data = persist.get('config', CONFIG_FILE); if(data) Object.assign(appConfig, data); }catch(e){ console.error('config load err',e.message);} if(process.env.ADMIN_PASSWORD) appConfig.admin_password=process.env.ADMIN_PASSWORD.trim(); if(appConfig.admin_password) adminPassword=appConfig.admin_password; }
function saveConfig(){ try{ persist.save('config', appConfig, CONFIG_FILE); }catch(e){ console.error('config save err',e.message);} }
loadConfig();

// -------------------------------------------------
// Autentificare – token cookie / header / query
// -------------------------------------------------
function getCookie(req,name){ const m=(req.headers&&req.headers.cookie?req.headers.cookie:'').match(new RegExp('(?:^|; )'+name.replace(/([\\.$?*|{}\\[\\]\\\\\\/\\+^])/g,'\\$1')+'=([^;]*)')); return m?decodeURIComponent(m[1]):undefined; }
function getExpectedToken(){ return Buffer.from('shs_auth_'+adminPassword).toString('base64'); }
function isAuthenticated(req){ const expected=getExpectedToken(); const token=getCookie(req,'shs_admin_session'); if(token&&token===expected) return true; if(req&&req.headers){ if(req.headers['x-admin-token']===expected) return true; if(req.headers['authorization']==='Bearer '+expected) return true; } if(req&&req.query){ if(req.query.auth===expected||req.query.token===expected) return true; } return false; }

// -------------------------------------------------
// Funcție centrală – obține / creează dispozitiv
// -------------------------------------------------
function getOrCreateDevice(deviceId, deviceInfo='', req=null){ if(!deviceId) deviceId='unknown'; const clientIp=getClientIp(req); const netKey=getNetworkKey(req); const now=new Date(); const ipRec=(netKey&&ipRegistry[netKey])||(clientIp&&ipRegistry[clientIp])||null; const ipUsedTrial=!!(ipRec&& (ipRec.trial_used|| (ipRec.devices&&ipRec.devices.length>0)) ); const isDeleted = deletedDevices[deviceId] && deletedDevices[deviceId].deleted;
  if(isDeleted){ const del=deletedDevices[deviceId]||{id:deviceId,ip:clientIp,netKey:netKey,info:deviceInfo||'Telefon șters',radar_expires:now,cancel_expires:now,trial_used:true,cancel_trial_used:true,blocked:false,deleted:true,last_seen:now}; del.last_seen=now; if(clientIp) del.ip=clientIp; if(netKey) del.netKey=netKey; deletedDevices[deviceId]=del; saveDeletedDevices(); return del; }
  if(!devices[deviceId]){ // dispozitiv nou
    let radarExpires, cancelExpires;
    if(ipUsedTrial){ radarExpires=new Date(now.getTime()); cancelExpires=new Date(now.getTime()); }
    else{ radarExpires=new Date(now.getTime()+24*60*60*1000); // 1 zi trial radar
          cancelExpires=new Date(now.getTime()+12*60*60*1000); // 12h trial cancel
          if(netKey){ ipRegistry[netKey]={trial_used:true,devices:[deviceId]}; saveIpRegistry(); }
          if(clientIp && clientIp!==netKey){ ipRegistry[clientIp]={trial_used:true,devices:[deviceId]}; saveIpRegistry(); }
    }
    devices[deviceId]={id:deviceId,ip:clientIp,netKey:netKey,info:deviceInfo||'Telefon nou',radar_expires, cancel_expires:cancelExpires, trial_used:true, cancel_trial_used:true, blocked:false, hidden:false, last_seen:now};
    saveDevices();
  } else { // existent
    const dev=devices[deviceId]; dev.last_seen=now; if(dev.hidden) dev.hidden=false; if(clientIp) dev.ip=clientIp; if(netKey) dev.netKey=netKey; if(deviceInfo && (!dev.info||dev.info==='Telefon nou')) dev.info=deviceInfo; if(!(dev.radar_expires instanceof Date)) dev.radar_expires=new Date(dev.radar_expires||now); if(!(dev.cancel_expires instanceof Date)) dev.cancel_expires=new Date(dev.cancel_expires||now);
  }
  const dev=devices[deviceId]; // actual
  if(req&&req.body){ const lat=parseFloat(req.body.lat)||0; const lon=parseFloat(req.body.lon)||0; if(lat!==0&&lon!==0){ dev.lat=lat; dev.lon=lon; dev.loc_source='gps'; saveDevices(); } }
  if((!dev.lat||!dev.lon||dev.loc_source==='ip') && clientIp){ resolveIpLocation(clientIp).then(geo=>{ if(geo && (!dev.lat||dev.loc_source==='ip')){ dev.lat=geo.lat; dev.lon=geo.lon; dev.city=geo.city||''; dev.loc_source='ip'; saveDevices(); } }).catch(()=>{}); }
  return dev; }

function applyExpiration(dev, type, newRadar, newCancel){ if(newRadar){ dev.radar_expires=newRadar; dev.trial_used=true; } if(newCancel){ dev.cancel_expires=newCancel; dev.cancel_trial_used=true; } saveDevices(); }

// -------------------------------------------------
// Helper – format timp și dată scurtă
// -------------------------------------------------
function formatExactTime(d){ if(!d) return '-'; const date=new Date(d); if(isNaN(date.getTime())) return '-'; return date.toLocaleString('ro-RO',{timeZone:'Europe/Chisinau',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).replace(',',' la'); }
function toDatetimeLocal(d){ if(!d) return ''; const date=new Date(d); if(isNaN(date.getTime())) return ''; try{ const f=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Chisinau',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}); return f.format(date).replace(' ','T'); }catch(e){ const pad=n=>String(n).padStart(2,'0'); return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`; } }
function formatShortDate(d){ if(!d) return '-'; const date=new Date(d); if(isNaN(date.getTime())) return '-'; const pad=n=>String(n).padStart(2,'0'); return `${pad(date.getDate())}.${pad(date.getMonth()+1)}.${date.getFullYear()}`; }

// -------------------------------------------------
// API – aplicație Android (public)
// -------------------------------------------------
app.get('/api/app-config', (req,res)=>{ const resp={...appConfig, apk_url:appConfig.update_url, announcement: appConfig.announcement_text?{id:appConfig.announcement_id||1,text:appConfig.announcement_text,below_version:999999}:null}; res.json(resp); });

// Download APK
app.get(['/download/SHS_Final.apk','/SHS_Final.apk'], (req,res)=>{ const apkPath=path.join(__dirname,'SHS_Final.apk'); if(require('fs').existsSync(apkPath)) return res.download(apkPath,'SHS_Final.apk'); res.status(404).send('APK nu a fost găsit.'); });

// Check license – radar + cancel
app.post('/api/check-license', (req,res)=>{ const deviceId=req.body.device_id; const dev=getOrCreateDevice(deviceId, req.body.device_info, req); const now=new Date(); if(dev.deleted){ return res.json({ok:true,valid:false,is_activated:false,blocked:false,deleted:true,expires:toIso3(dev.radar_expires),cancel_active:false,cancel_expires_ms:dev.cancel_expires.getTime(),cancel_expires:toIso3(dev.cancel_expires),message:"DISPOZITIV_STERS",ts:Date.now()}); }
 const radarActive=!dev.blocked && (dev.radar_expires>now); const cancelActive=!dev.blocked && (dev.cancel_expires>now);
 const lat=parseFloat(req.body.lat)||0; const lon=parseFloat(req.body.lon)||0; if(lat!==0&&lon!==0){ dev.lat=lat; dev.lon=lon; }
 dev.uninstalled=false; dev.is_offline=false; dev.last_seen=now; saveDevices();
 let announcement=null; if(appConfig.announcement_text){ const target=appConfig.announcement_target||'all'; const targetDevices=Array.isArray(appConfig.announcement_devices)?appConfig.announcement_devices:[]; if(target==='all'||targetDevices.includes(deviceId)) announcement={id:appConfig.announcement_id||1,text:appConfig.announcement_text,below_version:999999}; }
 res.json({ok:true,valid:radarActive,is_activated:radarActive,blocked:!!dev.blocked,expires:toIso3(dev.radar_expires),cancel_active:cancelActive,cancel_expires_ms:dev.cancel_expires.getTime(),cancel_expires:toIso3(dev.cancel_expires),message:dev.blocked?"Ești blocat! Contactează admin" :"OK",announcement,ts:Date.now()}); });

// Trial radar – butoane rapid 1/2/3 luni
app.post('/api/request-trial', (req,res)=>{ const deviceId=req.body.device_id; const dev=getOrCreateDevice(deviceId, req.body.device_info, req); const netKey=getNetworkKey(req); const clientIp=getClientIp(req); const now=new Date(); const ipRec=(netKey&&ipRegistry[netKey])||(clientIp&&ipRegistry[clientIp]); const ipHasTrial=ipRec && ipRec.trial_used; if(dev.trial_used||ipHasTrial){ return res.json({ok:false,valid:!dev.blocked && (dev.radar_expires>now),is_activated:!dev.blocked && (dev.radar_expires>now),blocked:!!dev.blocked,expires:toIso3(dev.radar_expires),message:dev.blocked?"Ești blocat!":"Perioada trial deja consumată",ts:Date.now()}); }
 // acordăm 30 zile radar (rapid) – anulăm trial pe IP
 dev.radar_expires = new Date(now.getTime()+30*24*60*60*1000);
 dev.trial_used = true;
 saveDevices();
 if(netKey){ ipRegistry[netKey]=Object.assign(ipRegistry[netKey]||{},{trial_used:true,devices:[dev.id]}); saveIpRegistry(); }
 res.json({ok:true,valid:true,is_activated:true,blocked:false,expires:toIso3(dev.radar_expires),message:"Trial activat 30 zile (buton rapid)",ts:Date.now()}); });

// Cancel trial – butoane rapid 1/7/31 zile
app.post('/api/cancel/trial', (req,res)=>{ const deviceId=req.body.device_id; const dev=getOrCreateDevice(deviceId,'',req); const netKey=getNetworkKey(req); const clientIp=getClientIp(req); const now=new Date(); const ipRec=(netKey&&ipRegistry[netKey])||(clientIp&&ipRegistry[clientIp]); const ipHasCancelTrial=ipRec && ipRec.cancel_trial_used; if(dev.cancel_trial_used||ipHasCancelTrial){ const active=!dev.blocked && (dev.cancel_expires>now); const hrs=Math.max(0,Math.ceil((dev.cancel_expires.getTime()-now.getTime())/3600000)); return res.json({ok:false,valid:active,active,hours_left:hrs,trial_available:false,banned:!!dev.blocked,expires:toIso3(dev.cancel_expires),message:"Trial cancel deja folosit",ts:Date.now()}); }
 const newCancel = new Date(now.getTime()+12*60*60*1000); // 12h default
 applyExpiration(dev,'cancel',null,newCancel);
 if(netKey){ ipRegistry[netKey]=Object.assign(ipRegistry[netKey]||{},{cancel_trial_used:true,devices:[dev.id]}); saveIpRegistry(); }
 res.json({ok:true,valid:true,active:true,hours_left:12,trial_available:false,banned:!!dev.blocked,expires:toIso3(dev.cancel_expires),message:"Trial cancel activat 12h",ts:Date.now()}); });

// Admin – login page (simplificat)
function renderLogin(error=''){
  return `<!DOCTYPE html><html lang="ro"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Login – SHS</title><style>body{font-family:Arial,sans-serif;background:#0b0f19;color:#f1f5f9;display:flex;align-items:center;justify-content:center;height:100vh} .card{background:#111827;padding:30px;border-radius:12px;box-shadow:0 8px 20px rgba(0,0,0,.4);width:320px} input{width:100%;padding:10px;margin:8px 0;border:1px solid #334155;border-radius:6px;background:#0b0f19;color:#fff} button{width:100%;padding:12px;background:#0284c7;color:#fff;border:none;border-radius:6px;cursor:pointer} .error{color:#ef4444;margin-bottom:10px}</style></head><body><div class="card"><h2>SHS – Admin</h2>${error?`<div class="error">${error}</div>`:''}<form method="POST" action="/admin/login"><input type="password" name="password" placeholder="Parolă" required><button type="submit">Login</button></form></div></body></html>`; }
app.get('/',(req,res)=>{ if(!isAuthenticated(req)) return res.send(renderLogin()); // dashboard HTML este prea lung – redirecționează la /admin/dashboard
 res.redirect('/admin/dashboard'); });
app.get('/admin/login',(req,res)=>{ res.send(renderLogin()); });
app.post('/admin/login',(req,res)=>{ const {password,remember}=req.body; if(password===adminPassword){ const maxAge=remember==='yes'?365*24*60*60:30*24*60*60; res.setHeader('Set-Cookie',`shs_admin_session=${getExpectedToken()}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax; Secure`); return res.redirect('/admin/dashboard'); } res.send(renderLogin('Parolă incorectă!')); });
app.get('/admin/logout',(req,res)=>{ res.setHeader('Set-Cookie','shs_admin_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure'); res.redirect('/'); });

// Dashboard – interfață compactă, responsive
app.get('/admin/dashboard',(req,res)=>{ if(!isAuthenticated(req)) return res.redirect('/admin/login'); const now=new Date(); const rows=Object.values(devices).map(dev=>{ const radarDays=Math.max(0,Math.ceil((dev.radar_expires.getTime()-now.getTime())/(1000*60*60*24))); const cancelHours=Math.max(0,Math.ceil((dev.cancel_expires.getTime()-now.getTime())/(1000*60*60))); const radarBadge=radarDays>0?`● ${radarDays}z`:'○ Expirat'; const cancelBadge=cancelHours>0?`● ${cancelHours}h`:'○ Inactiv'; const online=(now.getTime()-dev.last_seen.getTime()<12*1000)&&!dev.is_offline; return `<tr data-id="${dev.id}"><td>${dev.id}</td><td>${dev.info||'Telefon'}</td><td><span class="badge ${radarDays>0?'badge-green':'badge-red'}">${radarBadge}</span></td><td><span class="badge ${cancelHours>0?'badge-cyan':'badge-red'}">${cancelBadge}</span></td><td>${online?'<span style="color:#4ade80;">Online</span>':'<span style="color:#94a3b8;">Offline</span>'}</td><td><button onclick="quickAdd('${dev.id}','radar',30)">+30z</button> <button onclick="quickAdd('${dev.id}','cancel',7)">+7h</button></td></tr>`; }).join('');
 res.send(`<!DOCTYPE html><html lang="ro"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dashboard SHS</title><style>body{font-family:Arial,sans-serif;background:#0b0f19;color:#f1f5f9;margin:0;padding:20px} table{width:100%;border-collapse:collapse} th,td{padding:8px;border-bottom:1px solid #1f2937;text-align:left} .badge{padding:4px 8px;border-radius:6px;font-size:12px} .badge-green{background:#10b981;color:#fff} .badge-cyan{background:#06b6d4;color:#fff} .badge-red{background:#ef4444;color:#fff}</style></head><body><h1>Dashboard – SHS</h1><table><thead><tr><th>ID</th><th>Info</th><th>Radar</th><th>Cancel</th><th>Status</th><th>Acțiuni</th></tr></thead><tbody>${rows}</tbody></table><script>function quickAdd(id,type,days){fetch('/api/admin/quick-add',{method:'POST',headers:{'Content-Type':'application/json','X-Admin-Token':window.adminToken},body:JSON.stringify({id,type,addDays:days})}).then(()=>location.reload());}</script></body></html>`); });

// Admin API – quick‑add (zile pentru radar / ore pentru cancel)
app.post('/api/admin/quick-add',(req,res)=>{ if(!isAuthenticated(req)) return res.status(401).json({error:'unauthorized'}); const {id,type,addDays,addHours}=req.body; const dev=devices[id]; if(!dev) return res.status(404).json({error:'device not found'}); const now=new Date(); let newRadar=null,newCancel=null; if(type==='radar' || type==='both'){ const base=dev.radar_expires>now?dev.radar_expires.getTime():now.getTime(); newRadar=new Date(base+(addDays||0)*24*60*60*1000); } if(type==='cancel' || type==='both'){ const base=dev.cancel_expires>now?dev.cancel_expires.getTime():now.getTime(); newCancel=new Date(base+(addHours||0)*60*60*1000); } applyExpiration(dev,type,newRadar,newCancel); res.json({ok:true}); });

// Start server
app.listen(PORT,()=>{ console.log(`Server SHS pornit pe portul ${PORT}`); });