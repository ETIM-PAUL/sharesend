-- Gift ledger. Lifecycle in BUILD_PLAN.md section 6; transitions enforced in agent/gifts/states.ts.

CREATE TABLE gifts (
  id                    uuid PRIMARY KEY,
  status                text NOT NULL CHECK (status IN (
                          'AWAITING_PAYMENT', 'PAID', 'BUYING', 'READY', 'CLAIMING', 'CLAIMED',
                          'EXPIRED', 'REFUNDING', 'REFUNDED', 'FAILED', 'RETURNING', 'RETURNED')),
  -- Progress inside BUYING, so a retry resumes where it stopped.
  step                  text CHECK (step IN ('forwarded', 'swapped', 'in_vault')),

  sender_address        text NOT NULL,
  sender_name           text NOT NULL,
  recipient_name        text NOT NULL,
  message               text NOT NULL DEFAULT '',

  ticker                text NOT NULL,
  issuer                text NOT NULL,
  token_address         text NOT NULL,
  token_decimals        integer NOT NULL,
  -- Raw token units. quoted_* from the quote; token_amount is what actually reached the vault.
  quoted_token_amount   numeric(78, 0) NOT NULL CHECK (quoted_token_amount > 0),
  token_amount          numeric(78, 0) CHECK (token_amount > 0),
  usd_cost              numeric(12, 2) NOT NULL CHECK (usd_cost > 0),
  fee_usd               numeric(12, 2) NOT NULL CHECK (fee_usd >= 0),
  quote_id              text,

  -- SHA-256 of the claim code. The code itself is never stored or logged.
  claim_code_hash       bytea NOT NULL UNIQUE CHECK (octet_length(claim_code_hash) = 32),
  claim_address         text,

  payment_tx            text,
  forward_tx            text,
  buy_tx                text,
  vault_tx              text,
  claim_tx              text,
  return_tx             text,
  refund_tx             text,
  failure_reason        text,

  payment_expires_at    timestamptz NOT NULL,
  claim_expires_at      timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  paid_at               timestamptz,
  ready_at              timestamptz,
  claimed_at            timestamptz,
  returned_at           timestamptz,
  refunded_at           timestamptz,

  -- Once stock is in the vault, the amount and claim expiry must be known.
  CONSTRAINT ready_has_amount CHECK (
    status NOT IN ('READY', 'CLAIMING', 'CLAIMED', 'RETURNING', 'RETURNED')
    OR (token_amount IS NOT NULL AND claim_expires_at IS NOT NULL)),
  -- step is set during BUYING and kept afterwards as a record of how far the buy got.
  CONSTRAINT no_step_before_buying CHECK (step IS NULL OR status NOT IN ('AWAITING_PAYMENT', 'PAID', 'EXPIRED')),
  CONSTRAINT claimed_has_address CHECK (status NOT IN ('CLAIMING', 'CLAIMED') OR claim_address IS NOT NULL)
);

CREATE INDEX gifts_status_idx ON gifts (status);
CREATE INDEX gifts_claim_expiry_idx ON gifts (claim_expires_at) WHERE status = 'READY';
CREATE INDEX gifts_created_idx ON gifts (created_at);

-- Audit trail: one row per status or step change.
CREATE TABLE gift_events (
  id          bigserial PRIMARY KEY,
  gift_id     uuid NOT NULL REFERENCES gifts (id),
  from_status text,
  to_status   text NOT NULL,
  step        text,
  detail      jsonb,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gift_events_gift_idx ON gift_events (gift_id, at);

-- Claim attempts, for rate limiting per IP and per gift. IPs are stored hashed.
CREATE TABLE claim_attempts (
  id        bigserial PRIMARY KEY,
  gift_id   uuid,
  ip_hash   text NOT NULL,
  success   boolean NOT NULL,
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX claim_attempts_ip_idx ON claim_attempts (ip_hash, at);
CREATE INDEX claim_attempts_gift_idx ON claim_attempts (gift_id, at);
