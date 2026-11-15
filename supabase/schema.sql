-- =============================================================================
-- PEOPLE DETECTION AND MONITORING SYSTEM - SUPABASE DATABASE SCHEMA
-- =============================================================================
-- Description: Database schema and Row Level Security (RLS) policies for
--              storing distance measurements and object detection states
--              submitted by the ESP32-S3 microcontroller and retrieved
--              by the web dashboard.
-- =============================================================================

-- 1. Create table detection_readings
CREATE TABLE IF NOT EXISTS public.detection_readings (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    distance_cm NUMERIC(6, 2),
    detected BOOLEAN NOT NULL DEFAULT false,
    sensor_status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Add documentation comments
COMMENT ON TABLE public.detection_readings IS 'Stores ultrasonic sensor readings, proximity detection classification, and operational status from the ESP32-S3.';
COMMENT ON COLUMN public.detection_readings.id IS 'Unique identifier auto-incremented for each sensor report.';
COMMENT ON COLUMN public.detection_readings.distance_cm IS 'Measured distance in centimeters. Null or 0 indicates out-of-range / sensor error.';
COMMENT ON COLUMN public.detection_readings.detected IS 'Classification flag: true if an object is within the detection threshold distance.';
COMMENT ON COLUMN public.detection_readings.sensor_status IS 'State indicator: "Detected", "Clear", or "No Reading".';
COMMENT ON COLUMN public.detection_readings.created_at IS 'UTC timestamp when the reading was inserted into the database.';

-- 3. Create performance indexes
-- Speeds up queries retrieving the latest reading and paginated historical logs.
CREATE INDEX IF NOT EXISTS idx_detection_readings_created_at 
ON public.detection_readings (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_detection_readings_detected 
ON public.detection_readings (detected, created_at DESC);

-- 4. Enable Row Level Security (RLS)
ALTER TABLE public.detection_readings ENABLE ROW LEVEL SECURITY;

-- 5. Define Row Level Security Policies
-- Policy 1: Allow anonymous clients (ESP32-S3 microcontroller firmware) to INSERT new readings
DROP POLICY IF EXISTS "Allow anonymous sensor insert" ON public.detection_readings;
CREATE POLICY "Allow anonymous sensor insert"
ON public.detection_readings
FOR INSERT
TO anon
WITH CHECK (
    -- Ensure required fields match expected ranges and values
    sensor_status IN ('Detected', 'Clear', 'No Reading')
    AND (distance_cm IS NULL OR (distance_cm >= 0 AND distance_cm <= 500))
);

-- Policy 2: Allow anonymous clients (Frontend Dashboard) to SELECT historical readings
DROP POLICY IF EXISTS "Allow anonymous dashboard read" ON public.detection_readings;
CREATE POLICY "Allow anonymous dashboard read"
ON public.detection_readings
FOR SELECT
TO anon
USING (true);

-- (Notice: UPDATE and DELETE policies are intentionally omitted so that sensor readings
-- are immutable and tamper-resistant from the public anon role)

-- 6. Enable Realtime Publications
-- Enables Supabase WebSocket Realtime events for live dashboard updates
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables 
        WHERE pubname = 'supabase_realtime' 
        AND schemaname = 'public' 
        AND tablename = 'detection_readings'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.detection_readings;
    END IF;
END $$;
