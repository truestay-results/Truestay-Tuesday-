// TrueStay Pay — Web Push (morning nudges) with no dependencies.
// Implements VAPID (RFC 8292) and aes128gcm message encryption (RFC 8291) on WebCrypto,
// so it runs on Cloudflare Workers. VAPID keys are generated once and kept in pay_meta.

const enc = new TextEncoder();

export const b64u = {
  enc(buf) {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(str) {
    let s = String(str).replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

// HKDF-SHA256 (extract + expand) in one call
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

// RFC 8291: encrypt `payload` for a browser push subscription {p256dh, auth}.
export async function encryptPayload(sub, payload) {
  const uaPublic = b64u.dec(sub.p256dh);
  const authSecret = b64u.dec(sub.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error("Bad subscription keys");

  const asKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeys.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(payload, new Uint8Array([2]))));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, body);
}

// VAPID keys: created on first use, stored in pay_meta so every request signs with the same key.
export async function vapidKeys(db) {
  const row = await db.prepare("SELECT value FROM pay_meta WHERE key = 'vapid'").first();
  if (row) return JSON.parse(row.value);
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const pub = b64u.enc(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  await db.prepare("INSERT OR IGNORE INTO pay_meta (key, value) VALUES ('vapid', ?)").bind(JSON.stringify({ jwk, pub })).run();
  const again = await db.prepare("SELECT value FROM pay_meta WHERE key = 'vapid'").first();
  return JSON.parse(again.value);
}

export async function vapidHeader(endpoint, keys, subject = "https://truestaytuesday.com") {
  const aud = new URL(endpoint).origin;
  const part = (o) => b64u.enc(enc.encode(JSON.stringify(o)));
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud, exp: Math.floor(Date.now() / 1000) + 3600, sub: subject })}`;
  const { key_ops, ext, ...jwk } = keys.jwk; // import cleanly regardless of exported metadata
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(unsigned)));
  return `vapid t=${unsigned}.${b64u.enc(sig)}, k=${keys.pub}`;
}

// Send one notification. Returns the push service's HTTP status (201 = accepted).
export async function sendPush(db, sub, data) {
  const keys = await vapidKeys(db);
  const body = await encryptPayload(sub, enc.encode(JSON.stringify(data)));
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidHeader(sub.endpoint, keys),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "43200",
      Urgency: "normal",
    },
    body,
  });
  return res.status;
}

// Send to every saved device; tidy up subscriptions the push service says are gone.
export async function pushAll(db, data) {
  const { results } = await db.prepare("SELECT * FROM pay_push_subs").all();
  const now = Math.floor(Date.now() / 1000);
  const out = [];
  for (const s of results) {
    let status = 0;
    try {
      status = await sendPush(db, s, data);
    } catch (e) {
      console.error("push failed", e && e.message);
    }
    out.push(status);
    if (status === 404 || status === 410) await db.prepare("DELETE FROM pay_push_subs WHERE id = ?").bind(s.id).run();
    else if (status >= 200 && status < 300) await db.prepare("UPDATE pay_push_subs SET last_ok = ?, fails = 0 WHERE id = ?").bind(now, s.id).run();
    else await db.prepare("UPDATE pay_push_subs SET fails = fails + 1 WHERE id = ?").bind(s.id).run();
  }
  return out;
}
