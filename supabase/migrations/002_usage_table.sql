-- Usage tracking for cloud transcription quotas
CREATE TABLE public.usage (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  period    text NOT NULL,  -- 'YYYY-MM'
  count     integer NOT NULL DEFAULT 0,
  UNIQUE(user_id, period)
);

ALTER TABLE public.usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own usage" ON public.usage
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- Allow Edge Functions to increment usage (service_role bypasses RLS)
-- No INSERT/UPDATE policy needed — Edge Functions use service_role key

-- Add is_premium flag to profiles for server-side quota checks
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_premium boolean DEFAULT false;
