# Shared-workspace rollout: CRM role requirements

**Status: draft. Not production approval.**

## Access behavior
- Admin and Staff can read, create, update, and delete records within their assigned workspace.
- Do not enforce a Staff read-only rule in the CRM UI or database.
- The owner manages Google Sheets permissions separately.
- Workspace isolation remains mandatory: users cannot read or change another workspace's records.
- Never ship a Supabase service-role key in browser code.

## Release gates
1. Confirm current schema, indexes, foreign keys, and exact RLS policy definitions.
2. Build membership resolution that fails closed if a workspace cannot be verified.
3. Make all record reads/writes/deletes workspace-scoped.
4. In staging, test Admin and Staff can manage records in their own workspace and cannot access another workspace.
5. Compare all existing record IDs and payloads before and after migration.
6. Deploy app and database changes as one coordinated release, only after staging passes and the owner approves.

## Current state
The production browser adapter is still user-scoped and the shared-workspace adapter is not activated. Do not apply workspace-only RLS policies until the app is compatible. The existing 98 records must be preserved. No production database changes have been made.
