-- =============================================================================
-- FIRE AND FLAME DETECTION & EMERGENCY MONITORING SYSTEM - DATABASE SCHEMA
-- =============================================================================
-- Description: PostgreSQL schema and Row Level Security (RLS) policies for
--              storing flame sensor readings, fire alert classifications,
--              and telemetry submitted by the ESP32-S3 microcontroller node.
-- =============================================================================

-- 1. Create table detection_readings
CREATE TABLE IF NOT EXISTS public.detection_readings (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    distance_cm NUMERIC(6, 2),            -- Re-purposed for Flame Intensity % (0.0 to 100.0)
    detected BOOLEAN NOT NULL DEFAULT false, -- True if Fire / Flame is detected
    sensor_status TEXT NOT NULL,          -- "Fire Alert", "Safe", "Warning"
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Add documentation comments
COMMENT ON TABLE public.detection_readings IS 'Stores real-time flame sensor readings, fire detection classifications, and alert status from the ESP32-S3 node.';
COMMENT ON COLUMN public.detection_readings.id IS 'Auto-incrementing primary key identifier.';
COMMENT ON COLUMN public.detection_readings.distance_cm IS 'Flame intensity percentage (0.0% to 100.0%) measured by analog IR sensor.';
COMMENT ON COLUMN public.detection_readings.detected IS 'Emergency flag: true if flame / fire detected, false if environment is safe.';
COMMENT ON COLUMN public.detection_readings.sensor_status IS 'Operational status indicator ("Fire Alert", "Safe", "Warning").';
COMMENT ON COLUMN public.detection_readings.created_at IS 'UTC timestamp when the reading was inserted.';

-- 3. Create performance indexes
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
    -- Allow fire status values including Warm (26-50%) as well as legacy values
    sensor_status IN ('Fire Alert', 'Safe', 'Warm', 'Warning', 'Detected', 'Clear', 'No Reading')
);

-- Policy 2: Allow anonymous clients (Frontend Dashboard) to SELECT historical readings
DROP POLICY IF EXISTS "Allow anonymous dashboard read" ON public.detection_readings;
CREATE POLICY "Allow anonymous dashboard read"
ON public.detection_readings
FOR SELECT
TO anon
USING (true);

-- Policy 3: Allow anonymous clients / Dashboard to DELETE / reset readings
DROP POLICY IF EXISTS "Allow anonymous delete" ON public.detection_readings;
CREATE POLICY "Allow anonymous delete"
ON public.detection_readings
FOR DELETE
TO anon
USING (true);

-- 6. Enable Realtime Publications for live dashboard streaming safely
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
