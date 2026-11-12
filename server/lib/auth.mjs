// Players, PINs and sessions.
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';

export const AUTH = Object.freeze({
  nameMin: 2, nameMax: 20,
  pinMin: 4, pinMax: 12,
  maxFailures: 5,                       // failed PINs in a row before a lock
  lockMs: 10 * 60 * 1000,               // lock length
  sessionMs: 90 * 24 * 60 * 60 * 1000,  // session lifetime
  scryptKeyLen: 32,
});

const scryptAsync = (pin, salt) => new Promise((res, rej) =>
  scrypt(pin, salt, AUTH.scryptKeyLen, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k))));

export function validateName(raw) {
  const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < AUTH.nameMin || name.length > AUTH.nameMax) return { error: `Name must be ${AUTH.nameMin}–${AUTH.nameMax} characters.` };
  if (!/^[\p{L}\p{N} _.\-']+$/u.test(name)) return { error: 'Name may contain letters, digits, spaces and _ . - \' only.' };
  return { name };
}
export function validatePin(raw) {
  const pin = String(raw ?? '');
  if (!/^\d+$/.test(pin) || pin.length < AUTH.pinMin || pin.length > AUTH.pinMax) return { error: `PIN must be ${AUTH.pinMin}–${AUTH.pinMax} digits.` };
  return { pin };
}

export async function hashPin(pin, salt = randomBytes(16).toString('hex')) {
  const key = await scryptAsync(pin, salt);
  return { salt, hash: key.toString('hex') };
}
export async function checkPin(pin, salt, hash) {
  const key = await scryptAsync(pin, salt);
  const want = Buffer.from(hash, 'hex');
  return want.length === key.length && timingSafeEqual(key, want);
}

export const newId = () => randomBytes(8).toString('hex');
export const newToken = () => randomBytes(32).toString('base64url');
