import fs from 'fs';
import path from 'path';
import type { RequestHandler } from '@sveltejs/kit';

// Use Railway's persistent volume with fallback for development
const STORAGE_DIR = process.env.NODE_ENV === 'production' ? '/mnt/storage' : './data';
const DB = path.resolve(STORAGE_DIR, 'tick-history.json');

// Ensure storage directory exists
if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

export const GET: RequestHandler = async () => {
  try {
    let arr: { ts: number; count: number }[] = [];
    
    if (fs.existsSync(DB)) {
      try {
        const rawData = fs.readFileSync(DB, 'utf-8');
        arr = JSON.parse(rawData);
      } catch (parseError) {
        console.error('Error parsing tick history:', parseError);
        // If file is corrupted, return empty array
        arr = [];
      }
    }
    
    return new Response(JSON.stringify(arr), {
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache' // Prevent caching for real-time data
      }
    });
    
  } catch (error) {
    console.error('Error reading tick history:', error);
    return new Response(JSON.stringify([]), {
      headers: { 'Content-Type': 'application/json' },
      status: 500
    });
  }
};