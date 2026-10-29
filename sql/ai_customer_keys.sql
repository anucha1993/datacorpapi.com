-- Per-customer OpenAI key for the AI gateway (e.g. one OpenAI Project per customer for separate spend/limits).
-- Stored encrypted (lib/secretbox.js, AES-256-GCM); empty = use OPENAI_API_KEY from .env.
--   mysql -h HOST -u USER -p DATABASE < sql/ai_customer_keys.sql
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS openai_key_enc  TEXT         NULL;
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS openai_key_hint VARCHAR(40)  NOT NULL DEFAULT '';
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS openai_key_set_at DATETIME   NULL;
