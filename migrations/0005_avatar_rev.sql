-- ETag of the GitHub avatar. The avatar URL does not change when the photo does, so the share card
-- version includes this and is redrawn when it changes. Empty until the owner's page has checked once.
ALTER TABLE profiles ADD COLUMN avatar_rev TEXT NOT NULL DEFAULT '';
