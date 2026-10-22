-- VFORGE CRM: read-only Supabase security preflight
-- This script only reads catalog metadata and row counts. It does not change data,
-- policies, grants, keys, or table definitions. Run in Supabase SQL Editor only
-- when ready to review security; save the complete results for the migration review.

-- 1) RLS state and table row counts.
select
  n.nspname as schema_name,
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as rls_forced,
  (select count(*) from pg_policies p
   where p.schemaname = n.nspname and p.tablename = c.relname) as policy_count,
  case c.relname
    when 'vforge_records' then (select count(*) from public.vforge_records)
    when 'vforge_workspaces' then (select count(*) from public.vforge_workspaces)
    when 'vforge_workspace_members' then (select count(*) from public.vforge_workspace_members)
    else null
  end as current_row_count
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('r','p')
  and c.relname in ('vforge_records','vforge_workspaces','vforge_workspace_members')
order by c.relname;

-- 2) Exact current policies, including command, roles, predicates, and permissive mode.
select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('vforge_records','vforge_workspaces','vforge_workspace_members')
order by tablename, policyname;

-- 3) Current columns, nullability, and defaults.
select table_name, ordinal_position, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name in ('vforge_records','vforge_workspaces','vforge_workspace_members')
order by table_name, ordinal_position;

-- 4) Current primary/unique/foreign-key constraints and definitions.
select
  conrelid::regclass::text as table_name,
  conname as constraint_name,
  contype as constraint_type,
  pg_get_constraintdef(oid, true) as definition
from pg_constraint
where conrelid in (
  'public.vforge_records'::regclass,
  'public.vforge_workspaces'::regclass,
  'public.vforge_workspace_members'::regclass
)
order by table_name, constraint_type, constraint_name;

-- 5) Existing record distribution by workspace and collection.
select workspace_id, collection, count(*) as row_count
from public.vforge_records
group by workspace_id, collection
order by workspace_id, collection;

-- 6) Duplicate candidates for a workspace-scoped shared-record identity.
-- This is diagnostic only; duplicates must be reviewed, never auto-deleted.
select workspace_id, collection, id, count(*) as duplicate_count
from public.vforge_records
group by workspace_id, collection, id
having count(*) > 1
order by duplicate_count desc, workspace_id, collection, id;

-- Do not paste access tokens, passwords, publishable keys, or service-role keys
-- into an issue or chat. The results above contain schema metadata and counts only.


-- 7) Null workspace IDs and record ownership distribution. These must be reviewed
-- before considering any NOT NULL constraint or ownership migration.
select
  count(*) as total_rows,
  count(*) filter (where workspace_id is null) as null_workspace_rows,
  count(distinct user_id) as distinct_record_owners,
  count(distinct workspace_id) as distinct_workspaces
from public.vforge_records;

select user_id, workspace_id, count(*) as row_count
from public.vforge_records
group by user_id, workspace_id
order by workspace_id, user_id;

-- 8) Indexes and triggers that may affect the migration.
select schemaname, tablename, indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename in ('vforge_records','vforge_workspaces','vforge_workspace_members')
order by tablename, indexname;

select
  event_object_table as table_name,
  trigger_name,
  action_timing,
  event_manipulation,
  action_statement
from information_schema.triggers
where event_object_schema = 'public'
  and event_object_table in ('vforge_records','vforge_workspaces','vforge_workspace_members')
order by event_object_table, trigger_name, event_manipulation;

-- 9) Table grants (separate from RLS policies).
select grantee, table_name, privilege_type, is_grantable
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('vforge_records','vforge_workspaces','vforge_workspace_members')
order by table_name, grantee, privilege_type;

-- 10) Functions potentially used by RLS or workspace access.
select n.nspname as schema_name, p.proname as function_name,
       pg_get_function_identity_arguments(p.oid) as arguments,
       p.prosecdef as security_definer,
       p.proconfig as function_settings
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('public','auth')
  and (p.proname ilike '%workspace%' or p.proname ilike '%member%' or p.proname ilike '%role%')
order by n.nspname, p.proname;


-- 11) Inspect the existing updated_at trigger function body.
-- Read-only definition lookup; verifies the trigger implementation without executing it.
select n.nspname as schema_name,
       p.proname as function_name,
       pg_get_function_identity_arguments(p.oid) as arguments,
       p.prosecdef as security_definer,
       p.proconfig as function_settings,
       pg_get_functiondef(p.oid) as function_definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where p.proname = 'vforge_set_updated_at'
order by n.nspname;
