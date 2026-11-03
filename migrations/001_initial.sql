CREATE TABLE idi_datasets (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dataset_key TEXT NOT NULL UNIQUE,
  region TEXT NOT NULL,
  assessment_year INTEGER NOT NULL,
  data_year INTEGER NOT NULL,
  total_score NUMERIC(5, 2) CHECK (total_score BETWEEN 0 AND 100),
  trend_source TEXT NOT NULL DEFAULT '',
  source_sha256 CHAR(64) NOT NULL,
  is_current BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (region, assessment_year, data_year)
);

CREATE UNIQUE INDEX idi_one_current_dataset
  ON idi_datasets (is_current)
  WHERE is_current;

CREATE TABLE idi_aspects (
  dataset_id BIGINT NOT NULL REFERENCES idi_datasets(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  display_order INTEGER NOT NULL CHECK (display_order > 0),
  roman TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  short_title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  score NUMERIC(5, 2) NOT NULL CHECK (score BETWEEN 0 AND 100),
  icon TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (dataset_id, code),
  UNIQUE (dataset_id, display_order)
);

CREATE TABLE idi_trends (
  dataset_id BIGINT NOT NULL REFERENCES idi_datasets(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  value NUMERIC(5, 2) NOT NULL CHECK (value BETWEEN 0 AND 100),
  PRIMARY KEY (dataset_id, year)
);

CREATE TABLE idi_indicators (
  id TEXT PRIMARY KEY,
  dataset_id BIGINT NOT NULL,
  aspect_code TEXT NOT NULL,
  display_order INTEGER NOT NULL CHECK (display_order > 0),
  indicator TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  score NUMERIC(5, 2) NOT NULL CHECK (score BETWEEN 0 AND 100),
  document_path TEXT NOT NULL DEFAULT '',
  document_name TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (dataset_id, aspect_code)
    REFERENCES idi_aspects(dataset_id, code) ON DELETE CASCADE,
  UNIQUE (dataset_id, display_order)
);

CREATE INDEX idi_indicators_dataset_aspect_order
  ON idi_indicators (dataset_id, aspect_code, display_order);

CREATE TABLE idi_audit (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_ip TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL CHECK (action IN ('TAMBAH', 'UBAH', 'HAPUS')),
  detail TEXT NOT NULL
);
