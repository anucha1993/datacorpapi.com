-- Polar (polar.sh) as payment provider: order ids are UUIDs, receipts come from Polar's invoice endpoint.
-- Run once:  mysql -h HOST -u USER -p DATABASE < sql/polar_schema.sql
ALTER TABLE billing_invoices
  ADD COLUMN IF NOT EXISTS provider          VARCHAR(20)  NOT NULL DEFAULT '' AFTER checkout_test,   -- polar / lemonsqueezy (ของลิงก์ชำระเงินปัจจุบัน)
  ADD COLUMN IF NOT EXISTS provider_order_id VARCHAR(64)  NOT NULL DEFAULT '' AFTER ls_order_id,     -- Polar order UUID เมื่อชำระแล้ว
  ADD COLUMN IF NOT EXISTS receipt_url       VARCHAR(700) NOT NULL DEFAULT '' AFTER provider_order_id; -- ลิงก์ใบเสร็จ/ใบแจ้งหนี้จาก provider
ALTER TABLE billing_invoices ADD INDEX IF NOT EXISTS ix_provider_order (provider_order_id);
