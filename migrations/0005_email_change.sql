-- ============================================================================
-- Migration 0005: email change links (spec §8.3 POST /api/me/email-change,
-- §11 email_change_confirm; task S9).
--
-- A sign-in link only needs the address; an email-change link must also know
-- whose account changes, so magic_links gains the user it was issued to.
-- V2's membership tables move to 0006.
-- ============================================================================

ALTER TABLE magic_links ADD COLUMN user_id TEXT REFERENCES users(id);
CREATE INDEX idx_magic_links_user ON magic_links(user_id);
