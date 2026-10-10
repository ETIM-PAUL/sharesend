-- Autonomous jobs (Phase 10) and the agent's on-chain identity.

-- One row per job run, so /agent can show what ran, when, and what it found.
CREATE TABLE job_runs (
  id           bigserial PRIMARY KEY,
  job          text NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  ok           boolean,
  summary      text,
  detail       jsonb
);
CREATE INDEX job_runs_job_idx ON job_runs (job, started_at DESC);

-- ERC-8004 identity registrations (one per network).
CREATE TABLE agent_identity (
  network        text PRIMARY KEY,           -- bsc-mainnet | bsc-testnet
  agent_id       bigint NOT NULL,
  owner          text NOT NULL,
  registry       text NOT NULL,
  register_tx    text NOT NULL,
  agent_uri      text NOT NULL,
  registered_at  timestamptz NOT NULL DEFAULT now()
);
