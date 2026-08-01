CREATE TABLE IF NOT EXISTS activation_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'unused',
  machine_code TEXT,
  license_type TEXT NOT NULL DEFAULT 'perpetual',
  offline_grace_days INTEGER NOT NULL DEFAULT 36500,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  activated_at TEXT,
  last_validated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_activation_codes_code
ON activation_codes (code);

CREATE INDEX IF NOT EXISTS idx_activation_codes_machine
ON activation_codes (machine_code);

CREATE TABLE IF NOT EXISTS activation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  machine_code TEXT,
  app_version TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (code_id) REFERENCES activation_codes(id)
);
