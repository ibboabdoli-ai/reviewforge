// Vercel Functions do not guarantee req.socket is present.
// On Vercel, x-vercel-forwarded-for comes from Vercel's edge and is not
// the client-supplied X-Forwarded-For header.
export function clientKey(req) {
  const vercelHeader = process.env.VERCEL ? req?.headers?.['x-vercel-forwarded-for'] : undefined;
  const forwarded = typeof vercelHeader === 'string' ? vercelHeader.split(',')[0].trim() : '';
  return forwarded || req?.socket?.remoteAddress || 'unknown';
}
export function createLimiter({ now = Date.now } = {}) {
  const counts = new Map();
  return (req, key, max = 20) => {
    const id = clientKey(req) + ':' + key;
    const current = now();
    let item = counts.get(id);
    if (!item || current - item.start > 600000) item = { start: current, count: 0 };
    item.count++;
    counts.set(id, item);
    return item.count > max;
  };
}
