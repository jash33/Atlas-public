#!/bin/sh
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  --set=atlas_password="$ATLAS_DATABASE_PASSWORD" \
  --set=temporal_password="$ATLAS_TEMPORAL_PASSWORD" <<'SQL'
CREATE ROLE atlas LOGIN PASSWORD :'atlas_password';
CREATE DATABASE atlas OWNER atlas;
CREATE DATABASE atlas_test OWNER atlas;
CREATE ROLE temporal LOGIN CREATEDB PASSWORD :'temporal_password';
SQL
