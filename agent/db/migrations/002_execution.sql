-- Execution bookkeeping (Phase 6).

-- Dry-run gifts (LIVE_TRADING=false) carry synthetic tx hashes; keep them out of caps and reconciliation.
ALTER TABLE gifts ADD COLUMN dry_run boolean NOT NULL DEFAULT false;

-- One row per execution step per gift: the idempotency key is (gift_id, kind).
-- A row is written BEFORE the side effect, so a retry adopts the earlier attempt instead of repeating it.
--   vault steps (forward, claim, return, refund): ref = tx hash, raw_tx = signed tx (public once broadcast)
--   Agentic Wallet steps (swap, vault_send, sweep): ref = baw orderId or tx hash, set right after submit
CREATE TABLE exec_records (
  gift_id     uuid NOT NULL REFERENCES gifts (id),
  kind        text NOT NULL CHECK (kind IN ('forward', 'swap', 'vault_send', 'sweep', 'claim', 'return', 'refund')),
  ref         text,
  raw_tx      text,
  nonce       integer,
  status      text NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'submitted', 'confirmed', 'failed')),
  amount      numeric(78, 0),
  detail      jsonb,
  dry_run     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (gift_id, kind)
);
CREATE INDEX exec_records_nonce_idx ON exec_records (nonce) WHERE nonce IS NOT NULL;
