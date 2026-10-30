#!/bin/bash
# Spins up a throwaway Postgres 16, applies the migrations, runs the row-level-security tests.
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
PGBIN=/usr/lib/postgresql/16/bin
D=$(mktemp -d)
chown postgres "$D" 2>/dev/null || true
run() { if [ "$(id -u)" = 0 ]; then su postgres -c "$*"; else bash -c "$*"; fi; }
run "$PGBIN/initdb -D $D/data -A trust -U postgres >/dev/null"
run "$PGBIN/pg_ctl -D $D/data -o '-k $D -p 54339 -c listen_addresses=' -l $D/log start >/dev/null"
trap "run '$PGBIN/pg_ctl -D $D/data stop -m fast >/dev/null'; rm -rf $D" EXIT
P="psql -h $D -p 54339 -U postgres -v ON_ERROR_STOP=1 -q"
$P -c "create database seo"
$P -d seo -f "$ROOT/tests/sql/supabase_stub.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do $P -d seo -f "$f"; $P -d seo -f "$f"; done   # twice: must be re-runnable
$P -d seo -f "$ROOT/tests/sql/foundation_test.sql"
echo "SQL TESTS PASSED"
