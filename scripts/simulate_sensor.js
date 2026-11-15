/**
 * ============================================================================
 * LOCAL SENSOR NODE SIMULATOR (ESP32-S3 & HC-SR04 MOCK TELEMETRY)
 * ============================================================================
 * Usage:
 *   node scripts/simulate_sensor.js [SUPABASE_URL] [SUPABASE_ANON_KEY]
 * 
 * Description:
 *   Simulates the physical ESP32-S3 and HC-SR04 ultrasonic sensor node.
 *   Emits telemetry packets every 2000 ms to the Supabase REST API,
 *   allowing end-to-end dashboard testing before physical hardware is powered.
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

// If missing from CLI/env, try loading from people-detection-web/.env
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

console.log('\x1b[36m%s\x1b[0m', '=======================================================');
console.log('\x1b[36m%s\x1b[0m', '  ESP32-S3 HARDWARE TELEMETRY SIMULATOR                ');
console.log('\x1b[36m%s\x1b[0m', '  Local Academic Laboratory Test Utility               ');
console.log('\x1b[36m%s\x1b[0m', '=======================================================');
console.log(`Target URL : ${supabaseUrl || '(Not configured)'}`);
console.log(`Key Excerpt: ${supabaseAnonKey ? supabaseAnonKey.slice(0, 16) + '...' : '(Not configured)'}`);
console.log('\x1b[36m%s\x1b[0m', '=======================================================');

if (!supabaseUrl || !supabaseAnonKey || supabaseUrl.includes('your-project-id')) {
  console.log('\x1b[33m%s\x1b[0m', '\n[SETUP NOTICE] Supabase credentials not found or using placeholders.');
  console.log('To transmit live telemetry packets to Supabase:');
  console.log('1. Open people-detection-web/.env');
  console.log('2. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY');
  console.log('3. Run: npm run simulate (or node scripts/simulate_sensor.js)\n');
}

// 2. Simulated object approach trajectory (in cm)
const SCENARIO_DISTANCES = [
  150.0, 135.2, 110.4, 85.0, 62.1,  // Clear (> 50 cm)
  45.0, 32.5, 24.1, 18.0, 22.4, 38.6, // Detected (<= 50 cm)
  55.4, 88.0, 140.2, 210.0,        // Clear (> 50 cm)
  null,                            // Sensor timeout / No Reading
  175.0, 48.0, 29.0, 75.0          // Dynamic alternation
];

let scenarioIndex = 0;
let sampleCounter = 0;
const THRESHOLD_CM = 50.0;

async function transmitSimulatedReading() {
  sampleCounter++;
  const rawDist = SCENARIO_DISTANCES[scenarioIndex];
  scenarioIndex = (scenarioIndex + 1) % SCENARIO_DISTANCES.length;

  let distance_cm = null;
  let detected = false;
  let sensor_status = 'No Reading';

  if (rawDist !== null) {
    // Add realistic sensor noise (+/- 0.8 cm)
    const noise = (Math.random() - 0.5) * 1.6;
    distance_cm = Math.max(2.0, Math.min(400.0, parseFloat((rawDist + noise).toFixed(2))));

    if (distance_cm <= THRESHOLD_CM) {
      detected = true;
      sensor_status = 'Detected';
    } else {
      detected = false;
      sensor_status = 'Clear';
    }
  }

  // Console output matching ESP32 Serial Monitor
  console.log('-------------------------------------------------------');
  console.log(`[SENSOR SAMPLE #${sampleCounter}]`);
  if (distance_cm !== null) {
    console.log(`  Measured Distance : ${distance_cm.toFixed(2)} cm`);
  } else {
    console.log('  Measured Distance : Invalid / Out of Range');
  }
  
  const statusColor = detected ? '\x1b[32m' : (sensor_status === 'Clear' ? '\x1b[34m' : '\x1b[33m');
  console.log(`  Detection State   : ${statusColor}${detected ? 'PERSON DETECTED' : 'CLEAR'}\x1b[0m`);
  console.log(`  Sensor Status     : ${sensor_status}`);

  // Transmit over HTTPS if credentials are valid
  if (supabaseUrl && supabaseAnonKey && !supabaseUrl.includes('your-project-id')) {
    try {
      const endpoint = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/detection_readings`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseAnonKey,
          'Authorization': `Bearer ${supabaseAnonKey}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          distance_cm,
          detected,
          sensor_status
        })
      });

      if (response.ok || response.status === 201) {
        console.log('\x1b[32m  Cloud Sync Status : SUCCESS (HTTP 201 Created)\x1b[0m');
      } else {
        const errorText = await response.text();
        console.log(`\x1b[31m  Cloud Sync Status : FAILED (HTTP ${response.status}: ${errorText})\x1b[0m`);
      }
    } catch (err) {
      console.log(`\x1b[31m  Cloud Sync Status : NETWORK ERROR (${err.message})\x1b[0m`);
    }
  } else {
    console.log('\x1b[90m  Cloud Sync Status : LOCAL MOCK ONLY (Configure .env for cloud sync)\x1b[0m');
  }
}

// Run initial reading and start 2000 ms periodic loop
transmitSimulatedReading();
setInterval(transmitSimulatedReading, 2000);
