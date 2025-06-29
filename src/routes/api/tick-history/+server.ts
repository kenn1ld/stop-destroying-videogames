import { Pool } from 'pg';
import type { RequestHandler } from '@sveltejs/kit';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const TZ_OFFSET_MS = 2 * 60 * 60 * 1000;
const RETENTION_MS = 26 * 60 * 60 * 1000;
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

function getLocalStartOfDay(ts: number = Date.now()): number {
  const shifted = new Date(ts + TZ_OFFSET_MS);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - TZ_OFFSET_MS;
}

export const GET: RequestHandler = async (event) => {
  await ensureTable();

  try {
    const now = Date.now();
    const todayStart = getLocalStartOfDay(now);
    const clientETag = event.request.headers.get('if-none-match');

    // Single query to get all data with metadata
    const result = await pool.query(`
      SELECT 
        timestamp as ts, 
        count,
        COUNT(*) OVER() as total_count,
        MIN(timestamp) OVER() as oldest_tick,
        MAX(timestamp) OVER() as newest_tick
      FROM signatures 
      WHERE timestamp > $1 
      ORDER BY timestamp ASC
    `, [now - RETENTION_MS]);

    const ticks = result.rows.map(row => ({ 
      ts: parseInt(row.ts), 
      count: row.count 
    }));
    
    const metadata = result.rows[0] ? {
      totalTicks: parseInt(result.rows[0].total_count),
      oldestTick: parseInt(result.rows[0].oldest_tick),
      newestTick: parseInt(result.rows[0].newest_tick)
    } : {
      totalTicks: 0,
      oldestTick: null,
      newestTick: null
    };

    const etag = `"${metadata.totalTicks}-${metadata.newestTick}"`;
    
    if (clientETag === etag) {
      return new Response(null, { status: 304 });
    }

    const payload = { 
      ticks,
      dailyStats: [], // Keep for compatibility
      metadata: {
        todayStart,
        totalTicks: metadata.totalTicks,
        oldestTick: metadata.oldestTick,
        newestTick: metadata.newestTick,
        retentionHours: 26
      }
    };
    
    const headers = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, must-revalidate',
      'ETag': etag,
      'Last-Modified': new Date(now).toUTCString(),
      'X-Tick-Count': metadata.totalTicks.toString(),
      'X-Retention': '26h'
    };
    
    return new Response(JSON.stringify(payload), { headers });
    
  } catch (error) {
    console.error('Database error:', error);
    
    const errorPayload = { 
      ticks: [], 
      dailyStats: [], 
      metadata: {
        todayStart: getLocalStartOfDay(),
        totalTicks: 0,
        oldestTick: null,
        newestTick: null,
        retentionHours: 26
      }
    };
    
    return new Response(JSON.stringify(errorPayload), {
      headers: { 'Content-Type': 'application/json' },
      status: 500
    });
  }
};