import { test } from 'node:test';
import assert from 'node:assert/strict';
import { b64urlDecode, b64urlEncode, encryptPayload, generateVapidKeys, vapidAuthorization } from '../server/src/webpush.js';

const subtle = globalThis.crypto.subtle;

// RFC 8291, section 5: the worked example of an encrypted push message.
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  output: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

async function importServerKeys() {
  const raw = b64urlDecode(RFC.asPublic);
  const jwk = {
    kty: 'EC', crv: 'P-256', d: RFC.asPrivate,
    x: b64urlEncode(raw.slice(1, 33)), y: b64urlEncode(raw.slice(33, 65)),
  };
  return {
    privateKey: await subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']),
    publicKey: await subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, true, []),
  };
}

test('encryption matches the RFC 8291 example byte for byte', async () => {
  const body = await encryptPayload(
    { keys: { p256dh: RFC.uaPublic, auth: RFC.auth } },
    b64urlDecode(RFC.plaintext),
    { salt: b64urlDecode(RFC.salt), serverKeys: await importServerKeys() },
  );
  assert.equal(b64urlEncode(body), RFC.output);
});

test('VAPID header carries a valid ES256 token for the push service origin', async () => {
  const keys = await generateVapidKeys();
  const auth = await vapidAuthorization('https://web.push.apple.com/QHk1x2', keys, 'https://example.com/app/', Date.UTC(2026, 10, 2));
  const [, token, k] = auth.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, keys.publicKey);
  const [h, c, s] = token.split('.');
  const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(c)));
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.equal(claims.sub, 'https://example.com/app/');
  assert.equal(claims.exp, Date.UTC(2026, 10, 2) / 1000 + 12 * 3600);
  const pub = await subtle.importKey('raw', b64urlDecode(keys.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, b64urlDecode(s), new TextEncoder().encode(`${h}.${c}`));
  assert.ok(ok);
});
