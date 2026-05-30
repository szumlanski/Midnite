const crypto = require('crypto-js');

const MIDNITE_API = 'https://appsrv.midniteelectric.com';

function sign(data) {
  const KEY = crypto.enc.Utf8.parse('05469137076236813460585715952089');
  const IV = crypto.enc.Utf8.parse('5161557162012237');
  const json = JSON.stringify(data);
  const cipher = crypto.AES.encrypt(json, KEY, { iv: IV, mode: crypto.mode.CBC, padding: crypto.pad.Pkcs7 });
  return crypto.enc.Base64.stringify(cipher.ciphertext);
}

async function login() {
  const res = await fetch(`${MIDNITE_API}/api/common/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: '1',
      memberID: process.env.MIDNITE_USERNAME || 'FLOSOL2',
      password: process.env.MIDNITE_PASSWORD || '921551',
      remember: false
    })
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status}`);
  const data = await res.json();
  if (!data.sessionID) throw new Error('No sessionID in response');
  return { sessionID: data.sessionID, groupID: data.groupID };
}

async function midniteAPI(endpoint, sessionID, method = 'GET', body = null) {
  const opts = {
    method,
    headers: { sessionID, 'Content-Type': 'application/x-www-form-urlencoded' }
  };
  if (body) opts.body = body;
  
  const res = await fetch(`${MIDNITE_API}${endpoint}`, opts);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;
  try {
    switch (action) {
      case 'login': {
        const auth = await login();
        return res.json({ ok: true, sessionID: auth.sessionID, groupID: auth.groupID });
      }
      case 'overview': {
        const auth = await login();
        const data = await midniteAPI('/api/web/system/overview', auth.sessionID);
        return res.json(data);
      }
      case 'day': {
        const auth = await login();
        const body = `gid=${auth.groupID}&mtypes=pvArray;loads;grid;battery`;
        const data = await midniteAPI('/api/web/system/dayProductionAndConsumptionAreaTime', auth.sessionID, 'POST', body);
        return res.json(data);
      }
      case 'month': {
        const auth = await login();
        const { date } = req.body || {};
        if (!date) return res.status(400).json({ error: 'date required' });
        const body = `gid=${auth.groupID}&date=${date}&mtypes=pvArray;loads;grid;battery`;
        const data = await midniteAPI('/api/web/system/monthProductionAndConsumptionArea', auth.sessionID, 'POST', body);
        return res.json(data);
      }
      case 'year': {
        const auth = await login();
        const body = `gid=${auth.groupID}&mtypes=pvArray;loads;grid;battery`;
        const data = await midniteAPI('/api/web/system/yearProductionAndConsumptionArea', auth.sessionID, 'POST', body);
        return res.json(data);
      }
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error('[midnite proxy]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
