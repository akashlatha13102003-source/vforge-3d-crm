/**
 * VFORGE 3D CRM -> Google Sheets (diagnostic + verified writer)
 *
 * Deploy as Web App:
 *   Execute as: Me
 *   Who has access: Anyone (or the access setting already used by the CRM)
 *
 * This script targets the VFORGE spreadsheet explicitly. It preserves report
 * tabs and Sync Log history, validates the full payload before writing, and
 * records both successful and failed sync attempts.
 */

var VFORGE_SPREADSHEET_ID = '1SlJfFSk5w3Zf_jrgV2L9YpZL8uza3rGxqpdP6EBkaBM';
var VFORGE_REPORTS = [
  { name: 'Filament Report', key: 'filament' },
  { name: 'Product Report', key: 'products' },
  { name: 'Sales Report', key: 'sales' },
  { name: 'Customer Report', key: 'customers' },
  { name: 'Wastage Report', key: 'wastage' },
  { name: 'Branch Transfers', key: 'branchTransfers' },
  { name: 'Consumables Report', key: 'consumables' }
];

function doGet() {
  try {
    var ss = SpreadsheetApp.openById(VFORGE_SPREADSHEET_ID);
    return json_({
      ok: true,
      message: 'VFORGE 3D CRM sync endpoint is running',
      spreadsheetName: ss.getName(),
      spreadsheetId: ss.getId(),
      reportTabs: VFORGE_REPORTS.map(function(report) {
        return { name: report.name, exists: !!ss.getSheetByName(report.name) };
      })
    });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  var lockAcquired = false;
  var data = null;
  var ss = null;
  var counts = {};

  try {
    lock.waitLock(30000);
    lockAcquired = true;

    var raw = e && e.parameter ? e.parameter.payload : null;
    if (!raw && e && e.postData) {
      raw = e.postData.contents;
      // Fallback for form-urlencoded bodies if Apps Script did not populate e.parameter.
      if (raw && raw.indexOf('payload=') === 0) {
        raw = decodeURIComponent(raw.substring(8).replace(/\\+/g, '%20'));
      }
    }
    if (!raw) throw new Error('Missing payload');

    // URLSearchParams posts payload as a form parameter. Also accept raw JSON.
    if (typeof raw !== 'string') throw new Error('Payload must be a JSON string');
    data = JSON.parse(raw);
    validatePayload_(data);

    ss = SpreadsheetApp.openById(VFORGE_SPREADSHEET_ID);
    if (ss.getId() !== VFORGE_SPREADSHEET_ID) {
      throw new Error('Spreadsheet ID mismatch. Refusing to write to an unexpected file.');
    }

    VFORGE_REPORTS.forEach(function(report) {
      counts[report.key] = data[report.key].length;
    });
    Logger.log('VFORGE sync received: ' + JSON.stringify({
      spreadsheetId: ss.getId(),
      syncedAt: data.syncedAt || '',
      rows: counts
    }));

    // Validate the complete payload before touching any report tab.
    VFORGE_REPORTS.forEach(function(report) {
      writeReport_(ss, report.name, data[report.key]);
    });
    SpreadsheetApp.flush();

    // Verify the written data row counts on every report tab.
    VFORGE_REPORTS.forEach(function(report) {
      var sh = ss.getSheetByName(report.name);
      if (!sh) throw new Error('Missing report sheet after write: ' + report.name);
      var expected = data[report.key].length;
      var actual = expected === 0 ? 0 : Math.max(0, sh.getLastRow() - 1);
      if (actual !== expected) {
        throw new Error('Verification failed for ' + report.name +
          ': expected ' + expected + ' rows, found ' + actual);
      }
    });
    SpreadsheetApp.flush();

    var receipt = {
      ok: true,
      verified: true,
      syncedAt: new Date().toISOString(),
      crmTimestamp: data.syncedAt || '',
      spreadsheetId: ss.getId(),
      spreadsheetName: ss.getName(),
      filamentRows: counts.filament,
      productRows: counts.products,
      salesRows: counts.sales,
      customerRows: counts.customers,
      wastageRows: counts.wastage,
      branchTransferRows: counts.branchTransfers,
      consumablesRows: counts.consumables
    };

    writeSyncLog_(ss, data, receipt, '');
    SpreadsheetApp.flush();

    VFORGE_REPORTS.forEach(function(report) {
      protectReportSheet_(ss, report.name);
    });
    protectReportSheet_(ss, 'Sync Log');
    SpreadsheetApp.flush();

    Logger.log('VFORGE sync verified: ' + JSON.stringify(receipt));
    return json_(receipt);

  } catch (err) {
    var message = String(err && err.stack ? err.stack : err);
    Logger.log('VFORGE SYNC FAILED: ' + message);

    // Record failures in the target spreadsheet too. This prevents a failed
    // sync from disappearing simply because Apps Script reports "Completed".
    try {
      if (!ss) ss = SpreadsheetApp.openById(VFORGE_SPREADSHEET_ID);
      writeSyncLog_(ss, data || {}, {
        ok: false,
        verified: false,
        syncedAt: new Date().toISOString(),
        spreadsheetId: ss.getId()
      }, message);
      SpreadsheetApp.flush();
      protectReportSheet_(ss, 'Sync Log');
    } catch (logErr) {
      Logger.log('Could not write failure to Sync Log: ' + String(logErr));
    }

    return json_({
      ok: false,
      verified: false,
      error: message,
      spreadsheetId: ss ? ss.getId() : VFORGE_SPREADSHEET_ID,
      rowsReceived: counts
    });

  } finally {
    if (lockAcquired) {
      try { lock.releaseLock(); } catch (ignore) {}
    }
  }
}

function validatePayload_(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Payload must be a JSON object');
  }
  VFORGE_REPORTS.forEach(function(report) {
    if (!Object.prototype.hasOwnProperty.call(data, report.key) ||
        !Array.isArray(data[report.key])) {
      throw new Error('Missing or invalid "' + report.key +
        '" array. No report tabs were changed.');
    }
    data[report.key].forEach(function(row, index) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error('Invalid row ' + (index + 1) + ' in ' + report.key);
      }
    });
  });
}

function writeReport_(ss, name, rows) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  removeVforgeProtection_(sh);

  if (!rows.length) {
    var previousRows = sh.getLastRow();
    var previousCols = sh.getLastColumn();
    if (previousRows > 0 && previousCols > 0) {
      sh.getRange(1, 1, previousRows, previousCols).clearContent();
    }
    sh.getRange(1, 1).setValue('No data');
    sh.setFrozenRows(0);
    return;
  }

  var headers = Object.keys(rows[0]);
  if (!headers.length) throw new Error('No columns supplied for ' + name);

  var values = [headers];
  rows.forEach(function(row, index) {
    var rowHeaders = Object.keys(row);
    if (rowHeaders.some(function(h) { return headers.indexOf(h) === -1; })) {
      throw new Error('Unexpected columns in ' + name + ', row ' + (index + 1));
    }
    values.push(headers.map(function(header) {
      var value = row[header];
      if (value === undefined || value === null) return '';
      if (typeof value === 'object') {
        throw new Error('Unsupported object value in ' + name + ', row ' +
          (index + 1) + ', column ' + header);
      }
      return value;
    }));
  });

  // Write the complete replacement first. Only after it succeeds, clear stale
  // trailing cells from the previous report so a failed write won't blank it.
  var previousRows = sh.getLastRow();
  var previousCols = sh.getLastColumn();
  sh.getRange(1, 1, values.length, headers.length).setValues(values);

  if (previousRows > values.length && previousCols > 0) {
    sh.getRange(values.length + 1, 1,
      previousRows - values.length, previousCols).clearContent();
  }
  if (previousCols > headers.length) {
    sh.getRange(1, headers.length + 1,
      Math.max(previousRows, values.length), previousCols - headers.length).clearContent();
  }

  sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, headers.length);
}

function writeSyncLog_(ss, data, receipt, errorMessage) {
  var sh = ss.getSheetByName('Sync Log') || ss.insertSheet('Sync Log');
  removeVforgeProtection_(sh);

  var requiredHeaders = [
    'Received At', 'CRM Timestamp', 'Filament Rows', 'Product Rows',
    'Sales Rows', 'Customer Rows', 'Wastage Rows', 'Branch Transfer Rows',
    'Consumables Rows', 'Status', 'Verified', 'Spreadsheet ID', 'Error'
  ];

  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, requiredHeaders.length).setValues([requiredHeaders]);
  } else {
    var lastCol = Math.max(sh.getLastColumn(), 1);
    var existing = sh.getRange(1, 1, 1, lastCol).getValues()[0];
    requiredHeaders.forEach(function(header) {
      if (existing.indexOf(header) === -1) {
        existing.push(header);
        sh.getRange(1, existing.length).setValue(header);
      }
    });
  }

  var finalHeaders = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var valuesByHeader = {
    'Received At': new Date(),
    'CRM Timestamp': data.syncedAt || '',
    'Filament Rows': rowCount_(data.filament),
    'Product Rows': rowCount_(data.products),
    'Sales Rows': rowCount_(data.sales),
    'Customer Rows': rowCount_(data.customers),
    'Wastage Rows': rowCount_(data.wastage),
    'Branch Transfer Rows': rowCount_(data.branchTransfers),
    'Consumables Rows': rowCount_(data.consumables),
    'Status': errorMessage ? 'FAILED' : 'Verified',
    'Verified': !!(receipt && receipt.verified),
    'Spreadsheet ID': ss.getId(),
    'Error': errorMessage || ''
  };
  sh.appendRow(finalHeaders.map(function(header) {
    return Object.prototype.hasOwnProperty.call(valuesByHeader, header)
      ? valuesByHeader[header] : '';
  }));
}

function rowCount_(rows) {
  return Array.isArray(rows) ? rows.length : 0;
}

function protectReportSheet_(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh) return;

  removeVforgeProtection_(sh);
  var protection = sh.protect();
  protection.setDescription('VFORGE CRM - Read only. Edit data through the CRM.');
  protection.setWarningOnly(false);

  var me = Session.getEffectiveUser();
  if (me && me.getEmail()) {
    try { protection.addEditor(me); } catch (ignore) {}
  }
  try {
    protection.getEditors().forEach(function(user) {
      if (!me || user.getEmail() !== me.getEmail()) {
        try { protection.removeEditor(user); } catch (ignore) {}
      }
    });
  } catch (ignore) {}
}

function removeVforgeProtection_(sh) {
  sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(function(p) {
    var description = p.getDescription() || '';
    if (description.indexOf('VFORGE CRM') === 0) {
      try { p.remove(); } catch (ignore) {}
    }
  });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
