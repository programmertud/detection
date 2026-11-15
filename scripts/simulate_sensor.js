/**
 * ============================================================================
 * FIREGUARD IOT - SENSOR NODE SIMULATOR (ESP32-S3 & FLAME SENSOR TELEMETRY)
 * ============================================================================
 * Usage:
 *   node scripts/simulate_sensor.js [SUPABASE_URL] [SUPABASE_ANON_KEY]
 * 
 * Description:
 *   Simulates the ESP32-S3 and flame sensor node.
 *   Emits telemetry packets every 2000 ms to Supabase REST API,
 *   simulating ambient state, fire ignition, critical flame, and extinguishing.
 * ============================================================================
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. Resolve Supabase credentials
let supabaseUrl = process.argv[2] || process.env.VITE_SUPABASE_URL || '';
let supabaseAnonKey = process.argv[3] || process.env.VITE_SUPABASE_ANON_KEY || '';

if (!supabaseUrl || !supabaseAnonKey) {
  const envPath = path.resolve(__dirname, '../people-detection-web/.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    envContent.split('\n').forEach((line) => {
      const matchUrl = line.match(/^VITE_SUPABASE_URL\s*=\s*(.+)$/);
      if (matchUrl) supabaseUrl = matchUrl[1].trim();

      const matchKey = line.match(/^VITE_SUPABASE_ANON_KEY\s*=\s*(.+)$/);
      if (matchKey) supabaseAnonKey = matchKey[1].trim();
    });
  }
}

console.log('\x1b[31m%s\x1b[0m', '=======================================================');
console.log('\x1b[31m%s\x1b[0m', '  FIREGUARD IOT - SENSOR NODE SIMULATOR                ');
console.log('\x1b[31m%s\x1b[0m', '  ESP32-S3 & Flame Sensor Telemetry Test Generator     ');
console.log('\x1b[31m%s\x1b[0m', '=======================================================');
console.log(`Target URL : ${supabaseUrl || '(Not configured)'}`);
console.log(`Key Excerpt: ${supabaseAnonKey ? supabaseAnonKey.slice(0, 16) + '...' : '(Not configured)'}`);
console.log('\x1b[31m%s\x1b[0m', '=======================================================');

if (!supabaseUrl || !supabaseAnonKey || supabaseUrl.includes('your-project-id')) {
  console.log('\x1b[33m%s\x1b[0m', '\n[SETUP NOTICE] Supabase credentials not found or using placeholders.');
  console.log('1. Open people-detection-web/.env');
  console.log('2. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY');
  console.log('3. Run: npm run simulate\n');
}

// 2. Simulated fire scenario (Flame intensity percentage 0% - 100%)
const SCENARIO_INTENSITIES = [
  0.0, 1.2, 0.5, 2.1,                // Ambient Safe (No flame)
  12.0, 24.5, 38.0,                  // Pre-flame / Heat source
  55.4, 72.0, 88.5, 95.0, 84.0, 65.2, // ACTIVE FIRE ALERT (>= 40%)
  28.0, 15.1, 4.2, 0.0,              // Extinguished / Cool down
  0.0, 82.0, 4.0, 0.0                // Flash flare test
];

let scenarioIndex = 0;
let sampleCounter = 0;
const ALERT_THRESHOLD = 40.0;

async function transmitSimulatedReading() {
  sampleCounter++;
  const intensity = SCENARIO_INTENSITIES[scenarioIndex];
  scenarioIndex = (scenarioIndex + 1) % SCENARIO_INTENSITIES.length;

  const isFire = intensity >= ALERT_THRESHOLD;
  const statusText = isFire ? 'Fire Alert' : (intensity > 20 ? 'Warning' : 'Safe');

  const payload = {
    distance_cm: parseFloat(intensity.toFixed(1)),
    detected: isFire,
    sensor_status: statusText,
  };

  const timestamp = new Date().toLocaleTimeString();

  if (isFire) {
    console.log(
      `\x1b[31m[#${sampleCounter} | ${timestamp}] 🔥 FIRE ALERT! Intensity: ${payload.distance_cm}% | Status: ${statusText}\x1b[0m`
    );
  } else {
    console.log(
      `\x1b[32m[#${sampleCounter} | ${timestamp}] 🛡️ SAFE. Intensity: ${payload.distance_cm}% | Status: ${statusText}\x1b[0m`
    );
  }

  if (supabaseUrl && supabaseAnonKey && !supabaseUrl.includes('your-project-id')) {
    try {
      const endpoint = `${supabaseUrl.replace(/\/+$/, '')}/rest/v1/detection_readings`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: supabaseAnonKey,
          Authorization: `Bearer ${supabaseAnonKey}`,
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        console.log(`   \x1b[90m↳ Uploaded to Supabase (HTTP ${response.status})\x1b[0m`);
      } else {
        const errorText = await response.text();
        console.log(`   \x1b[31m↳ Upload Failed (${response.status}): ${errorText}\x1b[0m`);
      }
    } catch (err) {
      console.log(`   \x1b[31m↳ Network Error: ${err.message}\x1b[0m`);
    }
  }
}

// Execute initial transmission immediately, then every 2 seconds
transmitSimulatedReading();
setInterval(transmitSimulatedReading, 2000);
