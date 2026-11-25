require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const MASTER_SECRET = process.env.MASTER_SECRET || crypto.randomBytes(32).toString('hex');
const ALLOWED_EXECUTOR = process.env.ALLOWED_EXECUTOR || 'YourExecutorName';

// In-memory store (replace with Redis/DB in production)
const scripts = new Map();

// ---------- Middleware ----------
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '../public')));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests' }
});
app.use('/api/', limiter);

// ---------- Crypto helpers ----------
function encrypt(text, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decrypt(payloadB64, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  const data = Buffer.from(payloadB64, 'base64');
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

// ---------- Generate loader ----------
function generateLoader(id, key) {
  return `-- [[ VELUM Protected Loader ]]
-- Do not share this file or the key
local SCRIPT_ID  = "${id}"
local SCRIPT_KEY = "${key}"
local API_BASE   = "http://localhost:${PORT}/api"  -- change to your domain in production

local HttpService = game:GetService("HttpService")

local function getExecutorName()
    local ok, name = pcall(function()
        return identifyexecutor and identifyexecutor() or "Unknown"
    end)
    return ok and name or "Unknown"
end

if getExecutorName() ~= "${ALLOWED_EXECUTOR}" then
    return warn("[VELUM] Unauthorized executor detected")
end

local url = API_BASE .. "/load/" .. SCRIPT_ID
local ok, response = pcall(function()
    return HttpService:GetAsync(url, true, {
        ["X-Executor"]   = "${ALLOWED_EXECUTOR}",
        ["X-Script-Key"] = SCRIPT_KEY
    })
end)

if not ok then
    return warn("[VELUM] Failed to contact protection server")
end

local success, payload = pcall(function()
    return HttpService:JSONDecode(response)
end)

if not success or not payload or not payload.data then
    return warn("[VELUM] Invalid or forbidden response from server")
end

local fn, err = loadstring(payload.data)
if not fn then
    return warn("[VELUM] Load error:", err)
end

fn()
`;
}

// ---------- Routes ----------

// Health
app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    scripts: scripts.size,
    allowedExecutor: ALLOWED_EXECUTOR
  });
});

// Register a new protected script
app.post('/api/register', (req, res) => {
  const { name, source, expiresInHours = 720 } = req.body; // default 30 days

  if (!source || typeof source !== 'string' || source.trim().length < 5) {
    return res.status(400).json({ error: 'Valid source is required' });
  }

  const id = uuidv4().replace(/-/g, '').slice(0, 16);
  const key = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + Number(expiresInHours) * 3600 * 1000;

  scripts.set(id, {
    name: name || 'unnamed',
    encrypted: encrypt(source, key),
    key,
    expires,
    created: Date.now(),
    hits: 0
  });

  const loader = generateLoader(id, key);

  res.json({
    id,
    key,
    name: name || 'unnamed',
    expires: new Date(expires).toISOString(),
    loader
  });
});

// Load protected script (only succeeds with correct headers)
app.get('/api/load/:id', (req, res) => {
  const script = scripts.get(req.params.id);

  if (!script) {
    return res.status(404).json({ error: 'Script not found' });
  }

  if (Date.now() > script.expires) {
    scripts.delete(req.params.id);
    return res.status(410).json({ error: 'Script expired' });
  }

  const executor = req.headers['x-executor'];
  const providedKey = req.headers['x-script-key'];

  if (executor !== ALLOWED_EXECUTOR || providedKey !== script.key) {
    // Never leak real content
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const source = decrypt(script.encrypted, script.key);
    script.hits += 1;
    res.json({ data: source });
  } catch (err) {
    console.error('Decrypt error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// List scripts (simple admin view – protect this in production)
app.get('/api/scripts', (req, res) => {
  const list = [];
  for (const [id, s] of scripts.entries()) {
    list.push({
      id,
      name: s.name,
      created: new Date(s.created).toISOString(),
      expires: new Date(s.expires).toISOString(),
      hits: s.hits,
      expired: Date.now() > s.expires
    });
  }
  res.json(list);
});

// Delete a script
app.delete('/api/scripts/:id', (req, res) => {
  if (scripts.delete(req.params.id)) {
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// Catch-all for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`\n  VELUM Protector running on http://localhost:${PORT}`);
  console.log(`  Allowed executor : ${ALLOWED_EXECUTOR}`);
  console.log(`  Master secret    : ${MASTER_SECRET.slice(0, 8)}...\n`);
});
