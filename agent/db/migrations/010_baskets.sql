-- A basket is several stocks in one gift: one payment, one claim link. Each stock is its own gift row and is bought,
-- returned and refunded like any gift. basket_id is the id of the basket's first gift (the lead), which carries the
-- payment and is the id used in the claim link; every gift in the basket, the lead included, has the same basket_id.
ALTER TABLE gifts ADD COLUMN basket_id uuid;
CREATE INDEX gifts_basket_idx ON gifts (basket_id) WHERE basket_id IS NOT NULL;
