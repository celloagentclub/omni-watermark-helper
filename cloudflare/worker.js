const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        return json({ ok: true, service: 'omni-license-worker' });
      }

      if (request.method === 'POST' && url.pathname === '/activate') {
        return activate(request, env);
      }

      if (request.method === 'POST' && url.pathname === '/validate') {
        return validate(request, env);
      }

      if (request.method === 'POST' && url.pathname === '/admin/codes') {
        return createCodes(request, env);
      }

      return json({ error: 'not_found' }, 404);
    } catch (error) {
      return json({ error: 'internal_error', message: error.message }, 500);
    }
  }
};

async function activate(request, env) {
  const body = await readJson(request);
  const code = cleanCode(body.code);
  const machineCode = cleanMachineCode(body.machineCode);
  const appVersion = cleanText(body.appVersion ?? 'unknown');

  if (!code || !machineCode) {
    return json({ error: 'missing_code_or_machine' }, 400);
  }

  const row = await findCode(env, code);
  if (!row) return json({ error: 'invalid_code' }, 404);
  if (row.status !== 'unused' && row.status !== 'active') {
    return json({ error: 'code_disabled' }, 403);
  }
  if (row.machine_code && row.machine_code !== machineCode) {
    return json({ error: 'already_bound' }, 409);
  }

  const now = new Date().toISOString();
  if (!row.machine_code) {
    await env.DB.prepare(`
      UPDATE activation_codes
      SET status = 'active',
          machine_code = ?,
          activated_at = ?,
          last_validated_at = ?
      WHERE id = ?
    `).bind(machineCode, now, now, row.id).run();
    await logEvent(env, row.id, 'activate', machineCode, appVersion);
  } else {
    await touchValidation(env, row.id, machineCode, appVersion);
  }

  const refreshed = await findCode(env, code);
  return licenseResponse(refreshed, env);
}

async function validate(request, env) {
  const body = await readJson(request);
  const code = cleanCode(body.code);
  const machineCode = cleanMachineCode(body.machineCode);
  const appVersion = cleanText(body.appVersion ?? 'unknown');

  if (!code || !machineCode) {
    return json({ error: 'missing_code_or_machine' }, 400);
  }

  const row = await findCode(env, code);
  if (!row) return json({ error: 'invalid_code' }, 404);
  if (row.status !== 'active') return json({ error: 'not_active' }, 403);
  if (row.machine_code !== machineCode) return json({ error: 'machine_mismatch' }, 409);

  await touchValidation(env, row.id, machineCode, appVersion);
  return licenseResponse(row, env);
}

async function createCodes(request, env) {
  if (!isAdminRequest(request, env)) {
    return json({ error: 'unauthorized' }, 401);
  }
  const body = await readJson(request);
  const count = clamp(Number(body.count ?? 1), 1, 500);
  const prefix = cleanPrefix(body.prefix ?? 'OMNI');
  const notes = cleanText(body.notes ?? '');
  const codes = [];

  for (let index = 0; index < count; index += 1) {
    const code = createActivationCode(prefix);
    codes.push(code);
    await env.DB.prepare(`
      INSERT INTO activation_codes (code, notes)
      VALUES (?, ?)
    `).bind(code, notes).run();
  }

  return json({ codes });
}

async function licenseResponse(row, env) {
  const issuedAt = new Date();
  const offlineGraceDays = 36500;
  const offlineUntil = new Date(Date.UTC(2125, 0, 1, 0, 0, 0));
  const nextValidationAt = new Date(issuedAt.getTime() + 24 * 60 * 60 * 1000);
  const license = {
    licenseId: row.id,
    licenseType: row.license_type,
    machineCode: row.machine_code,
    offlineGraceDays,
    issuedAt: issuedAt.toISOString(),
    nextValidationAt: nextValidationAt.toISOString(),
    offlineUntil: offlineUntil.toISOString()
  };
  const signature = await signLicense(license, env);
  return json({ license, signature });
}

async function findCode(env, code) {
  return env.DB.prepare(`
    SELECT id, code, status, machine_code, license_type, offline_grace_days
    FROM activation_codes
    WHERE code = ?
  `).bind(code).first();
}

async function touchValidation(env, codeId, machineCode, appVersion) {
  const now = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE activation_codes
    SET last_validated_at = ?
    WHERE id = ?
  `).bind(now, codeId).run();
  await logEvent(env, codeId, 'validate', machineCode, appVersion);
}

async function logEvent(env, codeId, eventType, machineCode, appVersion) {
  await env.DB.prepare(`
    INSERT INTO activation_events (code_id, event_type, machine_code, app_version)
    VALUES (?, ?, ?, ?)
  `).bind(codeId, eventType, machineCode, appVersion).run();
}

async function signLicense(license, env) {
  if (!env.LICENSE_PRIVATE_JWK) {
    throw new Error('missing LICENSE_PRIVATE_JWK');
  }

  const key = await crypto.subtle.importKey(
    'jwk',
    JSON.parse(env.LICENSE_PRIVATE_JWK),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  const encoded = new TextEncoder().encode(stableStringify(license));
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    encoded
  );
  return base64Url(signature);
}

function isAdminRequest(request, env) {
  const expected = env.ADMIN_TOKEN;
  const received = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  return Boolean(expected && received === expected);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

function createActivationCode(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const raw = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const groups = raw.match(/.{1,4}/g).slice(0, 5).join('-');
  return `${prefix}-${groups}`.toUpperCase();
}

function cleanCode(value) {
  return cleanText(value).replace(/\s+/g, '').toUpperCase();
}

function cleanMachineCode(value) {
  return cleanText(value).slice(0, 128);
}

function cleanText(value) {
  return String(value ?? '').trim();
}

function cleanPrefix(value) {
  return cleanText(value).replace(/[^a-z0-9]/gi, '').slice(0, 12).toUpperCase() || 'OMNI';
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function stableStringify(value) {
  const keys = Object.keys(value).sort();
  return JSON.stringify(Object.fromEntries(keys.map((key) => [key, value[key]])));
}

function base64Url(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
