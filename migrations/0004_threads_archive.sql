PRAGMA foreign_keys = ON;

CREATE TABLE threads_authors (
  threads_user_id TEXT PRIMARY KEY NOT NULL,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  profile_media_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (profile_media_status IN ('pending', 'ready', 'error')),
  profile_r2_key TEXT,
  profile_content_type TEXT,
  profile_etag TEXT,
  profile_bytes INTEGER CHECK (profile_bytes IS NULL OR profile_bytes >= 0),
  profile_error_code TEXT,
  profile_refreshed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE threads_posts (
  id TEXT PRIMARY KEY NOT NULL,
  shortcode TEXT NOT NULL UNIQUE,
  threads_media_id TEXT UNIQUE,
  submitted_url TEXT NOT NULL,
  canonical_url TEXT,
  root_author_id TEXT REFERENCES threads_authors(threads_user_id),
  status TEXT NOT NULL CHECK (status IN ('pending','collecting','ready','partial','error','deleting')),
  error_code TEXT,
  sync_generation INTEGER NOT NULL DEFAULT 1 CHECK (sync_generation >= 1),
  last_successful_sync_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX threads_posts_order_idx ON threads_posts(created_at DESC, id DESC);
CREATE INDEX threads_posts_status_order_idx ON threads_posts(status, created_at DESC, id DESC);
CREATE INDEX threads_posts_author_idx ON threads_posts(root_author_id, id);

CREATE TABLE threads_entries (
  id TEXT PRIMARY KEY NOT NULL,
  threads_post_id TEXT NOT NULL REFERENCES threads_posts(id) ON DELETE CASCADE,
  source_media_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('root','author_reply','quote')),
  parent_entry_id TEXT REFERENCES threads_entries(id) ON DELETE CASCADE,
  source_parent_media_id TEXT,
  author_id TEXT NOT NULL REFERENCES threads_authors(threads_user_id),
  text TEXT NOT NULL DEFAULT '', permalink TEXT, published_at TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('TEXT_POST','IMAGE','VIDEO','CAROUSEL_ALBUM','REPOST_FACADE')),
  alt_text TEXT, nested_quote_permalink TEXT,
  quoted_post_id TEXT,
  quote_status TEXT NOT NULL DEFAULT 'none'
    CHECK (quote_status IN ('none','pending','ready','error')),
  quote_error_code TEXT,
  first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK ((kind = 'quote' AND parent_entry_id IS NOT NULL) OR (kind != 'quote' AND parent_entry_id IS NULL)),
  CHECK (
    (kind = 'quote' AND quoted_post_id IS NULL
      AND quote_status = 'none' AND quote_error_code IS NULL)
    OR
    (kind IN ('root','author_reply') AND (
      (quoted_post_id IS NULL AND quote_status = 'none' AND quote_error_code IS NULL)
      OR
      (quoted_post_id IS NOT NULL AND quote_status IN ('pending','ready')
        AND quote_error_code IS NULL)
      OR
      (quoted_post_id IS NOT NULL AND quote_status = 'error'
        AND quote_error_code IS NOT NULL AND length(quote_error_code) > 0)
    ))
  )
);
CREATE TRIGGER threads_entries_validate_parent_insert
BEFORE INSERT ON threads_entries
FOR EACH ROW
WHEN NEW.kind = 'quote'
  AND NOT EXISTS (
    SELECT 1 FROM threads_entries parent
    WHERE parent.id = NEW.parent_entry_id
      AND parent.threads_post_id = NEW.threads_post_id
      AND parent.kind IN ('root', 'author_reply')
  )
BEGIN
  SELECT RAISE(ABORT, 'threads_entry_invalid_parent');
END;
CREATE TRIGGER threads_entries_validate_parent_update
BEFORE UPDATE OF threads_post_id, kind, parent_entry_id ON threads_entries
FOR EACH ROW
WHEN (NEW.kind = 'quote' AND NOT EXISTS (
        SELECT 1 FROM threads_entries parent
        WHERE parent.id = NEW.parent_entry_id
          AND parent.threads_post_id = NEW.threads_post_id
          AND parent.kind IN ('root', 'author_reply')
      ))
  OR (NEW.kind NOT IN ('root', 'author_reply') AND EXISTS (
        SELECT 1 FROM threads_entries child
        WHERE child.parent_entry_id = OLD.id AND child.kind = 'quote'
      ))
  OR (NEW.threads_post_id <> OLD.threads_post_id AND EXISTS (
        SELECT 1 FROM threads_entries child
        WHERE child.parent_entry_id = OLD.id
          AND child.kind = 'quote'
          AND child.threads_post_id <> NEW.threads_post_id
      ))
BEGIN
  SELECT RAISE(ABORT, 'threads_entry_invalid_parent');
END;
CREATE UNIQUE INDEX threads_entries_primary_source_idx ON threads_entries(threads_post_id, source_media_id) WHERE kind IN ('root','author_reply');
CREATE UNIQUE INDEX threads_entries_quote_source_idx ON threads_entries(threads_post_id, parent_entry_id, source_media_id) WHERE kind = 'quote';
CREATE INDEX threads_entries_reply_order_idx ON threads_entries(threads_post_id, published_at, source_media_id) WHERE kind = 'author_reply';

CREATE TABLE threads_links (
  id TEXT PRIMARY KEY NOT NULL,
  entry_id TEXT NOT NULL REFERENCES threads_entries(id) ON DELETE CASCADE,
  url TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('body','attachment')),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0), UNIQUE(entry_id, url)
);

CREATE TABLE threads_media (
  id TEXT PRIMARY KEY NOT NULL,
  entry_id TEXT NOT NULL REFERENCES threads_entries(id) ON DELETE CASCADE,
  source_media_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image','video','video_thumbnail')),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0), alt_text TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','error')),
  r2_key TEXT, content_type TEXT,
  bytes INTEGER CHECK (bytes IS NULL OR bytes >= 0), etag TEXT, error_code TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(entry_id, source_media_id, kind, ordinal)
);
CREATE INDEX threads_media_entry_status_idx ON threads_media(entry_id, status, ordinal);

CREATE TABLE threads_sync_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  threads_post_id TEXT NOT NULL REFERENCES threads_posts(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  status TEXT NOT NULL CHECK (status IN ('queued','resolving','collecting','media_pending','ready','partial','error')),
  profile_cursor TEXT, conversation_cursor TEXT,
  pending_quote_count INTEGER NOT NULL DEFAULT 0 CHECK (pending_quote_count >= 0),
  expected_entry_count INTEGER NOT NULL DEFAULT 0 CHECK (expected_entry_count >= 0),
  expected_media_count INTEGER NOT NULL DEFAULT 0 CHECK (expected_media_count >= 0),
  ready_media_count INTEGER NOT NULL DEFAULT 0 CHECK (ready_media_count >= 0),
  failed_media_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_media_count >= 0),
  error_code TEXT, queued_at INTEGER NOT NULL, started_at INTEGER, content_completed_at INTEGER,
  completed_at INTEGER, updated_at INTEGER NOT NULL,
  UNIQUE(threads_post_id, generation)
);
CREATE INDEX threads_sync_jobs_status_idx ON threads_sync_jobs(status, updated_at, id);

CREATE TABLE threads_oauth_credentials (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  provider_user_id TEXT NOT NULL, encrypted_access_token TEXT NOT NULL, token_nonce TEXT NOT NULL,
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json) AND json_type(scopes_json) = 'array'),
  expires_at INTEGER NOT NULL, refreshed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
