// Passwords, session tokens and the envelope around provider keys.
import {scrypt, randomBytes, timingSafeEqual} from 'node:crypto';
import type {Env} from './types';

const enc = new TextEncoder(), dec = new TextDecoder();
export const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
export const b64d = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const hex = (u: ArrayBuffer) => [...new Uint8Array(u)].map(b => b.toString(16).padStart(2, '0')).join('');

/* scrypt: memory-hard, unlike PBKDF2, which Workers' WebCrypto also caps at 100,000 iterations.
   N=2^15, r=8, p=3 is an OWASP-listed setting and needs about 32 MB, well inside a Worker's 128 MB. */
const N = 32768, R = 8, P = 3, LEN = 32;
const derive = (pw: string, salt: Uint8Array, n = N, r = R, p = P) => new Promise<Uint8Array>((res, rej) =>
  scrypt(pw.normalize('NFKC'), salt, LEN, {N: n, r, p, maxmem: 96 * 1024 * 1024}, (e, k) => (e ? rej(e) : res(new Uint8Array(k)))));
export async function hashPassword(pw: string): Promise<string> {
  const salt = new Uint8Array(randomBytes(16));
  return `scrypt$${N}$${R}$${P}$${b64(salt)}$${b64(await derive(pw, salt))}`;
}
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, s, h] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const want = b64d(h), got = await derive(pw, b64d(s), +n, +r, +p);
  return want.length === got.length && timingSafeEqual(want, got);
}
/* Run when the address is unknown, so a wrong email costs the same time as a wrong password. */
export const burnPassword = (pw: string) => derive(pw, new Uint8Array(16)).then(() => false);

export function newToken(): string { return b64(new Uint8Array(randomBytes(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
/* compare two secrets without leaking where they differ */
export function sameSecret(a: string, b: string): boolean { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
export async function tokenHash(token: string): Promise<string> { return hex(await crypto.subtle.digest('SHA-256', enc.encode(token))); }
export const newId = (prefix: string) => prefix + '_' + hex(new Uint8Array(randomBytes(12)).buffer as ArrayBuffer);

/* Provider keys: AES-256-GCM under a per-record key, derived with HKDF from a master key that lives
   only in a Worker secret (KEK_<version>). The blob is version | salt(16) | iv(12) | ciphertext.
   The account and user ids are bound in as additional data: a blob copied to another row will not open. */
function kek(env: Env, ver: number): Uint8Array {
  const raw = (env as unknown as Record<string, string | undefined>)['KEK_' + ver];
  if (!raw) throw new Error('KEK_' + ver + ' is not configured');
  const k = b64d(raw); if (k.length !== 32) throw new Error('KEK_' + ver + ' must be 32 bytes, base64');
  return k;
}
async function recordKey(env: Env, ver: number, salt: Uint8Array, aad: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', kek(env, ver), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('apicheck/key/v1|' + aad)}, base, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
}
export async function sealKey(env: Env, plain: string, accountId: string, userId: string): Promise<Uint8Array> {
  const ver = Number(env.KEK_CURRENT || 1), salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12)), aad = accountId + '|' + userId;
  const ct = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData: enc.encode(aad)}, await recordKey(env, ver, salt, aad), enc.encode(plain)));
  const out = new Uint8Array(1 + 16 + 12 + ct.length); out[0] = ver; out.set(salt, 1); out.set(iv, 17); out.set(ct, 29);
  return out;
}
export async function openKey(env: Env, blob: ArrayBuffer | Uint8Array | number[], accountId: string, userId: string): Promise<string> {
  const b = blob instanceof Uint8Array ? blob : new Uint8Array(blob as ArrayBuffer), aad = accountId + '|' + userId;
  const key = await recordKey(env, b[0], b.slice(1, 17), aad);
  return dec.decode(await crypto.subtle.decrypt({name: 'AES-GCM', iv: b.slice(17, 29), additionalData: enc.encode(aad)}, key, b.slice(29)));
}
