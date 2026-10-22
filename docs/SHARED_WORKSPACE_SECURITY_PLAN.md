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
