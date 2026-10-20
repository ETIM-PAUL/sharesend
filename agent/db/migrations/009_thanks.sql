-- A one-time thank-you from the recipient, written after claiming. It can be set once and never changed.
ALTER TABLE gifts
  ADD COLUMN thanks_note text,
  ADD COLUMN thanked_at  timestamptz,
  ADD CONSTRAINT thanks_note_shape CHECK (
    (thanks_note IS NULL) = (thanked_at IS NULL)
    AND (thanks_note IS NULL OR (char_length(thanks_note) BETWEEN 1 AND 280))
  );
