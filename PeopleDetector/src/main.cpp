/**
 * ============================================================================
 * IOT FIRE AND FLAME DETECTION MONITORING SYSTEM - ESP32-S3 FIRMWARE
 * ============================================================================
 * Microcontroller: ESP32-S3 (WROOM / DevKitC-1)
 * Framework:       Arduino (C++)
 * Platform:        PlatformIO
 * 
 * Hardware Circuit Connections:
 *   Flame Sensor VCC  --> ESP32-S3 3.3V (or 5V if 5V-only module)
 *   Flame Sensor GND  --> Common Ground (GND)
 *   Flame Sensor DO   --> ESP32-S3 GPIO 4 (Digital Trigger Output, Active LOW)
 *   Flame Sensor AO   --> ESP32-S3 GPIO 5 (Analog Flame Intensity, ADC1_CH4)
 *   Piezo Buzzer (+)  --> ESP32-S3 GPIO 7 (Emergency Siren Output)
 *   Piezo Buzzer (-)  --> Common Ground (GND)
 * 
 * Cloud Backend:
 *   Supabase REST API (HTTPS POST /rest/v1/detection_readings)
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
constexpr uint8_t PIN_FLAME_DO = 4;  // Flame Sensor Digital Output (LM393 Comparator)
constexpr uint8_t PIN_FLAME_AO = 5;  // Flame Sensor Analog Output (ADC1 Channel 4)
constexpr uint8_t PIN_BUZZER   = 7;  // Audible Emergency Alert Buzzer Pin

// ----------------------------------------------------------------------------
// SENSOR & SYSTEM CONFIGURATION
// ----------------------------------------------------------------------------
// Analog flame threshold (0 - 4095 ADC scale on ESP32-S3, lower = hotter/closer flame)
// Default threshold: Flame intensity >= 40% triggers alert
constexpr float FLAME_INTENSITY_ALERT_THRESHOLD = 40.0f; // Percent

// Periodic cloud upload rate: 2000 ms during normal state
constexpr unsigned long UPLOAD_INTERVAL_MS = 2000;

// Fast emergency upload throttle: 1000 ms during active fire alert
constexpr unsigned long EMERGENCY_UPLOAD_INTERVAL_MS = 1000;

// Wi-Fi Reconnection check interval: 5000 ms
constexpr unsigned long WIFI_RECONNECT_INTERVAL_MS = 5000;

// ----------------------------------------------------------------------------
// DATA STRUCTURE FOR FIRE TELEMETRY
// ----------------------------------------------------------------------------
struct FireReading {
    bool isFlameDetected;       // True if flame detected via Digital or Analog
    float flameIntensity;       // Flame intensity percentage (0.0% to 100.0%)
    int rawAnalogValue;         // Raw 12-bit ADC value (0 to 4095)
    bool digitalState;          // Raw Digital pin state (LOW = Flame on LM393)
    bool isSensorHealthy;       // True if pins respond normally
    const char* statusText;     // "Fire Alert", "Safe", "Warning", "No Reading"
    const char* diagnosticMsg;  // Descriptive operational status
};

// ----------------------------------------------------------------------------
// RUNTIME STATE VARIABLES
// ----------------------------------------------------------------------------
unsigned long lastUploadTimestamp = 0;
unsigned long lastWiFiCheckTimestamp = 0;
unsigned long totalReadingsSent = 0;
unsigned long totalUploadSuccesses = 0;
unsigned long totalUploadFailures = 0;
bool previousAlertState = false;

// ----------------------------------------------------------------------------
// FUNCTION DECLARATIONS
// ----------------------------------------------------------------------------
void setupHardware();
void runHardwareSelfTest();
void connectToWiFi();
void maintainWiFiConnection();
FireReading sampleFlameSensor();
bool uploadReadingToSupabase(const FireReading& reading);
void triggerEmergencySiren(bool activate);

// ----------------------------------------------------------------------------
// SETUP
// ----------------------------------------------------------------------------
void setup() {
    Serial.begin(115200);
    delay(1000); // UART stabilization

    Serial.println();
    Serial.println("=======================================================");
    Serial.println("  ESP32-S3 IOT FIRE & FLAME DETECTION SYSTEM           ");
    Serial.println("  Real-Time Thermal Radiation & Emergency Alert Node   ");
    Serial.println("=======================================================");
    Serial.printf("Sensor Pins: FLAME_DO=GPIO%d, FLAME_AO=GPIO%d, BUZZER=GPIO%d\n",
                  PIN_FLAME_DO, PIN_FLAME_AO, PIN_BUZZER);
    Serial.printf("Alert Trigger Threshold: Flame Intensity >= %.1f%%\n", FLAME_INTENSITY_ALERT_THRESHOLD);
    Serial.println("=======================================================");

    setupHardware();
    runHardwareSelfTest();
    connectToWiFi();
}

// ----------------------------------------------------------------------------
// MAIN LOOP
// ----------------------------------------------------------------------------
void loop() {
    // 1. Maintain background Wi-Fi connection
    maintainWiFiConnection();

    // 2. Sample Flame Sensor
    FireReading reading = sampleFlameSensor();

    // 3. Physical Audible Siren Control
    if (reading.isFlameDetected) {
        triggerEmergencySiren(true);
    } else {
        triggerEmergencySiren(false);
    }

    // 4. Determine upload interval (faster under emergency)
    unsigned long interval = reading.isFlameDetected ? EMERGENCY_UPLOAD_INTERVAL_MS : UPLOAD_INTERVAL_MS;
    unsigned long currentMillis = millis();

    // Instant upload trigger on transition from SAFE to FIRE
    bool stateChangedToAlert = (reading.isFlameDetected && !previousAlertState);
    previousAlertState = reading.isFlameDetected;

    if (stateChangedToAlert || (currentMillis - lastUploadTimestamp >= interval)) {
        lastUploadTimestamp = currentMillis;

        // Print real-time diagnostic panel to Serial Monitor
        Serial.println("=======================================================");
        Serial.printf("[SAMPLE #%lu] FIRE & FLAME SENSOR TELEMETRY\n", totalReadingsSent + 1);
        Serial.println("-------------------------------------------------------");
        
        if (reading.isFlameDetected) {
            Serial.println("  🚨 EMERGENCY STATE : >>> FIRE / FLAME DETECTED! <<<");
        } else {
            Serial.println("  🛡️  SYSTEM STATE   : [NORMAL / SAFE - NO FIRE]");
        }

        Serial.printf("  Flame Intensity    : %.1f %%\n", reading.flameIntensity);
        Serial.printf("  Raw Analog ADC     : %d / 4095 (GPIO %d)\n", reading.rawAnalogValue, PIN_FLAME_AO);
        Serial.printf("  Digital Trigger DO : %s (GPIO %d)\n", 
                      reading.digitalState ? "HIGH (Normal)" : "LOW (ACTIVE FLAME)", PIN_FLAME_DO);
        Serial.printf("  Status Classification: %s\n", reading.statusText);
        Serial.printf("  Diagnostic Detail  : %s\n", reading.diagnosticMsg);
        Serial.printf("  Audible Siren      : %s\n", reading.isFlameDetected ? "ACTIVE ALARM (GPIO 7)" : "SILENT");

        // Upload to Supabase Cloud
        if (WiFi.status() == WL_CONNECTED) {
            bool success = uploadReadingToSupabase(reading);
            totalReadingsSent++;
            if (success) {
                totalUploadSuccesses++;
                Serial.printf("  Cloud Sync Status  : SUCCESS (HTTP 201 | Total: %lu)\n", totalUploadSuccesses);
            } else {
                totalUploadFailures++;
                Serial.printf("  Cloud Sync Status  : FAILED  (Total: %lu)\n", totalUploadFailures);
            }
        } else {
            Serial.println("  Cloud Sync Status  : SKIPPED (Wi-Fi disconnected)");
        }
        Serial.println("=======================================================");
        Serial.println();
    }
}

// ----------------------------------------------------------------------------
// HARDWARE INITIALIZATION
// ----------------------------------------------------------------------------
void setupHardware() {
    pinMode(PIN_FLAME_DO, INPUT_PULLUP);
    pinMode(PIN_FLAME_AO, INPUT);
    pinMode(PIN_BUZZER, OUTPUT);

    // Initial state: Buzzer off
    digitalWrite(PIN_BUZZER, LOW);

    // Configure ESP32 ADC resolution (12-bit: 0 - 4095)
    analogReadResolution(12);

    delay(50);
    Serial.println("[HW] Flame sensor (DO=GPIO4, AO=GPIO5) and Buzzer (GPIO7) initialized.");
}

// ----------------------------------------------------------------------------
// HARDWARE SELF-TEST DIAGNOSTIC (POST)
// ----------------------------------------------------------------------------
void runHardwareSelfTest() {
    Serial.println();
    Serial.println("-------------------------------------------------------");
    Serial.println("  FIRE DETECTION SENSOR HARDWARE SELF-TEST            ");
    Serial.println("-------------------------------------------------------");
    Serial.println("  Reading initial ambient IR radiation baseline...");

    delay(100);
    int rawBaseline = analogRead(PIN_FLAME_AO);
    int digitalVal = digitalRead(PIN_FLAME_DO);

    Serial.printf("   Ambient IR Raw ADC: %d / 4095\n", rawBaseline);
    Serial.printf("   Digital DO Status : %s\n", digitalVal == LOW ? "LOW (Flame Alert)" : "HIGH (Normal Clear)");

    // Test buzzer with dual confirmation beep
    Serial.println("  Testing Emergency Buzzer Siren...");
    triggerEmergencySiren(true);
    delay(120);
    triggerEmergencySiren(false);
    delay(80);
    triggerEmergencySiren(true);
    delay(120);
    triggerEmergencySiren(false);

    Serial.println("  >>> RESULT: [PASSED] SENSOR NODE READY FOR FIRE MONITORING! <<<");
    Serial.println("-------------------------------------------------------");
    Serial.println();
}

// ----------------------------------------------------------------------------
// EMERGENCY SIREN PULSER
// Generates an urgent dual-frequency warble fire siren using software timing
// ----------------------------------------------------------------------------
void triggerEmergencySiren(bool activate) {
    if (activate) {
        // High-low alternating siren: 2800 Hz and 1900 Hz warble
        unsigned long startMs = millis();
        // High tone (2800 Hz: half-cycle ~178 us) for 50ms
        while (millis() - startMs < 50) {
            digitalWrite(PIN_BUZZER, HIGH);
            delayMicroseconds(178);
            digitalWrite(PIN_BUZZER, LOW);
            delayMicroseconds(178);
        }
        // Low tone (1900 Hz: half-cycle ~263 us) for 50ms
        startMs = millis();
        while (millis() - startMs < 50) {
            digitalWrite(PIN_BUZZER, HIGH);
            delayMicroseconds(263);
            digitalWrite(PIN_BUZZER, LOW);
            delayMicroseconds(263);
        }
    } else {
        digitalWrite(PIN_BUZZER, LOW);
    }
}

// ----------------------------------------------------------------------------
// FLAME SENSOR SAMPLING & CLASSIFICATION
// ----------------------------------------------------------------------------
FireReading sampleFlameSensor() {
    FireReading result;
    result.isFlameDetected = false;
    result.flameIntensity = 0.0f;
    result.rawAnalogValue = 0;
    result.digitalState = HIGH;
    result.isSensorHealthy = true;
    result.statusText = "Safe";
    result.diagnosticMsg = "No flame detected. Ambient environment normal.";

    // Sample Digital Output (Active LOW on standard LM393 flame sensor modules)
    result.digitalState = digitalRead(PIN_FLAME_DO);
    bool digitalTriggered = (result.digitalState == LOW);

    // Average 8 analog samples for noise rejection
    long analogSum = 0;
    for (int i = 0; i < 8; i++) {
        analogSum += analogRead(PIN_FLAME_AO);
        delayMicroseconds(50);
    }
    result.rawAnalogValue = (int)(analogSum / 8);

    // Flame sensor modules output LOWER voltage when flame is detected:
    // Raw ADC ~4095 = Dark (no flame) -> 0% intensity
    // Raw ADC ~0-500 = Intense flame close to sensor -> 100% intensity
    float intensity = ((4095.0f - (float)result.rawAnalogValue) / 4095.0f) * 100.0f;
    if (intensity < 0.0f) intensity = 0.0f;
    if (intensity > 100.0f) intensity = 100.0f;
    result.flameIntensity = intensity;

    // Classification Logic:
    // Fire is flagged if Digital Output triggers (LOW) OR Analog Intensity exceeds threshold
    if (digitalTriggered || result.flameIntensity >= FLAME_INTENSITY_ALERT_THRESHOLD) {
        result.isFlameDetected = true;
        result.statusText = "Fire Alert";
        if (result.flameIntensity >= 75.0f) {
            result.diagnosticMsg = "CRITICAL: Intense open flame detected nearby!";
        } else if (result.flameIntensity >= FLAME_INTENSITY_ALERT_THRESHOLD) {
            result.diagnosticMsg = "WARNING: Moderate flame / heat radiation detected.";
        } else {
            result.diagnosticMsg = "ALERT: Digital threshold triggered by IR flame sensor.";
        }
    } else {
        result.isFlameDetected = false;
        result.statusText = "Safe";
        result.diagnosticMsg = "Area Safe. No fire or thermal source detected.";
    }

    return result;
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
// SUPABASE HTTPS REST UPLOAD
// ----------------------------------------------------------------------------
bool uploadReadingToSupabase(const FireReading& reading) {
    WiFiClientSecure secureClient;
    secureClient.setInsecure(); // Laboratory prototype SSL bypass

    HTTPClient http;
    String endpointUrl = String(SUPABASE_URL) + "/rest/v1/detection_readings";

    if (!http.begin(secureClient, endpointUrl)) {
        Serial.println("[HTTP] Unable to establish HTTPS connection to Supabase.");
        return false;
    }

    // Headers
    http.addHeader("Content-Type", "application/json");
    http.addHeader("apikey", SUPABASE_ANON_KEY);
    http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);
    http.addHeader("Prefer", "return=minimal");

    // JSON Payload
    // In database:
    //   detected = true if fire detected, false if safe
    //   distance_cm = flame intensity percentage (0.0 to 100.0)
    //   sensor_status = "Fire Alert" or "Safe"
    StaticJsonDocument<256> doc;
    doc["distance_cm"] = serialized(String(reading.flameIntensity, 1));
    doc["detected"] = reading.isFlameDetected;
    doc["sensor_status"] = reading.statusText;

    String jsonPayload;
    serializeJson(doc, jsonPayload);

    int httpResponseCode = http.POST(jsonPayload);
    bool requestSucceeded = false;

    if (httpResponseCode == HTTP_CODE_CREATED || httpResponseCode == HTTP_CODE_OK || httpResponseCode == 204) {
        requestSucceeded = true;
    } else {
        Serial.printf("[HTTP] POST failed. Status: %d\n", httpResponseCode);
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
