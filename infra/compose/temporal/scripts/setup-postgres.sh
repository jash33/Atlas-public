#!/bin/sh
set -eu

: "${POSTGRES_SEEDS:?POSTGRES_SEEDS is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"

setup_database() {
  database="$1"
  schema_directory="$2"

  if temporal-sql-tool --plugin postgres12 --ep "$POSTGRES_SEEDS" \
    -u "$POSTGRES_USER" -p "${DB_PORT:-5432}" --db "$database" validate-health
  then
    temporal-sql-tool --plugin postgres12 --ep "$POSTGRES_SEEDS" \
      -u "$POSTGRES_USER" -p "${DB_PORT:-5432}" --db "$database" \
      update-schema -d "$schema_directory"
    return
  fi

  temporal-sql-tool --plugin postgres12 --ep "$POSTGRES_SEEDS" \
    -u "$POSTGRES_USER" -p "${DB_PORT:-5432}" --db "$database" create || true
  temporal-sql-tool --plugin postgres12 --ep "$POSTGRES_SEEDS" \
    -u "$POSTGRES_USER" -p "${DB_PORT:-5432}" --db "$database" \
    setup-schema -v 0.0
  temporal-sql-tool --plugin postgres12 --ep "$POSTGRES_SEEDS" \
    -u "$POSTGRES_USER" -p "${DB_PORT:-5432}" --db "$database" \
    update-schema -d "$schema_directory"
}

until nc -z -w 10 "$POSTGRES_SEEDS" "${DB_PORT:-5432}"; do
  sleep 1
done

setup_database temporal /etc/temporal/schema/postgresql/v12/temporal/versioned
setup_database temporal_visibility /etc/temporal/schema/postgresql/v12/visibility/versioned
