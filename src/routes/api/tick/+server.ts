import { Pool } from 'pg';
import type { RequestHandler } from '@sveltejs/kit';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000
});

const RETENTION_MS = 26 * 60 * 60 * 1000;

const requestCounts = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 120;
let lastWrittenData: { ts: number; count: number } | null = null;
let tableEnsured = false;

async function ensureTable() {
  if (tableEnsured) return;
  
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS signatures (
        timestamp BIGINT PRIMARY KEY,
        count INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_signatures_timestamp 
      ON signatures(timestamp)
    `);
    
    tableEnsured = true;
  } catch (error) {
    console.error('Schema setup error:', error);
  }
}

function getRealIP(request: Request): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || request.headers.get('cf-connecting-ip')
    || 'unknown';
}

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const record = requestCounts.get(ip);
  
  if (requestCounts.size > 1000) {
    const cutoff = now - RATE_LIMIT_WINDOW;
    for (const [key, value] of requestCounts.entries()) {
      if (value.resetTime < cutoff) {
        requestCounts.delete(key);
      }
    }
  }
  
  if (!record || now > record.resetTime) {
    requestCounts.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return false;
  }
  
  if (record.count >= MAX_REQUESTS_PER_WINDOW) {
    return true;
  }
  
  record.count++;
  return false;
}

export const POST: RequestHandler = async (event) => {
  await ensureTable();

  try {
    const ip = getRealIP(event.request);
    if (isRateLimited(ip)) {
      return new Response('Rate limit exceeded', {
        status: 429,
        headers: { 'Retry-After': '60' }
      });
    }

    const { ts, count } = await event.request.json();
    
    if (
      typeof ts !== 'number' || typeof count !== 'number' ||
      !Number.isInteger(ts) || !Number.isInteger(count) ||
      ts <= 0 || count < 0 ||
      ts > Date.now() + 60_000 || ts < Date.now() - 86400_000 ||
      count > 10_000_000
    ) {
      return new Response('Invalid data format', { status: 400 });
    }

    // SIMPLIFIED: No more deduplication needed since server controls the data flow
    const result = await pool.query(`
      WITH cleanup AS (
        DELETE FROM signatures 
        WHERE timestamp < $1
        RETURNING 1
      ),
      upsert AS (
        INSERT INTO signatures (timestamp, count) 
        VALUES ($2, $3)
        ON CONFLICT (timestamp) DO UPDATE SET count = $3
        WHERE signatures.count != $3
        RETURNING 1
      )
      SELECT 
        (SELECT COUNT(*) FROM cleanup) as cleaned,
        (SELECT COUNT(*) FROM upsert) as upserted
    `, [Date.now() - RETENTION_MS, ts, count]);

    lastWrittenData = { ts, count };
    
    if (result.rows[0]?.cleaned > 0) {
      console.log(`Cleaned ${result.rows[0].cleaned} old records`);
    }
    
    if (result.rows[0]?.upserted > 0) {
      console.log(`Saved: ${count} signatures at ${new Date(ts).toISOString()}`);
    }
    
    return new Response(null, { status: 204 });
    
  } catch (err) {
    console.error('Database error:', err);
    return new Response('Internal Server Error', { status: 500 });
  }
};