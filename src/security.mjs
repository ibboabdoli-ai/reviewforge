import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const randomToken = (bytes=32) => randomBytes(bytes).toString('base64url');
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function signatureHmac(body, secret) { return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex'); }
export function safeCompare(a,b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa=Buffer.from(a), bb=Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa,bb);
}
export function verifyGithub(body, signature, secret) {
  return !!secret && safeCompare(signatureHmac(body, secret), signature);
}
export function verifyStripe(body, header, secret, now=Date.now()) {
  if (!secret || !header) return false;
  const parts=header.split(',').map(v=>v.trim().split('='));
  const t=Number(parts.find(p=>p[0]==='t')?.[1]);
  if (!Number.isSafeInteger(t) || Math.abs(Math.floor(now/1000)-t)>300) return false;
  const expected=createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return parts.filter(p=>p[0]==='v1').some(p=>safeCompare(p[1], expected));
}
export function encrypt(plaintext, secret) {
  if (!secret || secret.length<32) throw new Error('Session encryption key missing');
  const key=createHash('sha256').update(secret).digest(); const iv=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',key,iv);
  const data=Buffer.concat([cipher.update(plaintext,'utf8'),cipher.final()]);
  return [iv,cipher.getAuthTag(),data].map(x=>x.toString('base64url')).join('.');
}
export function decrypt(encoded, secret) {
  const [iv,tag,data]=(encoded||'').split('.').map(x=>Buffer.from(x||'', 'base64url'));
  const key=createHash('sha256').update(secret).digest();
  const cipher=createDecipheriv('aes-256-gcm',key,iv); cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(data),cipher.final()]).toString('utf8');
}
export function cookies(req) {
  return Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim()).filter(Boolean).map(x=>{ const i=x.indexOf('='); return [x.slice(0,i), decodeURIComponent(x.slice(i+1))]; }));
}
export function cookie(name,value, { secure=false, maxAge=86400*14, httpOnly=true }={}) {
  return `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax; Max-Age=${maxAge}${httpOnly?'; HttpOnly':''}${secure?'; Secure':''}`;
}
export function csrfFor(session,secret) { return createHmac('sha256',secret).update('csrf:'+session).digest('hex'); }
export function validOrigin(req,baseUrl) {
  const origin=req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).origin===new URL(baseUrl).origin; } catch { return false; }
}
export function htmlEscape(value='') { return String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
export function jsonForScript(value) { return JSON.stringify(value).replace(/</g,'\\u003c'); }
