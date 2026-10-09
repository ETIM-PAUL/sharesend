-- Signed sender actions (cancel, new claim link): each signed message can be used once.
CREATE TABLE used_signatures (
  hash  text PRIMARY KEY,   -- sha256 of the signed message + signature
  at    timestamptz NOT NULL DEFAULT now()
);
