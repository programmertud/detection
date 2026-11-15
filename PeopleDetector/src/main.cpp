/**
 * ============================================================================
 * PEOPLE DETECTION AND MONITORING SYSTEM - ESP32-S3 FIRMWARE
 * ============================================================================
 * Microcontroller: ESP32-S3 (WROOM / DevKitC-1)
 * Framework:       Arduino (C++)
 * Platform:        PlatformIO
 * 
 * Hardware Connections:
 *   HC-SR04 TRIG  --> ESP32-S3 GPIO 5
 *   HC-SR04 ECHO  --> Voltage Divider (1kΩ / 2kΩ) --> ESP32-S3 GPIO 6
 *   HC-SR04 VCC   --> 5V Power Rail (or ESP32 5V / VIN pin)
 *   HC-SR04 GND   --> Common Ground (GND)
 * 
 * Cloud Backend:
 *   Supabase REST API (HTTPS POST /rest/v1/detection_readings)
 * 
 * Note on Academic Scope:
 *   The ultrasonic sensor measures acoustic time-of-flight to calculate
 *   physical distance to the nearest reflective surface. Proximity within
 *   the configured threshold classifies the state as "Detected" (possible
 *   presence), without claiming biological person identification.
 * ============================================================================
 */

#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include "secrets.h"

// ----------------------------------------------------------------------------
// HARDWARE PIN DEFINITIONS
// ----------------------------------------------------------------------------
constexpr uint8_t PIN_TRIG   = 5;  // Ultrasonic Trigger Pin
constexpr uint8_t PIN_ECHO   = 6;  // Ultrasonic Echo Pin (Received via 3.3V divider)
constexpr uint8_t PIN_BUZZER = 7;  // Audible Alert Buzzer Pin (Active or Passive)

// ----------------------------------------------------------------------------
// SENSOR & SYSTEM CONFIGURATION
// ----------------------------------------------------------------------------
// Configurable detection threshold in centimeters (Academic Laboratory Default: 50.0 cm)
constexpr float DETECTION_THRESHOLD_CM = 50.0f;

// Operational physical limits of the HC-SR04 sensor
constexpr float SENSOR_MIN_DISTANCE_CM = 2.0f;    // Minimum reliable sensing range
constexpr float SENSOR_MAX_DISTANCE_CM = 400.0f;  // Maximum reliable sensing range

// Speed of sound in ambient air at ~20°C: 343 m/s = 0.0343 cm/microsecond
// Formula: Distance (cm) = (Echo pulse duration in microseconds * 0.0343) / 2
constexpr float SPEED_OF_SOUND_CM_PER_US = 0.0343f;

// pulseIn timeout: 30,000 microseconds (~514 cm max time-of-flight)
constexpr unsigned long ECHO_TIMEOUT_US = 30000;

// Periodic cloud upload rate: Exactly every 2000 ms (2.0 seconds)
constexpr unsigned long UPLOAD_INTERVAL_MS = 2000;

// Wi-Fi Reconnection check interval: 5000 ms
constexpr unsigned long WIFI_RECONNECT_INTERVAL_MS = 5000;

// ----------------------------------------------------------------------------
// SENSOR DATA STRUCTURE & DIAGNOSTICS
// ----------------------------------------------------------------------------
struct SensorReading {
    float distanceCm;
    unsigned long rawEchoDurationUs; // Raw pulse duration in microseconds
    bool isDetected;
    bool isValid;
    bool isHardwareResponding;       // True if HC-SR04 returned any echo (> 0 µs)
    const char* statusText;
    const char* diagnosticMessage;
};

// ----------------------------------------------------------------------------
// RUNTIME STATE VARIABLES
// ----------------------------------------------------------------------------
unsigned long lastUploadTimestamp = 0;
unsigned long lastWiFiCheckTimestamp = 0;
unsigned long totalReadingsSent = 0;
unsigned long totalUploadSuccesses = 0;
unsigned long totalUploadFailures = 0;

// ----------------------------------------------------------------------------
// FUNCTION DECLARATIONS
// ----------------------------------------------------------------------------
void setupHardware();
void runUltrasonicSelfTest();
void connectToWiFi();
void maintainWiFiConnection();
SensorReading sampleUltrasonicDistance();
bool uploadReadingToSupabase(const SensorReading& reading);
void triggerBuzzerAlert(bool playChirp);

// ----------------------------------------------------------------------------
// SETUP
// ----------------------------------------------------------------------------
void setup() {
    // Initialize Hardware Serial Monitor
    Serial.begin(115200);
    delay(1000); // Allow UART bridge to stabilize

    Serial.println();
    Serial.println("=======================================================");
    Serial.println("  ESP32-S3 PEOPLE DETECTION & MONITORING SYSTEM        ");
    Serial.println("  Academic Research & Laboratory Demonstration Node    ");
    Serial.println("=======================================================");
    Serial.printf("Configured Distance Threshold: %.1f cm\n", DETECTION_THRESHOLD_CM);
    Serial.printf("Sensor Pins: TRIG=GPIO%d, ECHO=GPIO%d, BUZZER=GPIO%d\n", PIN_TRIG, PIN_ECHO, PIN_BUZZER);
    Serial.println("=======================================================");

    setupHardware();
    runUltrasonicSelfTest();
    connectToWiFi();
}

// ----------------------------------------------------------------------------
// MAIN LOOP
// ----------------------------------------------------------------------------
void loop() {
    // 1. Maintain background Wi-Fi connectivity
    maintainWiFiConnection();

    // 2. Non-blocking periodic sensor measurement and cloud upload every 2s
    unsigned long currentMillis = millis();
    if (currentMillis - lastUploadTimestamp >= UPLOAD_INTERVAL_MS) {
        lastUploadTimestamp = currentMillis;

        // Perform acoustic distance measurement and state classification
        SensorReading reading = sampleUltrasonicDistance();

        // Print formatted real-time diagnostic panel to Serial Monitor
        Serial.println("=======================================================");
        Serial.printf("[SAMPLE #%lu] ULTRASONIC SENSOR TELEMETRY & DIAGNOSTICS\n", totalReadingsSent + 1);
        Serial.println("-------------------------------------------------------");
        
        if (reading.isHardwareResponding) {
            Serial.printf("  Sensor Hardware   : OPERATIONAL [OK] (Echo: %lu us)\n", reading.rawEchoDurationUs);
        } else {
            Serial.println("  Sensor Hardware   : NOT RESPONDING / TIMEOUT (0 us)");
            Serial.println("  Troubleshooting   : Check 5V power rail, TRIG (GPIO 5), or ECHO (GPIO 6)");
        }

        if (reading.isValid) {
            Serial.printf("  Measured Distance : %.2f cm\n", reading.distanceCm);
        } else {
            Serial.println("  Measured Distance : Invalid / Out of Range");
        }

        Serial.printf("  Distance Threshold: %.1f cm\n", DETECTION_THRESHOLD_CM);
        Serial.printf("  Detection State   : [%s]\n", reading.isDetected ? "PERSON DETECTED" : "AREA CLEAR");
        Serial.printf("  Sensor Status     : %s\n", reading.statusText);
        Serial.printf("  Diagnostic Detail : %s\n", reading.diagnosticMessage);

        // Physical Audible Alert (Buzzer pulses on detection)
        if (reading.isDetected) {
            Serial.println("  Audible Buzzer    : ACTIVE CHIRP (GPIO 7)");
            triggerBuzzerAlert(true);
        } else {
            Serial.println("  Audible Buzzer    : SILENT (Area Clear)");
            triggerBuzzerAlert(false);
        }

        // Upload to Supabase cloud if Wi-Fi is connected
        if (WiFi.status() == WL_CONNECTED) {
            bool success = uploadReadingToSupabase(reading);
            totalReadingsSent++;
            if (success) {
                totalUploadSuccesses++;
                Serial.printf("  Cloud Sync Status : SUCCESS (HTTP 201 Created | Total: %lu)\n", totalUploadSuccesses);
            } else {
                totalUploadFailures++;
                Serial.printf("  Cloud Sync Status : FAILED  (Total: %lu)\n", totalUploadFailures);
            }
        } else {
            Serial.println("  Cloud Sync Status : SKIPPED (Wi-Fi disconnected)");
        }
        Serial.println("=======================================================");
        Serial.println();
    }
}

// ----------------------------------------------------------------------------
// HARDWARE INITIALIZATION
// ----------------------------------------------------------------------------
void setupHardware() {
    pinMode(PIN_TRIG, OUTPUT);
    pinMode(PIN_ECHO, INPUT);
    pinMode(PIN_BUZZER, OUTPUT);

    // Ensure outputs start in low quiescent state
    digitalWrite(PIN_TRIG, LOW);
    digitalWrite(PIN_BUZZER, LOW);
    delayMicroseconds(50);
    Serial.println("[HW] HC-SR04 & Buzzer GPIO pins configured successfully.");
}

// ----------------------------------------------------------------------------
// ULTRASONIC SENSOR HARDWARE SELF-TEST DIAGNOSTIC (POST)
// ----------------------------------------------------------------------------
void runUltrasonicSelfTest() {
    Serial.println();
    Serial.println("-------------------------------------------------------");
    Serial.println("  HC-SR04 ULTRASONIC SENSOR HARDWARE SELF-TEST        ");
    Serial.println("-------------------------------------------------------");
    Serial.println("  Firing 3 diagnostic acoustic test pulses...");

    int validEchoCount = 0;
    float lastMeasuredDist = 0.0f;

    for (int i = 1; i <= 3; i++) {
        delay(60);
        SensorReading test = sampleUltrasonicDistance();
        if (test.isHardwareResponding) {
            validEchoCount++;
            if (test.isValid) lastMeasuredDist = test.distanceCm;
            Serial.printf("   Test Pulse #%d: ECHO RECEIVED (Duration: %lu us, Distance: %.1f cm)\n", 
                          i, test.rawEchoDurationUs, test.distanceCm);
        } else {
            Serial.printf("   Test Pulse #%d: TIMEOUT (0 us - No echo detected)\n", i);
        }
    }

    Serial.println();
    if (validEchoCount > 0) {
        Serial.println("  >>> RESULT: [PASSED] ULTRASONIC TRANSDUCER IS FUNCTIONAL! <<<");
        if (lastMeasuredDist > 0) {
            Serial.printf("      Target reflective surface detected at: %.2f cm\n", lastMeasuredDist);
        }
        // Confirmation double chirp on buzzer
        triggerBuzzerAlert(true);
        delay(80);
        triggerBuzzerAlert(true);
    } else {
        Serial.println("  >>> RESULT: [WARNING] ULTRASONIC SENSOR IS NOT RESPONDING <<<");
        Serial.println("      Zero echo pulses returned from ECHO (GPIO 6).");
        Serial.println("      Hardware Troubleshooting Checklist:");
        Serial.println("        1. Check VCC: Must be connected to 5V / VIN (not 3.3V).");
        Serial.println("        2. Check TRIG: Must connect to GPIO 5.");
        Serial.println("        3. Check ECHO: Must connect to GPIO 6 (via 1k resistor).");
        Serial.println("        4. Check GND: Must share common ground with ESP32.");
    }
    Serial.println("-------------------------------------------------------");
    Serial.println();
}

// ----------------------------------------------------------------------------
// BUZZER ACOUSTIC ALERT CONTROLLER
// ----------------------------------------------------------------------------
void triggerBuzzerAlert(bool playChirp) {
    if (playChirp) {
        // High-pitch 2400 Hz acoustic alert pulse
        // Generates clean software square wave compatible with active & passive buzzers
        // completely bypassing LEDC hardware timers to eliminate driver errors
        unsigned long startMs = millis();
        while (millis() - startMs < 100) {
            digitalWrite(PIN_BUZZER, HIGH);
            delayMicroseconds(208); // 2400 Hz half-cycle
            digitalWrite(PIN_BUZZER, LOW);
            delayMicroseconds(208);
        }
    } else {
        digitalWrite(PIN_BUZZER, LOW);
    }
}

// ----------------------------------------------------------------------------
// WI-FI CONNECTION MANAGEMENT
// ----------------------------------------------------------------------------
void connectToWiFi() {
    Serial.printf("[WIFI] Connecting to SSID: %s ...\n", WIFI_SSID);
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    uint8_t attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 25) {
        delay(500);
        Serial.print(".");
        attempts++;
    }

    Serial.println();
    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("[WIFI] Connected successfully!");
        Serial.printf("[WIFI] Assigned IP Address : %s\n", WiFi.localIP().toString().c_str());
        Serial.printf("[WIFI] Signal Strength (RSSI): %d dBm\n", WiFi.RSSI());
        Serial.printf("[WIFI] MAC Address         : %s\n", WiFi.macAddress().c_str());
    } else {
        Serial.println("[WIFI] Connection failed. Background auto-reconnect will retry...");
    }
}

void maintainWiFiConnection() {
    unsigned long currentMillis = millis();
    if (currentMillis - lastWiFiCheckTimestamp >= WIFI_RECONNECT_INTERVAL_MS) {
        lastWiFiCheckTimestamp = currentMillis;

        if (WiFi.status() != WL_CONNECTED) {
            Serial.println("[WIFI] Disconnected! Attempting automatic reconnection...");
            WiFi.disconnect();
            WiFi.reconnect();
        }
    }
}

// ----------------------------------------------------------------------------
// ULTRASONIC DISTANCE MEASUREMENT & CLASSIFICATION
// ----------------------------------------------------------------------------
SensorReading sampleUltrasonicDistance() {
    SensorReading result;
    result.distanceCm = -1.0f;
    result.rawEchoDurationUs = 0;
    result.isDetected = false;
    result.isValid = false;
    result.isHardwareResponding = false;
    result.statusText = "No Reading";
    result.diagnosticMessage = "Initializing";

    // Step 1: Ensure clean low pulse for 4 microseconds
    digitalWrite(PIN_TRIG, LOW);
    delayMicroseconds(4);

    // Step 2: Emit standard 10-microsecond ultrasonic burst trigger
    digitalWrite(PIN_TRIG, HIGH);
    delayMicroseconds(10);
    digitalWrite(PIN_TRIG, LOW);

    // Step 3: Measure high pulse duration returned from HC-SR04 echo pin
    unsigned long echoDurationUs = pulseIn(PIN_ECHO, HIGH, ECHO_TIMEOUT_US);
    result.rawEchoDurationUs = echoDurationUs;

    // Step 4: Validate pulse duration and compute physical distance
    if (echoDurationUs == 0) {
        // Echo timed out: no acoustic reflection detected or sensor disconnected
        result.isValid = false;
        result.isDetected = false;
        result.isHardwareResponding = false;
        result.statusText = "No Reading";
        result.diagnosticMessage = "Sensor timeout: No echo received (Check VCC 5V or wiring)";
        return result;
    }

    // Hardware returned a real acoustic pulse!
    result.isHardwareResponding = true;

    // Time-of-flight acoustic conversion to distance (cm)
    float calculatedDistance = (echoDurationUs * SPEED_OF_SOUND_CM_PER_US) / 2.0f;

    // Check against physical sensor operating boundaries (2 cm to 400 cm)
    if (calculatedDistance < SENSOR_MIN_DISTANCE_CM) {
        result.isValid = false;
        result.isDetected = false;
        result.statusText = "No Reading";
        result.diagnosticMessage = "Blind zone error: Object closer than 2.0 cm min limit";
        return result;
    }

    if (calculatedDistance > SENSOR_MAX_DISTANCE_CM) {
        result.isValid = false;
        result.isDetected = false;
        result.statusText = "No Reading";
        result.diagnosticMessage = "Out-of-range: Reflection beyond 400.0 cm max limit";
        return result;
    }

    // Reading is acoustically valid
    result.distanceCm = calculatedDistance;
    result.isValid = true;

    // Classification Logic:
    // Distance > 0 and <= DETECTION_THRESHOLD_CM : Detected
    // Distance > DETECTION_THRESHOLD_CM          : Clear
    if (result.distanceCm <= DETECTION_THRESHOLD_CM) {
        result.isDetected = true;
        result.statusText = "Detected";
        result.diagnosticMessage = "Object within proximity limit (Person Detected)";
    } else {
        result.isDetected = false;
        result.statusText = "Clear";
        result.diagnosticMessage = "Path unobstructed (Area Clear)";
    }

    return result;
}

// ----------------------------------------------------------------------------
// SUPABASE HTTPS REST UPLOAD
// ----------------------------------------------------------------------------
bool uploadReadingToSupabase(const SensorReading& reading) {
    WiFiClientSecure secureClient;
    // For educational/lab prototype reliability, skip strict certificate validation
    // to avoid certificate authority expiration halts on resource-constrained embedded systems.
    secureClient.setInsecure();

    HTTPClient http;

    // Build the Supabase REST endpoint URL for table detection_readings
    String endpointUrl = String(SUPABASE_URL) + "/rest/v1/detection_readings";

    if (!http.begin(secureClient, endpointUrl)) {
        Serial.println("[HTTP] Unable to establish HTTPS connection to Supabase endpoint.");
        return false;
    }

    // Configure required REST API HTTP Headers
    http.addHeader("Content-Type", "application/json");
    http.addHeader("apikey", SUPABASE_ANON_KEY);
    http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);
    // Prefer: return=minimal instructs PostgREST to return 201 Created with empty body,
    // conserving embedded memory and network bandwidth.
    http.addHeader("Prefer", "return=minimal");

    // Construct JSON Payload
    StaticJsonDocument<256> doc;
    if (reading.isValid) {
        // Round to 2 decimal places for clean sensor logs
        doc["distance_cm"] = serialized(String(reading.distanceCm, 2));
    } else {
        doc["distance_cm"] = nullptr; // JSON null matches Supabase NUMERIC NULL
    }
    doc["detected"] = reading.isDetected;
    doc["sensor_status"] = reading.statusText;

    String jsonPayload;
    serializeJson(doc, jsonPayload);

    // Execute HTTP POST
    int httpResponseCode = http.POST(jsonPayload);

    bool requestSucceeded = false;
    if (httpResponseCode == HTTP_CODE_CREATED || httpResponseCode == HTTP_CODE_OK || httpResponseCode == 204) {
        requestSucceeded = true;
    } else {
        Serial.printf("[HTTP] POST failed. Status Code: %d\n", httpResponseCode);
        if (httpResponseCode > 0) {
            String responseBody = http.getString();
            Serial.printf("[HTTP] Server Response: %s\n", responseBody.c_str());
        } else {
            Serial.printf("[HTTP] Error string: %s\n", http.errorToString(httpResponseCode).c_str());
        }
    }

    http.end();
    return requestSucceeded;
}
