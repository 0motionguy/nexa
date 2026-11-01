#!/usr/bin/env bash
#
# scripts/restore-drill.sh — separate-container Postgres restore drill.
#
# Wave 18 Lane J. This boots a fresh timescale/timescaledb-ha:pg17
# container on 127.0.0.1:5444 and proves cold-restore from zero.
#
# 2026-07-16 (NEXA Phase F): the drill now ALSO restores the latest "maze"
# logical dump (money-critical NEXA data — nb_* tables) and verifies row
# counts plus balance/idempotency invariants, not just toolbox tb_* tables.
#
# Run on the VPS (or any docker host with /opt/toolbox-backups/ mounted):
#
#   bash /opt/toolbox/scripts/restore-drill.sh
#
# Output: PASS / FAIL plus row-count diff vs production.
# Tear-down: always (via trap EXIT) — even on error.
#
# Anchor: docs/RESTORE_DRILL.md.

set -euo pipefail

# --- config ----------------------------------------------------------------
BACKUP_DIR="${BACKUP_DIR:-/opt/toolbox-backups}"
DRILL_CONTAINER="${DRILL_CONTAINER:-pg-restore-drill}"
DRILL_PORT="${DRILL_PORT:-5444}"
DRILL_IMAGE="${DRILL_IMAGE:-timescale/timescaledb-ha:pg17}"
DRILL_PASSWORD="${DRILL_PASSWORD:-drilltest$(date +%s)}"   # ephemeral
PROD_CONTAINER="${PROD_CONTAINER:-toolbox-postgres-1}"
MAZE_DATABASE="${MAZE_DATABASE:-maze}"
DISCORD_WEBHOOK_URL="${DISCORD_WEBHOOK_URL:-}"

# --- locate latest dumps ----------------------------------------------------
latest_dump() {
  find "$BACKUP_DIR" -type f -name "$1" -printf "%T@ %p\n" 2>/dev/null \
    | sort -nr \
    | head -1 \
    | cut -d " " -f2-
}

LATEST=$(latest_dump "toolbox-postgres-*.dump")
if [ -z "$LATEST" ]; then
  echo "FAIL: no toolbox-postgres-*.dump file under $BACKUP_DIR"
  exit 1
fi

MAZE_LATEST=$(latest_dump "${MAZE_DATABASE}-postgres-*.dump")
if [ -z "$MAZE_LATEST" ]; then
  echo "FAIL: no ${MAZE_DATABASE}-postgres-*.dump file under $BACKUP_DIR — money-DB hourly dump missing (backup.sh EXTRA_DATABASES)."
  exit 1
fi

echo "Drill container: $DRILL_CONTAINER"
echo "Drill port:      127.0.0.1:$DRILL_PORT"
echo "Drill image:     $DRILL_IMAGE"
echo "Latest dump:     $LATEST"
echo "Dump size:       $(stat -c %s "$LATEST" 2>/dev/null || stat -f %z "$LATEST") bytes"
echo "Maze dump:       $MAZE_LATEST"
echo "Maze dump size:  $(stat -c %s "$MAZE_LATEST" 2>/dev/null || stat -f %z "$MAZE_LATEST") bytes"

# --- tear-down trap (ALWAYS) -----------------------------------------------
cleanup() {
  docker rm -f "$DRILL_CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# Clean any prior drill leftover before starting fresh
docker rm -f "$DRILL_CONTAINER" >/dev/null 2>&1 || true

# --- boot container --------------------------------------------------------
docker run -d --name "$DRILL_CONTAINER" \
  -e POSTGRES_PASSWORD="$DRILL_PASSWORD" \
  -e POSTGRES_USER=toolbox \
  -e POSTGRES_DB=toolbox \
  -p "127.0.0.1:${DRILL_PORT}:5432" \
  "$DRILL_IMAGE" >/dev/null

# --- wait for ready --------------------------------------------------------
# The timescaledb-ha image briefly accepts connections before its init scripts
# restart Postgres to apply tuning. Require a stable ready streak so pg_restore
# is not killed mid-COPY by that restart.
READY_STREAK=0
for i in $(seq 1 90); do
  if docker exec "$DRILL_CONTAINER" pg_isready -U toolbox -d toolbox -q 2>/dev/null \
    && docker exec "$DRILL_CONTAINER" psql -U toolbox -d toolbox -tAc 'SELECT 1' >/dev/null 2>&1; then
    READY_STREAK=$((READY_STREAK + 1))
    if [ "$READY_STREAK" -ge 5 ]; then
      echo "Container ready after ${i}s"
      break
    fi
  else
    READY_STREAK=0
  fi
  if [ "$i" -eq 90 ]; then
    echo "FAIL: container did not become stably ready in 90s"
    docker logs "$DRILL_CONTAINER" | tail -30
    exit 1
  fi
  sleep 1
done

# --- copy + restore --------------------------------------------------------
docker cp "$LATEST" "$DRILL_CONTAINER:/tmp/restore.dump"
docker cp "$MAZE_LATEST" "$DRILL_CONTAINER:/tmp/restore-maze.dump"

START=$(date +%s)
echo "Restore start: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
set +e
docker exec "$DRILL_CONTAINER" pg_restore -U toolbox -d toolbox \
  --no-owner --no-acl /tmp/restore.dump
EXIT=$?
set -e
if [ "$EXIT" -ne 0 ]; then
  echo "FAIL: pg_restore exited $EXIT"
  docker logs "$DRILL_CONTAINER" | tail -30
  if [ -n "$DISCORD_WEBHOOK_URL" ]; then
    curl -sS -X POST "$DISCORD_WEBHOOK_URL" -H 'Content-Type: application/json' \
      -d "{\"content\":\"TOOLBOX restore drill (separate-container) FAILED — pg_restore exit $EXIT on $(basename "$LATEST")\"}" >/dev/null
  fi
  exit "$EXIT"
fi

echo "Maze restore start: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker exec "$DRILL_CONTAINER" psql -U toolbox -d toolbox -tAc "CREATE DATABASE ${MAZE_DATABASE}" >/dev/null
set +e
docker exec "$DRILL_CONTAINER" pg_restore -U toolbox -d "$MAZE_DATABASE" \
  --no-owner --no-acl /tmp/restore-maze.dump
MAZE_EXIT=$?
set -e
if [ "$MAZE_EXIT" -ne 0 ]; then
  echo "FAIL: maze pg_restore exited $MAZE_EXIT"
  docker logs "$DRILL_CONTAINER" | tail -30
  if [ -n "$DISCORD_WEBHOOK_URL" ]; then
    curl -sS -X POST "$DISCORD_WEBHOOK_URL" -H 'Content-Type: application/json' \
      -d "{\"content\":\"TOOLBOX restore drill FAILED — maze pg_restore exit $MAZE_EXIT on $(basename "$MAZE_LATEST")\"}" >/dev/null
  fi
  exit "$MAZE_EXIT"
fi
END=$(date +%s)
DURATION=$((END - START))
echo "Restore end:   $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Duration:      ${DURATION}s"

# --- row-count match vs prod ----------------------------------------------
read_count() {
  local container="$1" db="$2" table="$3"
  docker exec "$container" psql -U toolbox -d "$db" -tAc "SELECT count(*) FROM ${table}" 2>/dev/null
}

drift_check() {
  # drift_check <drill_count> <prod_count> -> echoes 1 when |drift| > 5%
  awk -v a="$1" -v b="$2" 'BEGIN{ if(b==0){print 0} else { d=(a-b)/b*100; if(d<0)d=-d; print (d>5) ? 1 : 0 } }'
}

drift_fmt() {
  awk -v a="$1" -v b="$2" 'BEGIN{ if(b==0){print "n/a"} else { d=(a-b)/b*100; if(d<0)d=-d; printf "%.3f%%", d } }'
}

declare -a tables=(tb_signals tb_scans tb_skills tb_payments tb_api_keys)
FAIL=0
echo ""
echo "Row-count diff (drill vs prod) — toolbox:"
printf "  %-20s %12s %12s %10s\n" table drill prod drift_pct
for t in "${tables[@]}"; do
  d=$(read_count "$DRILL_CONTAINER" toolbox "$t" || echo "-")
  p=$(read_count "$PROD_CONTAINER" toolbox "$t" || echo "-")
  if [ "$p" = "-" ] || [ "$p" = "0" ]; then
    drift_pct="n/a"
  else
    drift_pct=$(drift_fmt "$d" "$p")
  fi
  printf "  %-20s %12s %12s %10s\n" "$t" "$d" "$p" "$drift_pct"
  # Sanity floor: drift > 5% on the high-volume tables is a fail
  if [ "$t" = "tb_signals" ] || [ "$t" = "tb_scans" ]; then
    bad=$(drift_check "$d" "$p")
    if [ "$bad" = "1" ]; then FAIL=1; fi
  fi
done

declare -a maze_tables=(nb_users nb_user_state nb_transactions nb_market_positions nb_transfers)
echo ""
echo "Row-count diff (drill vs prod) — ${MAZE_DATABASE} (nb_*):"
printf "  %-20s %12s %12s %10s\n" table drill prod drift_pct
for t in "${maze_tables[@]}"; do
  d=$(read_count "$DRILL_CONTAINER" "$MAZE_DATABASE" "$t" || echo "-")
  p=$(read_count "$PROD_CONTAINER" "$MAZE_DATABASE" "$t" || echo "-")
  if [ "$p" = "-" ] || [ "$p" = "0" ]; then
    drift_pct="n/a"
  else
    drift_pct=$(drift_fmt "$d" "$p")
  fi
  printf "  %-20s %12s %12s %10s\n" "$t" "$d" "$p" "$drift_pct"
  if [ "$t" = "nb_users" ] || [ "$t" = "nb_transactions" ]; then
    bad=$(drift_check "$d" "$p")
    if [ "$bad" = "1" ]; then FAIL=1; fi
  fi
done

# --- money invariants on the RESTORED copy ----------------------------------
NEG_BALANCES=$(docker exec "$DRILL_CONTAINER" psql -U toolbox -d "$MAZE_DATABASE" -tAc \
  "SELECT count(*) FROM nb_user_state WHERE bal_usd < 0 OR eur_usd < 0 OR sandbox_bal_usd < 0 OR earn_usd < 0 OR divest_threshold_usd < 0")
DUP_IDEM=$(docker exec "$DRILL_CONTAINER" psql -U toolbox -d "$MAZE_DATABASE" -tAc \
  "SELECT count(*) FROM (SELECT user_id, idempotency_key FROM nb_transfers GROUP BY user_id, idempotency_key HAVING count(*) > 1) dup")

echo ""
echo "Restored-copy invariants (${MAZE_DATABASE}):"
echo "  negative balances rows:            ${NEG_BALANCES}"
echo "  duplicate transfer idempotency:    ${DUP_IDEM}"
if [ "${NEG_BALANCES:-1}" != "0" ] || [ "${DUP_IDEM:-1}" != "0" ]; then
  echo "FAIL: money invariants violated in restored ${MAZE_DATABASE} copy."
  FAIL=1
fi

if [ "$FAIL" = "1" ]; then
  echo ""
  echo "FAIL: drift/invariant gate failed — backup is stale/partial or data is inconsistent."
  exit 1
fi

# --- success metrics -------------------------------------------------------
SIG=$(read_count "$DRILL_CONTAINER" toolbox tb_signals)
SCAN=$(read_count "$DRILL_CONTAINER" toolbox tb_scans)
SKILL=$(read_count "$DRILL_CONTAINER" toolbox tb_skills)
MAZE_USERS=$(read_count "$DRILL_CONTAINER" "$MAZE_DATABASE" nb_users)
MAZE_TRANSFERS=$(read_count "$DRILL_CONTAINER" "$MAZE_DATABASE" nb_transfers)

if mkdir -p /opt/toolbox/metrics 2>/dev/null; then
  cat > /opt/toolbox/metrics/pg_restore_drill_external.prom <<METRICS
# HELP toolbox_pg_restore_drill_external_last_success_timestamp Unix ts of last successful separate-container drill
# TYPE toolbox_pg_restore_drill_external_last_success_timestamp gauge
toolbox_pg_restore_drill_external_last_success_timestamp $(date +%s)
# HELP toolbox_pg_restore_drill_external_last_duration_seconds Wall-clock duration of last drill restore
# TYPE toolbox_pg_restore_drill_external_last_duration_seconds gauge
toolbox_pg_restore_drill_external_last_duration_seconds ${DURATION}
# HELP toolbox_pg_restore_drill_external_last_signals_rows tb_signals row count after restore
# TYPE toolbox_pg_restore_drill_external_last_signals_rows gauge
toolbox_pg_restore_drill_external_last_signals_rows ${SIG}
# HELP toolbox_pg_restore_drill_external_last_maze_users_rows nb_users row count after maze restore
# TYPE toolbox_pg_restore_drill_external_last_maze_users_rows gauge
toolbox_pg_restore_drill_external_last_maze_users_rows ${MAZE_USERS}
METRICS
  echo "Metrics -> /opt/toolbox/metrics/pg_restore_drill_external.prom"
fi

echo ""
echo "PASS: restored $(basename "$LATEST") + $(basename "$MAZE_LATEST") in ${DURATION}s — tb_signals=${SIG} tb_scans=${SCAN} tb_skills=${SKILL} nb_users=${MAZE_USERS} nb_transfers=${MAZE_TRANSFERS} neg_balances=${NEG_BALANCES} dup_idem=${DUP_IDEM}"

if [ -n "$DISCORD_WEBHOOK_URL" ]; then
  curl -sS -X POST "$DISCORD_WEBHOOK_URL" -H 'Content-Type: application/json' \
    -d "{\"content\":\"TOOLBOX restore drill PASS — ${DURATION}s, signals=${SIG} maze_users=${MAZE_USERS} neg_bal=${NEG_BALANCES} dup_idem=${DUP_IDEM}\"}" >/dev/null
fi
