-- OCR (Google Vision) through the AI API key: /v1/vision/{images|files}:annotate, metered in credits per page.
-- A plan includes OCR when its allowed_models is empty (all) or lists google-vision-ocr.
--   mysql -h HOST -u USER -p DATABASE < sql/ai_vision.sql
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS kind VARCHAR(10) NOT NULL DEFAULT 'chat' AFTER label;  -- chat | ocr

-- Google Vision DOCUMENT_TEXT_DETECTION ≈ $1.50 per 1,000 pages → stored as USD per 1M units (input price)
INSERT IGNORE INTO ai_models (model, label, kind, input_usd_per_1m, output_usd_per_1m, sort_order)
  VALUES ('google-vision-ocr', 'Google Vision OCR (per page)', 'ocr', 1500, 0, 200);
