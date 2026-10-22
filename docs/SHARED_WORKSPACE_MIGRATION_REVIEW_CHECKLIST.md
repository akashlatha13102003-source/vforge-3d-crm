# Shared-workspace migration review checklist

Status: **draft / not approved for production**. This checklist is intended to accompany PR #3 and the security plan.

## Before generating executable migration SQL

- [ ] Capture the complete output of section 8 from the current live database, including every `indexdef`.
- [ ] Re-run preflight immediately before change and verify 98 rows (or reconcile any legitimate changes), zero NULL workspace IDs, zero duplicate `(workspace_id, collection, id)` keys, and only the expected owner/workspace pair.
- [ ] Export current policy definitions verbatim, including `qual`, `with_check`, command, and role; do not rely on policy names alone.
- [ ] Inventory all foreign keys referencing `vforge_records(user_id, collection, id)` and all indexes/constraints affected by changing the primary key.
- [ ] Confirm the existing Admin membership row is the intended initial administrator.
- [ ] Choose and test a trusted provisioning path for adding/removing members; no client-side service-role key.
- [ ] Have a staging Supabase project with a separate Admin, Staff, and second workspace.

## Required coordinated changes

- [ ] Add workspace-scoped record identity and the matching upsert conflict target.
- [ ] Make the application load a verified workspace and role after login; fail closed if membership is missing.
- [ ] Scope every record read, save, and delete to the verified workspace.
- [ ] Replace—not merely supplement—the existing permissive user-only record policies.
- [ ] Add policies and least-privilege grants for workspace and membership tables.
- [ ] Preserve the timestamp trigger and every existing row's ID and JSON payload.
- [ ] Ensure settings, wastage, transfers, customers, sales, filaments, products, and printers all use the same verified workspace scope.

## Acceptance test matrix

| Scenario | Expected result |
|---|---|
| Admin reads/writes/deletes within own workspace | Allowed |
| Staff reads own workspace | Allowed |
| Staff inserts/updates/deletes | Rejected by RLS, including direct PostgREST |
| User from workspace B reads workspace A | No rows / denied |
| User tampers with workspace ID | Rejected by RLS |
| Membership removed or lookup fails | Access fails closed |
| Existing data after cutover | Same record IDs and payloads |
| Repeated upsert for same workspace/collection/ID | One stable row |
| Browser backup export | Valid JSON containing all eight collections |
| Google Sheets sync | UI distinguishes queued request from confirmed receipt |

## Rollback gates

- Stop the rollout if row counts, keys, or payload hashes differ unexpectedly.
- If the app fails after cutover, disable new writes and restore the previous app build before considering database rollback.
- Restore exact prior policy definitions from the captured snapshot; do not reconstruct them from memory.
- Do not delete or overwrite record payloads as part of rollback.
- Keep the database backup and exports outside the affected project.

No database migration has been run by this checklist.