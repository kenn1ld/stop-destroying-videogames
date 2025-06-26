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

export const POST: RequestHandler = async (event) => {
  try {
    const { ts, count } = await event.request.json();
    
    // Validate input
    if (!ts || typeof count !== 'number') {
      return new Response('Invalid data format', { status: 400 });
    }

    let arr: { ts: number; count: number }[] = [];
    
    // Read existing data
    if (fs.existsSync(DB)) {
      try {
        const rawData = fs.readFileSync(DB, 'utf-8');
        arr = JSON.parse(rawData);
      } catch (parseError) {
        console.error('Error parsing existing tick history:', parseError);
        // If file is corrupted, start fresh
        arr = [];
      }
    }
    
    // Add new tick - no limit!
    arr.push({ ts, count });
    
    // Write back to file
    fs.writeFileSync(DB, JSON.stringify(arr), 'utf-8');
    
    return new Response(null, { status: 204 });
    
  } catch (error) {
    console.error('Error saving tick:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
};