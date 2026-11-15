# People Detection and Monitoring System (ESP32-S3 + HC-SR04 + Supabase + Vercel)

An end-to-end, deployment-ready IoT monitoring and research telemetry system for academic laboratories. The system continuously measures acoustic proximity using an **HC-SR04 ultrasonic sensor** interfaced with an **ESP32-S3 microcontroller**, transmits telemetry over HTTPS to a **Supabase PostgreSQL** cloud database every 2 seconds, and visualizes live status on a responsive **Vite + Vanilla JavaScript** web dashboard hosted on **Vercel**.

> **Academic Research Notice:**  
> The HC-SR04 ultrasonic transducer emits 40 kHz acoustic pressure waves and measures round-trip time-of-flight to determine the physical distance to the nearest reflecting surface. Proximity within the configured threshold is classified as **"Detected"** (possible presence), and does not claim biological human identification.

---

## 1. System Architecture

```
+-------------------------------------------------------------------------+
|                           PHYSICAL SENSING NODE                         |
|                                                                         |
|  +--------------------+                   +--------------------------+  |
|  |  HC-SR04 Sensor    |                   |   ESP32-S3 DevKitC-1     |  |
|  |                    |                   |                          |  |
|  |  VCC (5V)  <-------+-------------------+-- 5V / VIN               |  |
|  |  TRIG      <-------+-------------------+-- GPIO 5 (Output)        |  |
|  |  ECHO (5V) --------+--[ R1: 1kΩ ]--*---+-- GPIO 6 (Input)        |  |
|  |                    |               |   |                          |  |
|  |                    |          [ R2: 2kΩ]                          |  |
|  |                    |               |   |                          |  |
|  |  GND       --------+---------------+---+-- GND (Common)          |  |
|  +--------------------+               |   +--------------------------+  |
|                                      GND                                |
+-------------------------------------------------------------------------+
                                     |
                          Wi-Fi 802.11 b/g/n (2.4 GHz)
                          HTTPS REST POST (Every 2s)
                          Header: apikey & Authorization (Anon key)
                                     v
+-------------------------------------------------------------------------+
|                          SUPABASE CLOUD BACKEND                         |
|                                                                         |
|  +-------------------------------------------------------------------+  |
|  | PostgreSQL Database (`detection_readings` table)                  |  |
|  | - id: BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY             |  |
|  | - distance_cm: NUMERIC(6, 2)                                      |  |
|  | - detected: BOOLEAN                                               |  |
|  | - sensor_status: TEXT ('Detected' | 'Clear' | 'No Reading')       |  |
|  | - created_at: TIMESTAMPTZ DEFAULT now()                           |  |
|  +-------------------------------------------------------------------+  |
|  | Row Level Security (RLS) Active:                                  |  |
|  | - INSERT: anon role with data validation                          |  |
|  | - SELECT: anon role for dashboard reading                         |  |
|  | - UPDATE/DELETE: Denied (Read-only historical audit log)          |  |
|  +-------------------------------------------------------------------+  |
|  | Realtime Publication Engine (WebSockets)                          |  |
+-------------------------------------------------------------------------+
                                     |
                       HTTPS REST Queries & WebSocket Events
                                     v
+-------------------------------------------------------------------------+
|                        VERCEL WEB DASHBOARD                             |
|                                                                         |
|  - HTML5, CSS3, Vanilla ES Modules, Vite, Lucide Icons                  |
|  - Real-time Telemetry Visualizer (Live Radar Sonar Screen)             |
|  - Status Monitor (Person Detected / Area Clear / No Reading)           |
|  - Dynamic Distance-vs-Threshold Comparison Bar                         |
|  - Historical Log Table with Pagination & CSV Export                    |
|  - Synthesized Web Audio API Alert Chime                                |
|  - Automatic Sensor Node Freshness Watchdog (<6s = Online, >6s = Stale) |
+-------------------------------------------------------------------------+
```

---

## 2. Hardware Wiring & Voltage Divider Guide

### 2.1 The Need for Voltage Translation
The **HC-SR04** ultrasonic sensor operates from a **5.0V DC** power supply rail. When sound returns to the receiver, the sensor outputs a 5V TTL pulse on its **ECHO** pin.  
However, the **ESP32-S3 GPIO pins operate strictly at 3.3V logic** (absolute maximum voltage rating is 3.6V). Feeding a 5V signal directly into GPIO 6 risks silicon degradation or permanent damage to the microcontroller's internal ESD protection diodes.

To safely step down the Echo signal from 5.0V to ~3.3V, a passive **voltage divider** circuit is implemented using two standard resistors:

### 2.2 Voltage Divider Calculation

Using Ohm's law and the voltage divider equation:

$$V_{out} = V_{in} \times \left(\frac{R_2}{R_1 + R_2}\right)$$

Where:
- $V_{in} = 5.0\text{ V}$ (from HC-SR04 ECHO pin)
- $R_1 = 1.0\text{ k}\Omega$ (Series resistor between ECHO and GPIO 6)
- $R_2 = 2.0\text{ k}\Omega$ (Pull-down resistor between GPIO 6 and GND)

$$V_{out} = 5.0\text{ V} \times \left(\frac{2000}{1000 + 2000}\right) = 5.0 \times \frac{2}{3} \approx 3.33\text{ V}$$

$3.33\text{ V}$ safely meets the ESP32-S3 High-Level Input threshold ($V_{IH} \ge 0.75 \times V_{DD} = 2.475\text{ V}$) while remaining well below the $3.6\text{ V}$ absolute maximum limit.

> **Alternative resistor pairs:**  
> - $R_1 = 2.2\text{ k}\Omega$, $R_2 = 3.3\text{ k}\Omega \implies V_{out} = 5.0 \times (3.3 / 5.5) = 3.00\text{ V}$ (Safe & reliable)  
> - $R_1 = 10\text{ k}\Omega$, $R_2 = 20\text{ k}\Omega \implies V_{out} = 3.33\text{ V}$

### 2.3 Wiring Pinout Table

| HC-SR04 Pin | ESP32-S3 Pin | Intermediary Components | Signal Voltage | Description |
| :--- | :--- | :--- | :--- | :--- |
| **VCC** | **5V / VIN** | Direct wire | 5.0V DC | Sensor power rail |
| **TRIG** | **GPIO 5** | Direct wire | 3.3V Logic | 10µs ultrasonic burst trigger |
| **ECHO** | **GPIO 6** | $R_1 (1\text{k}\Omega)$ to GPIO 6, $R_2 (2\text{k}\Omega)$ to GND | 5.0V $\to$ 3.33V | Safe Echo duration pulse |
| **GND** | **GND** | Direct wire | 0V Reference | Common circuit ground |

---

## 3. Directory Layout

```
people detection/
├── PeopleDetector/                     # PlatformIO Embedded Firmware Project
│   ├── platformio.ini                  # Environment & library dependencies
│   ├── include/
│   │   ├── secrets.h                   # Active Wi-Fi & Supabase credentials
│   │   └── secrets.h.example           # Clean credential template
│   ├── src/
│   │   └── main.cpp                    # Full ESP32-S3 C++ firmware
│   └── .gitignore
│
├── people-detection-web/               # Web Application (Frontend)
│   ├── index.html                      # Semantic dashboard structure
│   ├── package.json                    # Vite, Supabase JS, Lucide icons
│   ├── vite.config.js                  # Vite build settings (outDir: dist)
│   ├── vercel.json                     # Vercel deployment & security headers
│   ├── .env.example                    # Frontend environment variable template
│   ├── .gitignore
│   └── src/
│       ├── main.js                     # Telemetry fetcher, radar & audio logic
│       └── style.css                   # Modern minimalist dark theme styling
│
├── supabase/
│   └── schema.sql                      # PostgreSQL DDL, indexes, and RLS policies
│
└── README.md                           # Documentation, wiring, & testing guide
```

---

## 4. Supabase Database Setup

1. Log in to [Supabase](https://supabase.com) and create a new project.
2. In the Supabase Project Dashboard, navigate to the **SQL Editor** (icon with `>_`).
3. Open the file `supabase/schema.sql` located in this repository and paste the contents into the SQL Editor.
4. Click **Run** to execute the script.
5. Verify that:
   - The table `detection_readings` has been created.
   - Row Level Security (RLS) is enabled.
   - The policies `"Allow anonymous sensor insert"` and `"Allow anonymous dashboard read"` are listed under **Authentication -> Policies**.
   - Under **Database -> Publications**, `supabase_realtime` includes `detection_readings`.
6. Retrieve your credentials:
   - Navigate to **Project Settings -> API**.
   - Copy the **Project URL** (e.g., `https://abcdefgh.supabase.co`).
   - Copy the **anon public** API key.

---

## 5. Firmware Configuration & Flashing (PlatformIO)

### 5.1 Configure Credentials
Open `PeopleDetector/include/secrets.h` and fill in your Wi-Fi credentials and Supabase credentials:

```cpp
#define WIFI_SSID           "Your_Lab_WiFi_SSID"
#define WIFI_PASSWORD       "Your_WiFi_Password"
#define SUPABASE_URL        "https://your-project-id.supabase.co"
#define SUPABASE_ANON_KEY   "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

### 5.2 Build & Upload via PlatformIO in VS Code
1. Open Visual Studio Code with the **PlatformIO IDE** extension installed.
2. Open the `PeopleDetector` folder in PlatformIO.
3. Connect the ESP32-S3 to your computer using a USB-C data cable (plug into the **USB / Native USB** port or **UART** port of the DevKit).
4. In the PlatformIO bottom status bar:
   - Click **Build** (`✓`) to compile the firmware.
   - Click **Upload** (`→`) to flash the ESP32-S3.
   - Click **Serial Monitor** (`plug` icon) set at **115200 baud** to view real-time diagnostics.

### 5.3 Serial Monitor Expected Output
```text
=======================================================
  ESP32-S3 PEOPLE DETECTION & MONITORING SYSTEM        
  Academic Research & Laboratory Demonstration Node    
=======================================================
Configured Distance Threshold: 50.0 cm
Sensor Pins: TRIG=GPIO5, ECHO=GPIO6
=======================================================
[HW] HC-SR04 GPIO pins configured successfully.
[WIFI] Connecting to SSID: Lab_WiFi ...
........
[WIFI] Connected successfully!
[WIFI] Assigned IP Address : 192.168.1.142
[WIFI] Signal Strength (RSSI): -54 dBm
-------------------------------------------------------
[SENSOR SAMPLE #1]
  Measured Distance : 38.40 cm
  Detection State   : PERSON DETECTED
  Sensor Status     : Detected
  Cloud Sync Status : SUCCESS (Total: 1)
-------------------------------------------------------
[SENSOR SAMPLE #2]
  Measured Distance : 112.50 cm
  Detection State   : CLEAR
  Sensor Status     : Clear
  Cloud Sync Status : SUCCESS (Total: 2)
```

---

## 6. Frontend Local Development & Testing

### 6.1 Install Dependencies
Navigate into the `people-detection-web` directory:

```bash
cd people-detection-web
npm install
```

### 6.2 Set Up Local Environment Variables
Create a `.env` file in `people-detection-web/`:

```bash
cp .env.example .env
```

Edit `.env`:
```env
VITE_SUPABASE_URL=https://your-project-id.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### 6.3 Run the Development Server
```bash
npm run dev
```
Open `http://localhost:3000` in your web browser.

### 6.4 Production Build Verification
Test the production bundle locally:
```bash
npm run build
npm run preview
```

---

## 7. Vercel Cloud Deployment

### 7.1 Deploying via Vercel CLI
If you have the Vercel CLI installed:
```bash
cd people-detection-web
vercel
```
When prompted for Environment Variables, add:
- `VITE_SUPABASE_URL` = `https://your-project-id.supabase.co`
- `VITE_SUPABASE_ANON_KEY` = `your-anon-public-key`

Deploy to production:
```bash
vercel --prod
```

### 7.2 Deploying via GitHub & Vercel Dashboard
1. Push this repository to GitHub (see Section 8).
2. Log in to [Vercel](https://vercel.com).
3. Click **Add New -> Project** and import the GitHub repository.
4. Set **Root Directory** to `people-detection-web`.
5. Under **Build and Output Settings**:
   - Framework Preset: `Vite`
   - Build Command: `npm run build`
   - Output Directory: `dist`
6. Expand **Environment Variables** and add:
   - `VITE_SUPABASE_URL`: Your Supabase Project URL
   - `VITE_SUPABASE_ANON_KEY`: Your Supabase Anon Key
7. Click **Deploy**. Vercel will build and assign a global HTTPS production URL.

---

## 8. GitHub Repository Setup Guide

To initialize a Git repository and push the project to GitHub:

```bash
# 1. Initialize git in the root folder
git init

# 2. Add files
git add .

# 3. Create initial commit
git commit -m "feat: complete ESP32-S3 people detection system with Supabase and Vercel dashboard"

# 4. Link to your GitHub remote repository
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo-name>.git

# 5. Push to GitHub
git push -u origin main
```

---

## 9. Comprehensive Testing & Verification Procedure

| Test # | Objective / Procedure | Action Performed | Expected Hardware / Firmware Result | Expected Dashboard Result |
| :---: | :--- | :--- | :--- | :--- |
| **T-01** | **ESP32-S3 Wi-Fi Connection** | Power ESP32-S3 with valid SSID and password in `secrets.h`. | Serial Monitor logs `[WIFI] Connected successfully!` and displays valid IP address and RSSI. | Dashboard hardware connectivity pill transitions to **"Live Node"** within 6 seconds. |
| **T-02** | **Ultrasonic Measurement Accuracy** | Place a flat cardboard target at exactly 30 cm, 50 cm, and 100 cm using a physical ruler. | Serial Monitor distance matches measured distance within $\pm 1.5\text{ cm}$. | Dashboard **Current Distance** card and radar sonar screen display corresponding values. |
| **T-03** | **Detection Within Threshold ($\le 50\text{ cm}$)** | Place target at 35 cm (threshold is 50 cm). | Serial logs: `Detection State: PERSON DETECTED`, `Sensor Status: Detected`. POSTs `detected: true`. | Massive indicator glows green with **"Person Detected"**; synthesized laboratory chime plays. |
| **T-04** | **Area Clear Outside Threshold ($> 50\text{ cm}$)** | Move target to 120 cm. | Serial logs: `Detection State: CLEAR`, `Sensor Status: Clear`. POSTs `detected: false`. | Visual indicator switches to blue **"Area Clear"**; distance bar updates. |
| **T-05** | **Invalid Reading / Out-of-Bounds Handling** | Point sensor at an open ceiling or block transducers completely ($<2\text{ cm}$). | `echoDurationUs == 0` or out-of-range caught; Serial logs `Sensor Status: No Reading`, POSTs `distance_cm: null`. | Visual indicator turns amber **"No Reading"**; displays `--.- cm` instead of false data. |
| **T-06** | **Supabase Cloud Insertion** | Inspect Supabase Table Editor while ESP32 is powered. | HTTP Client sends POST with anon key; receives HTTP 201 Created every 2 seconds. | New row appears in `detection_readings` every 2s with UTC timestamp. |
| **T-07** | **Dashboard Telemetry Retrieval** | Observe Web Dashboard with active network connection. | Supabase Realtime channel fires or 2-second polling retrieves latest record. | Data refreshes every 2s; timestamp updates continuously. |
| **T-08** | **Historical Record Log** | Navigate to the **Detection History** tab. | Frontend queries `detection_readings` ordered by `created_at DESC`. | Paginated table lists entries with formatted timestamp, distance, and status pills; CSV export works. |
| **T-09** | **Sensor Node Disconnection / Freshness Watchdog** | Disconnect USB power cable from the ESP32-S3. | Node ceases transmitting telemetry packets. | Within 6.5s, dashboard watchdog flags node as **"Offline / Stale"** and changes connectivity badge to red. |
| **T-10** | **Production Vercel Deployment** | Access deployed Vercel HTTPS URL on desktop and mobile browser. | Vite production bundle loads with secure headers (`X-Frame-Options: DENY`, etc.). | Fully responsive dashboard operates without console errors or mixed content warnings. |

---

## 10. Troubleshooting FAQ

1. **Serial Monitor shows `HTTP POST failed. Status Code: 401`**  
   - Verify that `SUPABASE_ANON_KEY` in `include/secrets.h` is correct and does not contain leading/trailing spaces.
   - Ensure you are using the public **anon** key, not the service role key.

2. **Serial Monitor shows `HTTP POST failed. Status Code: 404`**  
   - Ensure the table name in Supabase is named exactly `detection_readings`.
   - Confirm your `SUPABASE_URL` has no trailing slash (e.g. `https://xyz.supabase.co`).

3. **HC-SR04 always reports `No Reading` or `0.00 cm`**  
   - Inspect the breadboard wiring: ensure TRIG is connected to GPIO 5, and the voltage divider between ECHO, GPIO 6, and GND has secure connections.
   - Confirm HC-SR04 VCC is connected to a 5V supply pin (not 3.3V, as the HC-SR04 receiver requires 5V to fire the comparator).

4. **ESP32-S3 fails to connect to Wi-Fi**  
   - The ESP32-S3 supports **2.4 GHz Wi-Fi networks only** (802.11 b/g/n). Ensure your router or mobile hotspot is broadcasting on 2.4 GHz (not 5 GHz only).

5. **Web Dashboard displays "Config Required"**  
   - If running locally, make sure you created `.env` with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
   - In production on Vercel, ensure the Environment Variables were added in the Vercel project settings, then trigger a redeploy.
   - You can also click the **"API Config"** button in the dashboard sidebar to enter credentials directly in the browser session.
