-- Voxly v2.0.0 — Initial Schema Migration
-- Run this in the Supabase SQL Editor to set up the database.
--
-- Tables: profiles, transcripts, transcript_shares, api_keys
-- Storage: audio-files bucket
-- All tables have RLS enabled with appropriate policies.

-- ============================================================
-- Shared Functions
-- ============================================================

-- Auto-update updated_at on row modification
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ============================================================
-- Table: profiles
-- ============================================================
-- Extends auth.users with display info. Auto-created on signup.

CREATE TABLE public.profiles (
  id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email         text,
  display_name  text,
  avatar_url    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_profiles_id ON public.profiles(id);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Auto-create profile when a new user signs up
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.profiles (id, email, display_name, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(
      NEW.raw_user_meta_data ->> 'full_name',
      NEW.raw_user_meta_data ->> 'name',
      split_part(NEW.email, '@', 1)
    ),
    COALESCE(NEW.raw_user_meta_data ->> 'avatar_url', NULL)
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Profiles viewable by authenticated users"
  ON public.profiles FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Users update own profile"
  ON public.profiles FOR UPDATE
  TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());


-- ============================================================
-- Table: transcripts
-- ============================================================
-- Core table storing transcript data, metadata, and sharing flags.

CREATE TABLE public.transcripts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Metadata (mirrors extension's transcriptMetadata shape)
  title               text NOT NULL DEFAULT 'Untitled',
  source              text,
  source_type         text CHECK (source_type IN ('url', 'file', 'recording', 'youtube_transcript')),
  uploader            text,
  duration_seconds    integer,
  duration_display    text,
  language            text DEFAULT 'en',
  model               text,
  word_count          integer,
  extraction_method   text,

  -- Transcript content
  full_text           text NOT NULL,
  segments            jsonb DEFAULT '[]'::jsonb,
  speakers            text[] DEFAULT '{}',
  diarization_status  text,

  -- AI-generated content
  summary             text,

  -- Sharing
  is_public           boolean NOT NULL DEFAULT false,
  share_token         text UNIQUE,

  -- Audio file reference (path in Supabase Storage bucket)
  audio_storage_path  text,

  -- Timestamps
  processed_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Performance indexes
CREATE INDEX idx_transcripts_user_id ON public.transcripts(user_id);
CREATE INDEX idx_transcripts_share_token ON public.transcripts(share_token) WHERE share_token IS NOT NULL;
CREATE INDEX idx_transcripts_user_created ON public.transcripts(user_id, created_at DESC);
CREATE INDEX idx_transcripts_full_text_search ON public.transcripts
  USING gin(to_tsvector('english', title || ' ' || COALESCE(full_text, '')));

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.transcripts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- RLS
ALTER TABLE public.transcripts ENABLE ROW LEVEL SECURITY;

-- Owners have full CRUD access to their own transcripts
CREATE POLICY "Owners have full access"
  ON public.transcripts FOR ALL
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Users can read transcripts that have been shared with them
CREATE POLICY "Shared transcripts are readable"
  ON public.transcripts FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.transcript_shares
      WHERE transcript_shares.transcript_id = transcripts.id
        AND transcript_shares.shared_with = auth.uid()
    )
  );

-- Users with write permission on a share can update the transcript
CREATE POLICY "Write-shared transcripts are editable"
  ON public.transcripts FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.transcript_shares
      WHERE transcript_shares.transcript_id = transcripts.id
        AND transcript_shares.shared_with = auth.uid()
        AND transcript_shares.permission = 'write'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.transcript_shares
      WHERE transcript_shares.transcript_id = transcripts.id
        AND transcript_shares.shared_with = auth.uid()
        AND transcript_shares.permission = 'write'
    )
  );

-- Anonymous users can read public transcripts (for share links)
CREATE POLICY "Public transcripts readable via share token"
  ON public.transcripts FOR SELECT
  TO anon
  USING (is_public = true AND share_token IS NOT NULL);


-- ============================================================
-- Table: transcript_shares
-- ============================================================
-- Junction table for user-to-user sharing.

CREATE TABLE public.transcript_shares (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transcript_id   uuid NOT NULL REFERENCES public.transcripts(id) ON DELETE CASCADE,
  shared_by       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  shared_with     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  permission      text NOT NULL DEFAULT 'read' CHECK (permission IN ('read', 'write')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE(transcript_id, shared_with)
);

CREATE INDEX idx_transcript_shares_shared_with ON public.transcript_shares(shared_with);
CREATE INDEX idx_transcript_shares_transcript ON public.transcript_shares(transcript_id);

-- RLS
ALTER TABLE public.transcript_shares ENABLE ROW LEVEL SECURITY;

-- Transcript owners can create, read, update, and delete shares
CREATE POLICY "Owners manage shares"
  ON public.transcript_shares FOR ALL
  TO authenticated
  USING (shared_by = auth.uid())
  WITH CHECK (shared_by = auth.uid());

-- Share recipients can see shares targeting them
CREATE POLICY "Recipients see their shares"
  ON public.transcript_shares FOR SELECT
  TO authenticated
  USING (shared_with = auth.uid());


-- ============================================================
-- Table: api_keys
-- ============================================================
-- Developer API keys for programmatic transcript access.
-- Only the SHA-256 hash is stored; the key is shown once on creation.

CREATE TABLE public.api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key_hash    text NOT NULL,
  key_prefix  text NOT NULL,
  name        text NOT NULL DEFAULT 'Default',
  last_used   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);

CREATE INDEX idx_api_keys_user ON public.api_keys(user_id);
CREATE INDEX idx_api_keys_hash ON public.api_keys(key_hash) WHERE revoked_at IS NULL;

-- RLS
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own API keys"
  ON public.api_keys FOR ALL
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());


-- ============================================================
-- Storage: audio-files bucket
-- ============================================================
-- Private bucket for optional audio file storage.
-- Path convention: {user_id}/{transcript_id}.mp3
-- 100MB file size limit.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'audio-files',
  'audio-files',
  false,
  104857600,
  ARRAY['audio/mpeg', 'audio/mp3', 'audio/webm', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/x-m4a']
);

-- Users can upload files to their own folder
CREATE POLICY "Users upload own audio"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'audio-files'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Users can read their own files
CREATE POLICY "Users read own audio"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'audio-files'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Users can delete their own files
CREATE POLICY "Users delete own audio"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'audio-files'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
