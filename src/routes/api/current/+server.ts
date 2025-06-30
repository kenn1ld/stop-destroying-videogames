// src/routes/api/current/+server.ts
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

let cachedData: any = null;
let lastFetch = 0;
let activeFetch: Promise<any> | null = null;
let lastSavedCount: number | null = null;
const CACHE_DURATION = 5000; // 1 second cache

export const GET: RequestHandler = async () => {
  const now = Date.now();
  
  // Return cached data if fresh
  if (cachedData && (now - lastFetch) < CACHE_DURATION) {
    return new Response(JSON.stringify({
      ...cachedData,
      cached: true,
      age: now - lastFetch
    }), {
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=1'
      }
    });
  }
  
  // Prevent duplicate fetches
  if (activeFetch) {
    const result = await activeFetch;
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // Start new fetch
  activeFetch = fetchAndSave();
  
  try {
    const result = await activeFetch;
    activeFetch = null;
    return new Response(JSON.stringify(result), {
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=1'
      }
    });
  } catch (error) {
    activeFetch = null;
    console.error('EU API fetch error:', error);
    
    // Return stale cache if available
    if (cachedData) {
      return new Response(JSON.stringify({
        ...cachedData,
        error: 'Using cached data'
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    
    throw error;
  }
};

// Update your /api/current/+server.ts - modify the fetchAndSave function:

// 2. ONLY SAVE WHEN COUNT CHANGES (reduces database writes by 95%)
async function fetchAndSave() {
  try {
    console.log('[Server] Fetching from EU APIs...');
    
    const [progRes, infoRes] = await Promise.all([
      fetch('https://eci.ec.europa.eu/045/public/api/report/progression'),
      fetch('https://eci.ec.europa.eu/045/public/api/initiative/description')
    ]);
    
    if (!progRes.ok || !infoRes.ok) {
      throw new Error(`EU API error: ${progRes.status}/${infoRes.status}`);
    }
    
    const prog = await progRes.json();
    const info = await infoRes.json();
    
    const now = Date.now();
    const currentCount = prog.signatureCount;
    
    // ✅ ONLY SAVE WHEN COUNT CHANGES (massive cost reduction)
    if (lastSavedCount !== currentCount) {
      await saveToDatabase(now, currentCount);
      lastSavedCount = currentCount;
      console.log(`[Server] Saved: ${currentCount} signatures (count changed)`);
    } else {
      console.log(`[Server] Skipped save: ${currentCount} signatures (no change)`);
    }
    
    cachedData = {
      progression: { 
        signatureCount: prog.signatureCount, 
        goal: prog.goal 
      },
      initiative: {
        registrationDate: info.initiativeInfo.registrationDate,
        closingDate: info.initiativeInfo.closingDate
      },
      timestamp: now,
      source: 'server'
    };
    
    lastFetch = now;
    return cachedData;
    
  } catch (error) {
    console.error('[Server] Failed to fetch from EU APIs:', error);
    throw error;
  }
}

async function saveToDatabase(ts: number, count: number) {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS signatures (
        timestamp BIGINT PRIMARY KEY,
        count INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    await pool.query(`
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
    
  } catch (error) {
    console.error('[Server] Database save error:', error);
  }
}