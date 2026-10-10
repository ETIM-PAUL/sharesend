-- Sender's choice for an unclaimed or cancelled gift: get the stock back, or have it sold and get USDT.
ALTER TABLE gifts ADD COLUMN return_as text NOT NULL DEFAULT 'stock' CHECK (return_as IN ('stock', 'usdt'));

-- The sell-back path adds steps: vault → Agentic Wallet (to_wallet), the sale (sell), proceeds → vault
-- (proceeds), vault → sender (cashout), and a fallback that sends unsold stock back to the vault (unwind).
ALTER TABLE exec_records DROP CONSTRAINT exec_records_kind_check;
ALTER TABLE exec_records ADD CONSTRAINT exec_records_kind_check CHECK (
  kind IN ('forward', 'swap', 'vault_send', 'sweep', 'claim', 'return', 'refund', 'to_wallet', 'sell', 'proceeds', 'cashout', 'unwind'));
