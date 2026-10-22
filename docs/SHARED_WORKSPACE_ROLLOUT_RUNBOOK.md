# VFORGE CRM workspace rollout runbook

**Status: draft only. Do not run this document as SQL or use it as production approval.**

This runbook defines the order for a safe shared-workspace release. The current application adapter is still user-scoped and must not be paired with workspace-only RLS policies.

## Gate 0 — Preconditions

- [ ] Full current index definitions exported from the live database.
- [ ] Fresh Supabase backup and CSV exports stored outside the project.
- [ ] Re-run preflight immediately before migration; record counts and compare with the reviewed baseline.
- [ ] Confirm no NULL `workspace_id`, no duplicate `(workspace_id, collection, id)`, and no unreviewed foreign-key dependency on the current record primary key.
- [ ] Record the exact existing policies, including command, roles, USING, and WITH CHECK.
- [ ] Verify the existing Admin membership is the intended initial Admin.
- [ ] A staging project and separate Admin, Staff, and second-workspace test accounts are ready.

**Stop if any precondition fails or the live data has changed without reconciliation.**

## Gate 1 — Build and test application adapter in isolation

Implement workspace context as a distinct adapter mode, not a silent rewrite of the current user-scoped mode.

- Authenticate with Supabase.
- Resolve workspace ID and role from a database-authorized membership lookup; never trust localStorage/form values as authority.
- Fail closed on missing membership, multiple ambiguous workspaces, revoked membership, or lookup error.
- Read using both the verified workspace ID and collection.
- Save with workspace ID and authenticated user ID; use the workspace-scoped conflict target only after the matching unique constraint exists.
- Delete by workspace ID, collection, and record ID.
- Keep local-to-cloud import disabled unless a separate preview/backup/conflict-resolution flow is explicitly used.
- Do not expose service-role credentials in the browser.

Run the existing business logic tests plus adapter contract tests against a disposable/staging schema. Production must continue using the current build until Gate 3.

## Gate 2 — Staging database migration and RLS tests

Use a staging database with a copy of the schema and synthetic records. Do not test first on production.

- Apply the reviewed workspace-scoped key migration only after checking dependencies and confirming a rollback route.
- Replace the four permissive user-only policies; adding workspace policies beside them is insufficient because permissive policies combine with OR.
- Add reviewed policies for workspace and membership tables.
- Add a narrowly scoped membership helper only if needed to avoid RLS recursion. If SECURITY DEFINER is used, set a fixed search_path, schema-qualify all object references, avoid dynamic SQL, and restrict EXECUTE grants.
- Provision new members through a trusted server-side flow. Never allow Staff to self-assign Admin or write membership rows directly.
- Test with actual Admin and Staff JWTs using both the app and direct PostgREST calls.

Required results:
- Admin reads/writes/deletes only in own workspace.
- Staff reads own workspace but database rejects insert/update/delete.
- Cross-workspace reads return no rows and writes/deletes are rejected.
- Tampering with workspace IDs is rejected by RLS.
- Missing/revoked membership fails closed.
- All existing IDs and payloads are preserved after a staging data migration.
- Upsert conflict handling creates one stable record for a given workspace/collection/ID.

## Gate 3 — Coordinated production release

Only after Gate 2 passes and the owner explicitly approves:

1. Take a fresh backup and capture current live policy definitions.
2. Pause writes for the short cutover window.
3. Apply the reviewed database migration.
4. Verify row counts, IDs, payload hashes, policies, and grants.
5. Deploy the matching app adapter immediately after the database migration.
6. Test Admin and Staff operations with separate accounts.
7. Re-enable normal use only after all acceptance tests pass.

Never deploy a workspace-only database policy set while the old user-scoped adapter is still the active production client.

## Rollback

- Stop writes immediately if the post-migration checks fail.
- Restore the previous app build first if the app is incompatible.
- Restore exact prior policy definitions from the saved snapshot, not reconstructed guesses.
- Revert key/schema changes only after checking constraints and confirming the reverse operation is safe.
- Do not delete, regenerate, or replace record payloads during rollback.
- Keep the backup and exports outside the affected Supabase project.

## Current verified status

- 98 existing records were reported in the user's preflight screenshots.
- No NULL workspace IDs and no duplicate workspace/collection/ID keys were reported in those screenshots.
- The existing `vforge_records` policies are user-scoped and permissive.
- The workspace and membership tables showed RLS enabled but zero policies.
- The current browser adapter still reads, writes, and deletes by user ID, omits `workspace_id` on save, and uses conflict target `user_id,collection,id`.
- Full index definitions and staging Admin/Staff tests are still outstanding.
- No production database migration has been applied by this runbook.
