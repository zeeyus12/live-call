-- Run once in the Supabase SQL editor for the live-call project. Safe to re-run.
-- Adds the vault secret-id column for the user's own Xmax API key.
alter table video_call_settings
  add column if not exists xmax_api_key_secret_id uuid;
