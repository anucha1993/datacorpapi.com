-- Image generation / editing through the AI API key: POST /v1/images/generations · /v1/images/edits (GPT Image).
-- kind = 'image': input = OpenAI image-input price, output = image-output price (USD per 1M tokens), credits from the real usage.
-- A plan includes images when its allowed_models is empty (all) or lists the image model.
--   mysql -h HOST -u USER -p DATABASE < sql/ai_images.sql
INSERT IGNORE INTO ai_models (model, label, kind, input_usd_per_1m, output_usd_per_1m, sort_order) VALUES
  ('gpt-image-2.5-sunburst', 'GPT Image 2.5 Sunburst', 'image', 8, 30, 300),
  ('gpt-image-2.5-flare',    'GPT Image 2.5 Flare',    'image', 8, 30, 301),
  ('gpt-image-2',            'GPT Image 2',            'image', 8, 30, 302),
  ('gpt-image-1-mini',       'GPT Image 1 mini',       'image', 2.5, 8, 303);
