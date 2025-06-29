import { Pool } from 'pg';
import type { RequestHandler } from '@sveltejs/kit';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10, // Connection pool size
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000
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

    // Optimized query with better window functions
    const result = await pool.query(`
      SELECT 
        timestamp as ts, 
        count,
        COUNT(*) OVER() as total_count,
        MIN(timestamp) OVER() as oldest_tick,
        MAX(timestamp) OVER() as newest_tick,
        EXTRACT(EPOCH FROM NOW()) as server_time
      FROM signatures 
      WHERE timestamp > $1 
      ORDER BY timestamp ASC
    `, [now - RETENTION_MS]);

    // More efficient data processing
    const ticks = result.rows.map(row => ({ 
      ts: Number(row.ts), // More reliable than parseInt
      count: row.count 
    }));
    
    const metadata = result.rows.length > 0 ? {
      totalTicks: Number(result.rows[0].total_count),
      oldestTick: Number(result.rows[0].oldest_tick),
      newestTick: Number(result.rows[0].newest_tick),
      serverTime: Math.floor(Number(result.rows[0].server_time) * 1000)
    } : {
      totalTicks: 0,
      oldestTick: null,
      newestTick: null,
      serverTime: now
    };

    // More robust ETag generation
    const etag = `"${metadata.totalTicks}-${metadata.newestTick || 0}-${Math.floor(metadata.serverTime / 60000)}"`;
    
    if (clientETag === etag) {
      return new Response(null, { 
        status: 304,
        headers: {
          'ETag': etag,
          'Cache-Control': 'no-cache, must-revalidate'
        }
      });
    }

    const payload = { 
      ticks,
      dailyStats: [], // Keep for compatibility
      metadata: {
        todayStart,
        totalTicks: metadata.totalTicks,
        oldestTick: metadata.oldestTick,
        newestTick: metadata.newestTick,
        retentionHours: 26,
        serverTime: metadata.serverTime
      }
    };
    
    const headers = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, must-revalidate',
      'ETag': etag,
      'Last-Modified': new Date(metadata.serverTime).toUTCString(),
      'X-Tick-Count': metadata.totalTicks.toString(),
      'X-Retention': '26h',
      'X-Server-Time': metadata.serverTime.toString()
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
        retentionHours: 26,
        serverTime: Date.now()
      }
    };
    
    return new Response(JSON.stringify(errorPayload), {
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, must-revalidate'
      },
      status: 500
    });
  }
};