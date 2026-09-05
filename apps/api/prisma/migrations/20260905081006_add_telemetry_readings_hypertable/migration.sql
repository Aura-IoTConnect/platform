-- Enable TimescaleDB. On a *fresh* Postgres volume started from the
-- timescale/timescaledb image (see docker-compose.yml / CI), this just
-- works — that image's default config already preloads the extension. On
-- an *existing* volume upgraded from plain postgres:16-alpine, Postgres
-- must be told to preload timescaledb and restarted once, by hand, before
-- this migration will apply — see CLAUDE.md's "Telemetry storage" section
-- for the exact one-time command. Applying this migration without that
-- step fails fast with a clear "extension must be preloaded" error rather
-- than silently doing nothing.
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- create_hypertable requires the partitioning column ("timestamp") to be
-- part of any unique/primary key constraint on the table, so the
-- single-column id primary key becomes a composite (id, timestamp) key —
-- see the TelemetryReading model comment in schema.prisma. id keeps its
-- own uniqueness in practice (cuid()), this widens the *constraint*, not
-- the actual key space.
ALTER TABLE "telemetry_readings" DROP CONSTRAINT "telemetry_readings_pkey";
ALTER TABLE "telemetry_readings" ADD CONSTRAINT "telemetry_readings_pkey" PRIMARY KEY ("id", "timestamp");

-- migrate_data moves any rows already in the table into hypertable chunks;
-- if_not_exists makes this safe to apply against a table TimescaleDB
-- already converted (shouldn't happen via normal migrate, but matches the
-- "verify hands-on, don't assume" caution this whole feature was built with).
SELECT create_hypertable('telemetry_readings', 'timestamp', migrate_data => true, if_not_exists => true);
