# FireGuard IoT - Fire & Flame Detection and Monitoring System (ESP32-S3 + Flame Sensor + Buzzer + Supabase + Vercel)

An end-to-end, deployment-ready IoT fire detection and emergency alert monitoring system. The system continuously samples infrared flame emissions using an **IR Flame Sensor Module (LM393)** interfaced with an **ESP32-S3 microcontroller**, sounds an emergency dual-frequency audible siren using a **Piezo Buzzer**, transmits telemetry over HTTPS to a **Supabase PostgreSQL** cloud database every 2 seconds (accelerating to 1s on active fire events), and visualizes live status on an interactive **Vite + Vanilla JavaScript** web dashboard hosted on **Vercel**.

---

## 1. System Architecture

```
+-------------------------------------------------------------------------+
|                           PHYSICAL SENSING NODE                         |
|                                                                         |
|  +--------------------+                   +--------------------------+  |
|  |  Flame Sensor      |                   |   ESP32-S3 DevKitC-1     |  |
|  |  (IR Photodiode)   |                   |                          |  |
|  |  VCC (3.3V / 5V) <-+-------------------+-- 3.3V (or 5V on J3)     |  |
|  |  GND       --------+-------------------+-- GND (Common)           |  |
|  |  DO (Digital Out) -+-------------------+-- GPIO 4 (Input Pullup)  |  |
|  |  AO (Analog Out) --+-------------------+-- GPIO 5 (ADC1 Channel 4)|  |
|  +--------------------+                   |                          |  |
|                                           |                          |  |
|  +--------------------+                   |                          |  |
|  |  Piezo Buzzer      |                   |                          |  |
|  |  Positive (+)  <---+-------------------+-- GPIO 7 (Emergency Siren|  |
|  |  Negative (-)  ----+-------------------+-- GND (Common)           |  |
|  +--------------------+                   +--------------------------+  |
+-------------------------------------------------------------------------+
                                     |
                          Wi-Fi 802.11 b/g/n (2.4 GHz)
                          HTTPS REST POST (Every 1s-2s)
                          Header: apikey & Authorization (Anon key)
                                     v
+-------------------------------------------------------------------------+
|                          SUPABASE CLOUD BACKEND                         |
|                                                                         |
|  +-------------------------------------------------------------------+  |
|  | PostgreSQL Database (`detection_readings` table)                  |  |
|  | - id: BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY             |  |
|  | - distance_cm: NUMERIC(6, 2)  (Flame Intensity % 0.0 - 100.0)     |  |
|  | - detected: BOOLEAN           (true = Fire Alert, false = Safe)   |  |
|  | - sensor_status: TEXT         ('Fire Alert' | 'Safe' | 'Warning') |  |
|  | - created_at: TIMESTAMPTZ DEFAULT now()                           |  |
|  +-------------------------------------------------------------------+  |
|  | Realtime Publication Active (WSS streaming to web dashboard)      |  |
+-------------------------------------------------------------------------+
                                     v
+-------------------------------------------------------------------------+
|                       WEB TELEMETRY DASHBOARD                           |
|  - Real-time Fire Alert Status Hero Indicator (Normal vs. FIRE ALERT)|  |
|  - Live Thermal Radiation & Flame Intensity Radar Visualizer         |  |
|  - Adjustable Flame Sensitivity Threshold Slider                     |  |
|  - Browser Emergency Siren Audio Engine (Web Audio API)              |  |
|  - Historical Incident Log Table with Filtering & CSV Export         |  |
|  - Deployed on Vercel Edge Network                                   |  |
+-------------------------------------------------------------------------+
```

---

## 2. Hardware Wiring Diagram

| Component Pin | ESP32-S3 Pin | Signal Level | Function Description |
| :--- | :--- | :--- | :--- |
| **Flame Sensor VCC** | **3.3V** (or 5V on J3) | 3.3V DC | Sensor power rail |
| **Flame Sensor GND** | **GND** | 0V Reference | Common circuit ground |
| **Flame Sensor DO** | **GPIO 4** | 3.3V Logic | Digital trigger output (Active LOW on flame) |
| **Flame Sensor AO** | **GPIO 5** | 0.0V - 3.3V | Analog flame radiation level (ADC1_CH4) |
| **Buzzer (+)** | **GPIO 7** | 3.3V Logic | Audible emergency fire siren |
| **Buzzer (-)** | **GND** | 0V Reference | Common circuit ground |

---

## 3. How the Flame Sensor Works

1. **IR Photodiode:** The sensor detects infrared radiation emitted by naked flames in the **760 nm – 1100 nm** spectrum.
2. **Digital Output (DO):** The LM393 comparator triggers **LOW** when infrared light exceeds the sensitivity threshold set by the onboard blue potentiometer.
3. **Analog Output (AO):** Outputs a real-time analog voltage read by ESP32-S3's 12-bit ADC (0 to 4095). Under dark ambient conditions, the reading is near 4095 (~0% flame intensity). When open flame is present, the voltage drops toward 0 (~100% flame intensity).
4. **Emergency Siren:** When flame is detected (either DO goes LOW or intensity $\ge 40\%$), the ESP32-S3 fires an urgent alternating high-low fire siren (2800 Hz / 1900 Hz warble) on GPIO 7.

---

## 4. Quick Start

### Step 1: Flash ESP32-S3 Firmware
1. Open PlatformIO in VS Code.
2. Ensure `PeopleDetector/include/secrets.h` contains your Wi-Fi credentials and Supabase keys:
   ```cpp
   #define WIFI_SSID "Your_WiFi_Name"
   #define WIFI_PASSWORD "Your_WiFi_Password"
   #define SUPABASE_URL "https://your-project.supabase.co"
   #define SUPABASE_ANON_KEY "your_anon_key"
   ```
3. Connect your ESP32-S3 via USB cable and click **Upload and Monitor** (`COM9`, `115200` baud).

### Step 2: Open Web Dashboard
1. Open your browser to `http://localhost:3000` (or `http://localhost:3001`).
2. The dashboard will automatically stream real-time fire telemetry!
3. Enable **Siren: ON** to hear the browser emergency fire alarm when a flame is detected.
