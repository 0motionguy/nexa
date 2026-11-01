-- PERF-01 (Sprint 17.5) — partial index on nb_users.cohort.
--
-- /admin/test-users?cohort=tester-2026Q3 filters by `nb_users.cohort` and
-- hydrates the full User aggregate for each row. Without an index, that's a
-- sequential scan that gets linearly slower as the user table grows past
-- the pilot cohort.
--
-- Partial index (WHERE cohort IS NOT NULL) keeps the index small — the vast
-- majority of nb_users rows have `cohort = NULL` and don't need to be in it.

CREATE INDEX IF NOT EXISTS nb_users_cohort_idx ON nb_users(cohort) WHERE cohort IS NOT NULL;
