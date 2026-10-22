# Shared-workspace security implementation plan (review only)

Status: design notes; **not a migration script and not approved for production**.

## Current verified constraints

- The app's Supabase adapter reads records filtered by `collection` but not by `workspace_id`.
- Writes include `user_id`, `collection`, `id`, `data`, and `updated_at`, but omit `workspace_id`.
- Deletes filter by `collection` and `id`, not workspace.
- Existing `vforge_records` primary key is `(user_id, collection, id)`. Shared records therefore cannot safely be implemented by only adding a workspace filter.
- Existing user-scoped RLS policies are permissive policies. PostgreSQL combines permissive policies with OR, so adding a workspace policy without replacing/restricting the old policies would not enforce staff read-only access.
- The live database has not been changed by this branch.

## Required behavior

1. Members can only read rows belonging to a workspace where they are an active member.
2. Admins can insert, update, and delete records for their workspace.
3. Staff can select records for their workspace but cannot mutate records, including through direct PostgREST calls.
4. A member of one workspace cannot infer or access records in another workspace.
5. Existing 98 exported record rows are preserved and remain addressable; no destructive rewrite or ID regeneration.
6. No Supabase service-role key is shipped to the browser.

## Recommended migration sequence

### A. Preflight and backup
- Take a fresh database backup and export all three existing tables.
- Record counts, workspace membership, each record's `user_id`, `workspace_id`, `collection`, `id`, and primary-key values.
- Abort if any existing row has no resolvable workspace, if duplicate target keys exist, or if membership/owner mapping is ambiguous.
- Keep the previous application build and rollback SQL ready.

### B. Additive schema change first
- Add any needed indexes and constraints without dropping the current primary key or policies yet.
- Decide the canonical shared-record identity before changing keys. Preferred target is a unique identity based on `(workspace_id, collection, id)`, but changing the primary key must be coordinated with all existing foreign keys and application assumptions.
- Backfill `workspace_id` from each row's existing workspace value or a reviewed, explicit mapping. Never guess a workspace from email or silently assign rows.
- Validate counts and key uniqueness after backfill.

### C. Role-aware app adapter
- After login, load membership rows for the authenticated user and resolve one explicit active workspace and role.
- Do not default to Admin if membership lookup fails; fail closed.
- Include `workspace_id` in every select, insert/upsert, update, and delete operation.
- Do not rely on client-side role checks as the security boundary; these are UX only. RLS must enforce authorization.
- Do not auto-import local browser data on connect. Any import needs preview, conflict reporting, explicit confirmation, and a prior backup.

### D. Replace RLS policies atomically
- Inventory exact policy names and commands from the live database immediately before migration.
- In one reviewed migration, remove/replace the old user-scoped permissive policies that would otherwise OR with the new rules.
- Use membership checks tied to `auth.uid()` and the row's `workspace_id`.
- SELECT: workspace member.
- INSERT: workspace Admin and authenticated user's membership; validate both `workspace_id` and any audit/user fields.
- UPDATE: Admin in the same workspace, with both USING and WITH CHECK.
- DELETE: Admin in the same workspace.
- Apply equivalent workspace-membership protection to workspace and membership tables; only an authorized workspace Admin/owner may manage membership.
- Avoid recursive RLS by using a carefully reviewed security-definer membership helper with a fixed `search_path`, minimal grants, and no user-controlled dynamic SQL, or another verified non-recursive pattern.
- Keep helper functions and grants least-privileged.

### E. Acceptance tests before release
Use separate real Admin and Staff accounts plus two workspaces. Run both app-level tests and direct PostgREST requests with each user's JWT.

| Test | Expected |
|---|---|
| Admin reads own workspace | Allowed |
| Staff reads own workspace | Allowed |
| Staff insert/update/delete record | Rejected by database |
| Admin writes in own workspace | Allowed |
| Member reads another workspace | No rows / denied |
| Member writes another workspace | Rejected |
| Existing records after backfill | Same count and IDs; payloads unchanged |
| Concurrent saves for same shared ID | One stable row; no duplicate |
| Refresh/reconnect | Same workspace and role resolved |
| Membership missing or lookup error | Fail closed; no elevated access |

Also test all eight collections, especially settings, wastage and transfers, and verify that delete/update behavior remains correct.

### F. Rollout and rollback
- Apply additive schema/backfill only after backup and preflight pass.
- Deploy the role-aware app only after RLS is ready, preferably with a coordinated cutover window.
- Re-run count/key checks and Admin/Staff direct REST tests.
- Keep rollback steps available. Do not drop legacy columns, keys, or backups during the initial release.
- Mark the release ready only after the acceptance matrix is recorded as passing.

## Why this file does not include executable SQL

The live policy names/definitions, all dependent constraints, and a safe membership provisioning path have not been verified through a live database connection. A generic script that guesses policy names or changes the primary key could lock out users or damage access. This plan is intentionally non-executable until those facts are inspected and the migration is reviewed.

## Current release state

The candidate app and Sheets script are in a draft PR. This plan does not change the live site, Supabase database, or Google Sheets deployment.


## Live preflight results reviewed from user-provided Supabase screenshots (2026-10-22)

These are direct observations from the screenshots, not a live connector query by this repository tooling:

- RLS is enabled and not forced on all three tables.
- `vforge_records`: 98 rows, 4 permissive user-scoped policies (SELECT, INSERT, UPDATE, DELETE).
- `vforge_workspaces`: 1 row, RLS enabled, zero policies shown.
- `vforge_workspace_members`: 1 row, RLS enabled, zero policies shown.
- `vforge_records` columns include nullable `workspace_id uuid`; `user_id uuid`, `collection text`, and `id text` are NOT NULL.
- Current record primary key is `(user_id, collection, id)`; `workspace_id` references `vforge_workspaces(id)`.
- Workspace membership primary key is `(workspace_id, user_id)`; role has a check constraint permitting `admin` and `staff`.
- The duplicate candidate query for `(workspace_id, collection, id)` returned zero rows.
- The visible record distribution query showed 77 filaments, 6 printers, 14 products, and 1 settings row (98 total), all under the same workspace ID.
- Sections 1, 3, 4 and 6 have been supplied as screenshots. The section 2 screenshot showed four user-scoped policies on `vforge_records`.

### Implications and remaining verification

- Because RLS is enabled but the workspace and membership tables have zero policies, ordinary authenticated access to those tables is likely denied by RLS unless another privileged/bypass path is used. Verify current app login/workspace loading before any policy change.
- Do not make `workspace_id` NOT NULL or change the primary key until checking all rows for NULL workspace IDs and reviewing all foreign-key dependencies.
- Zero duplicate candidate keys is encouraging, but does not itself prove that changing the primary key is safe.
- The preflight screenshot does not show grants, triggers, all indexes, function definitions, or the actual contents of each record payload. Inspect these before finalizing executable migration SQL.
- No live database changes have been made by this branch.


## Additional live preflight findings from screenshots (2026-10-22)

- Aggregate ownership query returned 98 total rows, 0 rows with NULL `workspace_id`, 1 distinct record owner, and 1 distinct workspace.
- Per-owner distribution showed the same user/workspace pair owning all 98 rows.
- Trigger inspection showed one trigger on `vforge_records`: `vforge_records_updated_at`, BEFORE UPDATE, calling `vforge_set_updated_at()`.
- Table grants output showed `authenticated` has SELECT, INSERT, UPDATE, DELETE privileges on `vforge_records`; `postgres` has owner-level grants on all three tables. `service_role` has limited listed privileges on these tables. No ordinary `authenticated` table grants were shown for `vforge_workspaces` or `vforge_workspace_members`.
- The function inventory section 10 has not yet been shown in the supplied screenshots; the definition and security settings of `vforge_set_updated_at()` have not been verified.
- The screenshots do not visibly show index results from section 8, so the full index inventory is still pending.
- No migration has been applied.

### Next required verification before writing final migration SQL

1. Review the complete index output from section 8.
2. Review section 10 function output, including `vforge_set_updated_at()` if it appears in the query results.
3. Check existing policies/grants for workspace and membership access and decide a secure membership-management bootstrap path. The current screenshots show zero RLS policies on those two tables and no ordinary authenticated table grants, so a role-aware browser app cannot safely rely on direct access to those tables until a reviewed policy/provisioning design exists.
4. Build and test an additive migration plan and a rollback plan; do not apply it before Admin/Staff acceptance tests are possible.


- Section 10 function inventory screenshot (2026-10-22) returned only `auth.role()`, with `security_definer = false` and no function settings. This query only searches function names containing workspace/member/role; it does not prove no other relevant functions exist. The existing timestamp trigger function `vforge_set_updated_at()` should be reviewed separately.
