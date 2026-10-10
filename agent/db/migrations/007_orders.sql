-- Conditional orders: "buy this gift when the price has dropped X% (by a deadline)". The gift is paid up front and
-- waits in PAID; the price watcher buys it when the trigger is reached, or refunds it at the deadline.
ALTER TABLE gifts
  ADD COLUMN order_drop_pct      numeric(6, 3) CHECK (order_drop_pct > 0 AND order_drop_pct <= 50),
  ADD COLUMN order_baseline      numeric(18, 6),   -- price per share when the order was placed
  ADD COLUMN order_trigger       numeric(18, 6),   -- buy when the price per share is at or below this
  ADD COLUMN order_deadline      timestamptz,
  ADD COLUMN order_text          text,             -- what the sender asked for, in their own words (chat)
  ADD COLUMN order_triggered_at  timestamptz,      -- set once the condition was met; from then on it's a normal buy
  ADD COLUMN order_last_price    numeric(18, 6),   -- last price the watcher saw
  ADD COLUMN order_checked_at    timestamptz,
  ADD CONSTRAINT order_is_complete CHECK (
    (order_drop_pct IS NULL AND order_baseline IS NULL AND order_trigger IS NULL AND order_deadline IS NULL)
    OR (order_drop_pct IS NOT NULL AND order_baseline IS NOT NULL AND order_trigger IS NOT NULL AND order_deadline IS NOT NULL));

CREATE INDEX gifts_waiting_orders_idx ON gifts (order_deadline) WHERE status = 'PAID' AND order_trigger IS NOT NULL AND order_triggered_at IS NULL;
