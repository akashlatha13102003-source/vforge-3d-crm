'use strict';

/**
 * Isolated shared-workspace adapter prototype.
 *
 * IMPORTANT: This module is deliberately NOT imported by index.html yet.
 * It targets the post-migration schema and must not be enabled until the
 * workspace schema, RLS policies, membership lookup, and staging tests pass.
 * Supabase RLS remains the authorization boundary; this module is not a
 * substitute for database policies.
 */
function createSharedWorkspaceAdapter({ supabase, userId, workspaceId, role }) {
  if (!supabase || typeof supabase.from !== 'function') {
    throw new TypeError('A configured Supabase client is required.');
  }
  if (!userId || typeof userId !== 'string') {
    throw new TypeError('A signed-in user ID is required.');
  }
  if (!workspaceId || typeof workspaceId !== 'string') {
    throw new TypeError('A verified workspace ID is required.');
  }
  if (!['admin', 'staff'].includes(role)) {
    throw new TypeError('A verified workspace membership role is required.');
  }

  function collectionName(collection) {
    if (typeof collection !== 'string' || !/^[a-z][a-zA-Z0-9_]{0,63}$/.test(collection)) {
      throw new TypeError('Invalid collection name.');
    }
    return collection;
  }

  function recordId(id) {
    if (typeof id !== 'string' || !id.trim() || id.length > 200) {
      throw new TypeError('A valid record ID is required.');
    }
    return id;
  }

  async function list(collection) {
    const col = collectionName(collection);
    const result = await supabase
      .from('vforge_records')
      .select('id,data,updated_at,user_id,workspace_id')
      .eq('workspace_id', workspaceId)
      .eq('collection', col)
      .order('updated_at', { ascending: false });
    if (result.error) throw result.error;
    return result.data || [];
  }

  async function save(collection, record) {
    const col = collectionName(collection);
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new TypeError('A record object is required.');
    }
    const id = recordId(record.id);
    if (!Object.prototype.hasOwnProperty.call(record, 'data')) {
      throw new TypeError('Record data is required.');
    }
    const payload = {
      workspace_id: workspaceId,
      user_id: userId,
      collection: col,
      id,
      data: record.data,
      updated_at: new Date().toISOString()
    };
    const result = await supabase
      .from('vforge_records')
      .upsert(payload, { onConflict: 'workspace_id,collection,id' })
      .select('id,data,updated_at,user_id,workspace_id')
      .single();
    if (result.error) throw result.error;
    return result.data;
  }

  async function remove(collection, id) {
    const result = await supabase
      .from('vforge_records')
      .delete()
      .eq('workspace_id', workspaceId)
      .eq('collection', collectionName(collection))
      .eq('id', recordId(id))
      .select('id');
    if (result.error) throw result.error;
    return result.data || [];
  }

  return Object.freeze({ list, save, remove, workspaceId, role });
}

module.exports = { createSharedWorkspaceAdapter };
