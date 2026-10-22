/**
 * VFORGE 3D CRM -> Google Sheets
 * Protected report sheets: data should be changed through the CRM.
 *
 * IMPORTANT:
 * - The Apps Script must be bound to the target Google Sheet.
 * - Deploy as Web App: Execute as Me.
 * - Users do NOT need edit access to the Google Sheet.
 * - Report sheets are protected after each sync.
 */

function doGet() {
  return ContentService
    .createTextOutput(JSON.stringify({
      ok: true,
      message: 'VFORGE 3D CRM sync endpoint is running'
    }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var lock = LockService.getScriptLock();

  try {
    lock.waitLock(30000);

    var raw = e && e.parameter ? e.parameter.payload : null;
    if (!raw && e && e.postData) raw = e.postData.contents;
    if (!raw) throw new Error('Missing payload');

    var data = JSON.parse(raw);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) {
      throw new Error('No active spreadsheet. Open Apps Script from the target Google Sheet.');
    }

    writeReport_(ss, 'Filament Report', data.filament || []);
    writeReport_(ss, 'Product Report', data.products || []);
    writeReport_(ss, 'Sales Report', data.sales || []);
    writeReport_(ss, 'Customer Report', data.customers || []);
    writeReport_(ss, 'Wastage Report', data.wastage || []);
    writeReport_(ss, 'Branch Transfers', data.branchTransfers || []);
    writeSyncLog_(ss, data);

    // Protect report tabs so normal users cannot edit them directly.
    // The Apps Script owner can still update them through the CRM.
    protectReportSheet_(ss, 'Filament Report');
    protectReportSheet_(ss, 'Product Report');
    protectReportSheet_(ss, 'Sales Report');
    protectReportSheet_(ss, 'Customer Report');
    protectReportSheet_(ss, 'Wastage Report');
    protectReportSheet_(ss, 'Branch Transfers');
    protectReportSheet_(ss, 'Sync Log');

    SpreadsheetApp.flush();

    return json_({
      ok: true,
      syncedAt: new Date().toISOString(),
      filamentRows: (data.filament || []).length,
      productRows: (data.products || []).length,
      salesRows: (data.sales || []).length,
      wastageRows: (data.wastage || []).length,
      branchTransferRows: (data.branchTransfers || []).length
    });

  } catch (err) {
    return json_({
      ok: false,
      error: String(err)
    });
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}

function writeReport_(ss, name, rows) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);

  // Temporarily remove existing protections so the script can refresh the report.
  removeVforgeProtection_(sh);

  sh.clearContents();

  if (!rows.length) {
    sh.getRange(1, 1).setValue('No data');
    sh.setFrozenRows(0);
    return;
  }

  var headers = Object.keys(rows[0]);
  var values = [headers];

  rows.forEach(function(row) {
    values.push(headers.map(function(h) {
      var v = row[h];
      return v === undefined || v === null ? '' : v;
    }));
  });

  sh.getRange(1, 1, values.length, headers.length).setValues(values);
  sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, headers.length);
}

function writeSyncLog_(ss, data) {
  var sh = ss.getSheetByName('Sync Log') || ss.insertSheet('Sync Log');

  removeVforgeProtection_(sh);

  var headers = [
    'Received At',
    'CRM Timestamp',
    'Filament Rows',
    'Product Rows',
    'Sales Rows',
    'Customer Rows',
    'Wastage Rows',
    'Branch Transfer Rows',
    'Status'
  ];
  if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
  } else {
    // Preserve existing sync history. Add any missing header columns at the end;
    // never clear or rewrite older log rows during this schema upgrade.
    var existing = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0];
    headers.forEach(function(h) {
      if (existing.indexOf(h) === -1) {
        existing.push(h);
        sh.getRange(1, existing.length).setValue(h);
      }
    });
  }

  sh.appendRow([
    new Date(),
    data.syncedAt || '',
    (data.filament || []).length,
    (data.products || []).length,
    (data.sales || []).length,
    (data.customers || []).length,
    (data.wastage || []).length,
    (data.branchTransfers || []).length,
    'OK'
  ]);
}

/**
 * Protect a report sheet.
 * Users with normal Viewer access cannot edit.
 * The script owner remains the owner and the web app can continue writing.
 */
function protectReportSheet_(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh) return;

  removeVforgeProtection_(sh);

  var protection = sh.protect();
  protection.setDescription('VFORGE CRM - Read only. Edit data through the CRM.');

  // Do not leave the sheet as warning-only.
  protection.setWarningOnly(false);

  // Keep only the spreadsheet owner as an editor of the protected range.
  var me = Session.getEffectiveUser();
  if (me && me.getEmail()) {
    try {
      protection.addEditor(me);
    } catch (ignore) {}
  }

  try {
    var editors = protection.getEditors();
    editors.forEach(function(user) {
      if (!me || user.getEmail() !== me.getEmail()) {
        try {
          protection.removeEditor(user);
        } catch (ignore) {}
      }
    });
  } catch (ignore) {}
}

/**
 * Remove only protections created by VFORGE.
 * This prevents duplicate protections after every sync.
 */
function removeVforgeProtection_(sh) {
  var protections = sh.getProtections(SpreadsheetApp.ProtectionType.SHEET);

  protections.forEach(function(p) {
    var desc = p.getDescription() || '';
    if (desc.indexOf('VFORGE CRM') === 0) {
      try { p.remove(); } catch (ignore) {}
    }
  });
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}