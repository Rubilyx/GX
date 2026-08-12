PRAGMA foreign_keys = ON;

CREATE TABLE repositories (
  id TEXT PRIMARY KEY NOT NULL,
  github_id TEXT NOT NULL UNIQUE,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  html_url TEXT NOT NULL,
  description TEXT,
  homepage_url TEXT,
  default_branch TEXT NOT NULL,
  primary_language TEXT,
  stars INTEGER NOT NULL DEFAULT 0 CHECK (stars >= 0),
  forks INTEGER NOT NULL DEFAULT 0 CHECK (forks >= 0),
  license_spdx TEXT,
  topics_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(topics_json) AND json_type(topics_json) = 'array'),
  github_updated_at TEXT NOT NULL,
  readme_sha TEXT,
  readme_status TEXT NOT NULL CHECK (readme_status IN ('present', 'truncated', 'missing', 'nontext', 'unavailable')),
  source_refreshed_at INTEGER NOT NULL,
  summary TEXT,
  problem TEXT,
  values_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(values_json) AND json_type(values_json) = 'array' AND json_array_length(values_json) <= 3),
  audience TEXT,
  cautions TEXT,
  primary_category TEXT,
  analysis_status TEXT NOT NULL CHECK (analysis_status IN ('pending', 'ready', 'error')),
  analysis_error_code TEXT,
  analysis_model TEXT,
  prompt_version TEXT,
  analysis_started_at INTEGER,
  analyzed_at INTEGER,
  personal_note TEXT NOT NULL DEFAULT '' CHECK (length(personal_note) <= 4000),
  analysis_generation INTEGER NOT NULL DEFAULT 1 CHECK (analysis_generation >= 1),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX repositories_order_idx ON repositories (created_at DESC, id DESC);
CREATE INDEX repositories_category_order_idx ON repositories (primary_category, created_at DESC, id DESC);

CREATE TABLE repository_tags (
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  normalized_tag TEXT NOT NULL CHECK (
    length(normalized_tag) BETWEEN 1 AND 32
    AND normalized_tag NOT GLOB '*[^a-z0-9-]*'
    AND normalized_tag NOT LIKE '-%'
    AND normalized_tag NOT LIKE '%-'
    AND normalized_tag NOT LIKE '%--%'
  ),
  PRIMARY KEY (repository_id, normalized_tag)
);

CREATE INDEX repository_tags_filter_idx ON repository_tags (normalized_tag, repository_id);

CREATE TRIGGER repository_tags_limit
BEFORE INSERT ON repository_tags
WHEN (SELECT COUNT(*) FROM repository_tags WHERE repository_id = NEW.repository_id) >= 5
BEGIN
  SELECT RAISE(ABORT, 'repository_tag_limit');
END;

CREATE TABLE auth_attempts (
  attempt_key TEXT PRIMARY KEY NOT NULL,
  window_started_at INTEGER NOT NULL,
  failures INTEGER NOT NULL CHECK (failures >= 0),
  locked_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE INDEX auth_attempts_updated_idx ON auth_attempts (updated_at);

CREATE TABLE telemetry_daily (
  day TEXT NOT NULL,
  release_id TEXT NOT NULL,
  route_template TEXT NOT NULL,
  event_type TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  value_bucket TEXT NOT NULL,
  dimension TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1 CHECK (count >= 1),
  PRIMARY KEY (day, release_id, route_template, event_type, metric_name, value_bucket, dimension)
);

CREATE INDEX telemetry_daily_day_idx ON telemetry_daily (day);
