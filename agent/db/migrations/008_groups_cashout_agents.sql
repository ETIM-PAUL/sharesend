-- Three additions: recipient cash-out, group gifts, and gifts sent by other agents over x402.

-- Recipient cash-out: at claim time the recipient takes the shares, or has them sold and gets USDT.
ALTER TABLE gifts ADD COLUMN claim_as text NOT NULL DEFAULT 'stock' CHECK (claim_as IN ('stock', 'usdt'));

-- Where a gift came from: the web app, or another agent paying the x402 endpoint directly.
ALTER TABLE gifts ADD COLUMN channel text NOT NULL DEFAULT 'web' CHECK (channel IN ('web', 'agent'));

-- Group gifts: several people chip in, then one gift is bought for the recipient.
--   OPEN       collecting contributions (each one is a gift row with group_role = 'contribution', paid via B402)
--   POOLED     closed: the paid contributions moved into one gift row (group_role = 'pool') that is bought and claimed
--   CANCELLED  closed with nothing bought: every paid contribution is refunded to whoever paid it
CREATE TABLE gift_groups (
  id                 uuid PRIMARY KEY,
  status             text NOT NULL CHECK (status IN ('OPEN', 'POOLED', 'CANCELLED')),
  organizer_address  text NOT NULL,
  organizer_name     text NOT NULL,
  recipient_name     text NOT NULL,
  message            text NOT NULL DEFAULT '',
  ticker             text NOT NULL,
  company_name       text,
  closes_at          timestamptz NOT NULL,
  pooled_gift_id     uuid REFERENCES gifts (id),
  close_reason       text,
  dry_run            boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pooled_has_gift CHECK (status <> 'POOLED' OR pooled_gift_id IS NOT NULL)
);
CREATE INDEX gift_groups_open_idx ON gift_groups (closes_at) WHERE status = 'OPEN';

ALTER TABLE gifts
  ADD COLUMN group_id    uuid REFERENCES gift_groups (id),
  ADD COLUMN group_role  text CHECK (group_role IN ('contribution', 'pool')),
  ADD CONSTRAINT group_role_needs_group CHECK ((group_id IS NULL) = (group_role IS NULL));
CREATE INDEX gifts_group_idx ON gifts (group_id) WHERE group_id IS NOT NULL;
CREATE UNIQUE INDEX gifts_one_pool_per_group ON gifts (group_id) WHERE group_role = 'pool';

-- POOLED: a paid contribution whose money now belongs to the group's gift. If that gift's buy fails, each
-- contribution goes POOLED → REFUNDING and is refunded to its own payer.
ALTER TABLE gifts DROP CONSTRAINT gifts_status_check;
ALTER TABLE gifts ADD CONSTRAINT gifts_status_check CHECK (status IN (
  'AWAITING_PAYMENT', 'PAID', 'BUYING', 'READY', 'CLAIMING', 'CLAIMED',
  'EXPIRED', 'REFUNDING', 'REFUNDED', 'FAILED', 'RETURNING', 'RETURNED', 'POOLED'));
