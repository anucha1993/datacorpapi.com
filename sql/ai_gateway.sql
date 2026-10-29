-- AI gateway (OpenAI-compatible /v1/chat/completions): model price list + per-plan model limits.
-- Run once after platform_schema.sql:
--   mysql -h HOST -u USER -p DATABASE < sql/ai_gateway.sql
--
-- Customers are charged in credits: 1 credit = ฿0.001 of upstream (OpenAI) cost at AI_USD_THB.
--   credits = ceil((prompt_tokens × input price + completion_tokens × output price) / 1,000,000 × AI_USD_THB × 1000)

CREATE TABLE IF NOT EXISTS ai_models (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  model             VARCHAR(100)  NOT NULL,                -- exact OpenAI model id, e.g. gpt-4o-mini
  label             VARCHAR(120)  NOT NULL DEFAULT '',
  input_usd_per_1m  DECIMAL(10,4) NOT NULL DEFAULT 0,      -- OpenAI price, USD per 1M input tokens
  output_usd_per_1m DECIMAL(10,4) NOT NULL DEFAULT 0,      -- OpenAI price, USD per 1M output tokens
  is_active         TINYINT(1)    NOT NULL DEFAULT 1,
  sort_order        INT           NOT NULL DEFAULT 0,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_model (model)
) ENGINE=InnoDB;

-- '' = every active model; otherwise a comma list of ai_models.model
ALTER TABLE product_plans ADD COLUMN IF NOT EXISTS allowed_models VARCHAR(1000) NOT NULL DEFAULT '' AFTER features;
-- cap on max_tokens / max_completion_tokens per request, 0 = no cap
ALTER TABLE product_plans ADD COLUMN IF NOT EXISTS max_output_tokens INT UNSIGNED NOT NULL DEFAULT 0 AFTER allowed_models;

-- Starter price list (check https://openai.com/api/pricing and edit in Admin → AI models)
INSERT IGNORE INTO ai_models (model, label, input_usd_per_1m, output_usd_per_1m, sort_order) VALUES
  ('gpt-4o-mini',  'GPT-4o mini',  0.15, 0.60, 10),
  ('gpt-4.1-nano', 'GPT-4.1 nano', 0.10, 0.40, 20),
  ('gpt-4.1-mini', 'GPT-4.1 mini', 0.40, 1.60, 30),
  ('gpt-5-nano',   'GPT-5 nano',   0.05, 0.40, 40),
  ('gpt-5-mini',   'GPT-5 mini',   0.25, 2.00, 50),
  ('gpt-4.1',      'GPT-4.1',      2.00, 8.00, 60),
  ('gpt-4o',       'GPT-4o',       2.50, 10.00, 70),
  ('gpt-5',        'GPT-5',        1.25, 10.00, 80);
