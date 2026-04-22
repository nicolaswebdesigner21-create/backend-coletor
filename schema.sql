CREATE TABLE IF NOT EXISTS failures (
  id SERIAL PRIMARY KEY,
  machine TEXT NOT NULL,
  product TEXT NOT NULL,
  problem TEXT NOT NULL,
  cause TEXT NOT NULL,
  solution TEXT NOT NULL,
  operator TEXT NOT NULL,
  maintenance TEXT,
  tempo_perdido_min INTEGER DEFAULT 0,
  status TEXT DEFAULT 'aberta',
  resolved_at TIMESTAMP,
  resolved_shift TEXT,
  resolved_by_role TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
