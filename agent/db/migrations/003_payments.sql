-- Sender payments via B402 (Phase 7) and the agent's self-funding ledger.

-- The exact x402 PaymentRequirements offered for this gift (the 402 `accepts`). A payment must match one exactly.
ALTER TABLE gifts ADD COLUMN payment_requirements jsonb;
-- The claim code is issued once, after payment. The hash stored at creation belongs to a code nobody has.
ALTER TABLE gifts ADD COLUMN claim_code_issued boolean NOT NULL DEFAULT false;

-- One payment per gift. Written before settlement so concurrent requests can't both settle.
CREATE TABLE payments (
  gift_id         uuid PRIMARY KEY REFERENCES gifts (id),
  payload_hash    text NOT NULL,          -- sha256 of the signed payload; settle is idempotent on it
  payer           text NOT NULL,
  asset           text NOT NULL,
  method          text NOT NULL,          -- eip3009 | permit2-exact
  amount          numeric(78, 0) NOT NULL,
  status          text NOT NULL CHECK (status IN ('settling', 'settled', 'failed', 'verified_dry_run')),
  settle_tx       text,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Self-funding ledger: what the agent earns (fees) and spends (gas, runtime, paid APIs).
CREATE TABLE agent_ledger (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('fee_income', 'gas', 'runtime', 'api')),
  usd         numeric(14, 6),             -- null when only the native amount is known
  native_wei  numeric(78, 0),             -- gas paid in BNB
  gift_id     uuid REFERENCES gifts (id),
  tx          text,
  note        text,
  dry_run     boolean NOT NULL DEFAULT false,
  at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, tx)
);
