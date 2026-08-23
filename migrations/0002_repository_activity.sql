ALTER TABLE repositories ADD COLUMN github_pushed_at TEXT;
ALTER TABLE repositories ADD COLUMN activity_refreshed_at INTEGER;
ALTER TABLE repositories ADD COLUMN activity_refresh_generation INTEGER NOT NULL DEFAULT 0;
