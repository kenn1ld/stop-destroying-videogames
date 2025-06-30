import { Pool } from 'pg';
import type { RequestHandler } from '@sveltejs/kit';
import { gzip } from 'zlib';
import { promisify } from 'util';

const gzipAsync = promisify(gzip);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
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

// Compress tick data by removing redundant information
function compressTicks(ticks: Array<{ts: number, count: number}>): Array<[number, number]> {
  // Return as tuples [relativeTs, count] to save space
  if (ticks.length === 0) return [];
  
  const baseTime = ticks[0].ts;
  return ticks.map(tick => [tick.ts - baseTime, tick.count]);
}

// Sample data to reduce transfer size while maintaining accuracy
function sampleTicks(ticks: Array<{ts: number, count: number}>, maxPoints: number = 500): Array<{ts: number, count: number}> {
  if (ticks.length <= maxPoints) return ticks;
  
  const interval = Math.floor(ticks.length / maxPoints);
  const sampled = [];
  
  // Always include first and last points
  sampled.push(ticks[0]);
  
  // Sample intermediate points
  for (let i = interval; i < ticks.length - 1; i += interval) {
    sampled.push(ticks[i]);
  }
  
  // Always include the last point
  if (ticks.length > 1) {
    sampled.push(ticks[ticks.length - 1]);
  }
  
  return sampled;
}

export const GET: RequestHandler = async (event) => {
  await ensureTable();

  try {
    const url = new URL(event.request.url);
    const since = parseInt(url.searchParams.get('since') || '0');
    const compress = url.searchParams.get('compress') === 'true';
    const sample = parseInt(url.searchParams.get('sample') || '500');
    
    const now = Date.now();
    const todayStart = getLocalStartOfDay(now);
    const clientETag = event.request.headers.get('if-none-match');

    // If client provides 'since' timestamp, only return newer data
    const cutoffTime = since > 0 ? Math.max(since, now - RETENTION_MS) : now - RETENTION_MS;

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
    `, [cutoffTime]);

    let ticks = result.rows.map(row => ({ 
      ts: Number(row.ts),
      count: row.count 
    }));

    // Sample data if requested to reduce size
    if (sample > 0 && ticks.length > sample) {
      ticks = sampleTicks(ticks, sample);
    }
    
    const metadata = result.rows.length > 0 ? {
      totalTicks: Number(result.rows[0].total_count),
      oldestTick: Number(result.rows[0].oldest_tick),
      newestTick: Number(result.rows[0].newest_tick),
      serverTime: Math.floor(Number(result.rows[0].server_time) * 1000),
      baseTime: ticks.length > 0 ? ticks[0].ts : null // For decompression
    } : {
      totalTicks: 0,
      oldestTick: null,
      newestTick: null,
      serverTime: now,
      baseTime: null
    };

    // Create ETag based on newest data and parameters
    const etag = `"${metadata.totalTicks}-${metadata.newestTick || 0}-${Math.floor(metadata.serverTime / 60000)}-${since}-${sample}"`;
    
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
      ticks: compress ? compressTicks(ticks) : ticks,
      compressed: compress,
      incremental: since > 0,
      dailyStats: [],
      metadata: {
        todayStart,
        totalTicks: metadata.totalTicks,
        oldestTick: metadata.oldestTick,
        newestTick: metadata.newestTick,
        retentionHours: 26,
        serverTime: metadata.serverTime,
        baseTime: metadata.baseTime,
        sampled: ticks.length !== result.rows.length,
        originalCount: result.rows.length
      }
    };
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, must-revalidate',
      'ETag': etag,
      'Last-Modified': new Date(metadata.serverTime).toUTCString(),
      'X-Tick-Count': metadata.totalTicks.toString(),
      'X-Retention': '26h',
      'X-Server-Time': metadata.serverTime.toString()
    };

    let responseBody = JSON.stringify(payload);

    // Enable gzip compression if client supports it
    const acceptEncoding = event.request.headers.get('accept-encoding') || '';
    if (acceptEncoding.includes('gzip')) {
      const compressed = await gzipAsync(responseBody);
      headers['Content-Encoding'] = 'gzip';
      headers['Content-Length'] = compressed.length.toString();
      return new Response(compressed, { headers });
    }
    
    return new Response(responseBody, { headers });
    
  } catch (error) {
    console.error('Database error:', error);
    
    const errorPayload = { 
      ticks: [], 
      compressed: false,
      incremental: false,
      dailyStats: [], 
      metadata: {
        todayStart: getLocalStartOfDay(),
        totalTicks: 0,
        oldestTick: null,
        newestTick: null,
        retentionHours: 26,
        serverTime: Date.now(),
        baseTime: null,
        sampled: false,
        originalCount: 0
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