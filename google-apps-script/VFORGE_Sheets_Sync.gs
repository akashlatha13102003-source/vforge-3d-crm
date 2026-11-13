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

function doGet(e) {
  // JSONP receipt polling lets the CRM confirm a cross-origin POST without
  // relying on opaque sendBeacon/no-cors responses.
  var params = e && e.parameter ? e.parameter : {};
  if (params.receipt) {
    var receipt = readReceipt_(params.receipt);
    var callback = String(params.callback || '');
    if (!/^[A-Za-z_$][0-9A-Za-z_$]*$/.test(callback)) {
      return json_({ ok: false, error: 'Invalid receipt callback name' });
    }
    var body = callback + '(' + JSON.stringify(receipt || {
      ok: false, pending: true, requestId: params.receipt
    }) + ');';
    return ContentService.createTextOutput(body)
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

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
    requireSyncToken_(data.authToken);

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
      requestId: data.requestId || '',
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

    // Successful syncs with identical report data are logged at most once
    // within the cooldown window. Reports and receipts are still updated
    // and verified on every request.
    var logResult = { recorded: false, reason: '' };
    try {
      logResult = writeSyncLog_(ss, data, receipt, '');
      archiveOldSyncLogs_(ss);
    } catch (logErr) {
      receipt.syncLogWarning = String(logErr && logErr.stack ? logErr.stack : logErr);
      Logger.log('Sync succeeded, but Sync Log maintenance needs attention: ' +
        receipt.syncLogWarning);
    }
    receipt.syncLogRecorded = !!logResult.recorded;
    receipt.syncLogReason = logResult.reason || '';
    SpreadsheetApp.flush();
    storeReceipt_(data.requestId, receipt);

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
    var failureReceipt = {
      ok: false,
      verified: false,
      requestId: data && data.requestId || '',
      syncedAt: new Date().toISOString(),
      error: message,
      spreadsheetId: ss ? ss.getId() : VFORGE_SPREADSHEET_ID
    };
    storeReceipt_(data && data.requestId, failureReceipt);

    try {
      if (!ss) ss = SpreadsheetApp.openById(VFORGE_SPREADSHEET_ID);
      writeSyncLog_(ss, data || {}, failureReceipt, message);
      SpreadsheetApp.flush();
      archiveOldSyncLogs_(ss);
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


function storeReceipt_(requestId, receipt) {
  if (!requestId) return;
  var props = PropertiesService.getScriptProperties();
  props.setProperty('VFORGE_RECEIPT_' + requestId, JSON.stringify(receipt));
  // Keep receipt storage bounded: retain the latest 100 request IDs.
  var keys = JSON.parse(props.getProperty('VFORGE_RECEIPT_KEYS') || '[]');
  keys = keys.filter(function(key) { return key !== requestId; });
  keys.push(requestId);
  while (keys.length > 100) {
    var old = keys.shift();
    props.deleteProperty('VFORGE_RECEIPT_' + old);
  }
  props.setProperty('VFORGE_RECEIPT_KEYS', JSON.stringify(keys));
}

function readReceipt_(requestId) {
  var raw = PropertiesService.getScriptProperties()
    .getProperty('VFORGE_RECEIPT_' + requestId);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (ignore) { return null; }
}

/** Require a shared secret stored in Apps Script Script Properties. */
function requireSyncToken_(providedToken) {
  var expectedToken = PropertiesService.getScriptProperties().getProperty('VFORGE_SYNC_TOKEN');
  if (!expectedToken || expectedToken.length < 32) {
    throw new Error('Google Sheets sync is not configured securely. Set VFORGE_SYNC_TOKEN in Apps Script Script Properties to a random value of at least 32 characters.');
  }
  if (typeof providedToken !== 'string' || providedToken.length !== expectedToken.length ||
      !constantTimeEquals_(providedToken, expectedToken)) {
    throw new Error('Unauthorized sync request. Check the Google Sheets sync token in CRM Settings.');
  }
}

function constantTimeEquals_(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Prevent untrusted strings from becoming spreadsheet formulas. */
function safeSheetValue_(value) {
  if (typeof value !== 'string') return value;
  return /^[\\s]*[=+\\-@]/.test(value) ? "'" + value : value;
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
      return safeSheetValue_(value);
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
    'Consumables Rows', 'Status', 'Verified', 'Spreadsheet ID', 'Error', 'Request ID'
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

  // Failures are never throttled. For successful syncs, avoid adding another
  // row when exactly the same report data was already logged in the last
  // five minutes. The report tabs are still rewritten and verified above.
  if (!errorMessage) {
    var duplicateCheck = shouldLogSuccessfulSync_(data);
    if (!duplicateCheck.log) {
      return { recorded: false, reason: duplicateCheck.reason };
    }
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
    'Error': errorMessage || '',
    'Request ID': data.requestId || ''
  };
  sh.appendRow(finalHeaders.map(function(header) {
    var value = Object.prototype.hasOwnProperty.call(valuesByHeader, header)
      ? valuesByHeader[header] : '';
    return safeSheetValue_(value);
  }));

  if (!errorMessage) rememberSuccessfulSync_(data);
  return { recorded: true, reason: errorMessage ? 'Failure recorded' : 'New or changed data' };
}

/**
 * Return false only when the same complete report payload was successfully
 * logged less than five minutes ago. A changed payload is always logged.
 */
function shouldLogSuccessfulSync_(data) {
  var signature = successfulPayloadSignature_(data);
  var props = PropertiesService.getScriptProperties();
  var previousSignature = props.getProperty('VFORGE_LAST_SUCCESS_SIGNATURE') || '';
  var previousAt = Number(props.getProperty('VFORGE_LAST_SUCCESS_LOG_AT') || 0);
  var now = Date.now();
  var cooldownMs = 5 * 60 * 1000;

  if (signature && signature === previousSignature &&
      previousAt && now - previousAt < cooldownMs) {
    return {
      log: false,
      reason: 'Identical report data was already logged within the last 5 minutes'
    };
  }
  return { log: true, reason: '' };
}

function rememberSuccessfulSync_(data) {
  var props = PropertiesService.getScriptProperties();
  props.setProperty('VFORGE_LAST_SUCCESS_SIGNATURE', successfulPayloadSignature_(data));
  props.setProperty('VFORGE_LAST_SUCCESS_LOG_AT', String(Date.now()));
}

function successfulPayloadSignature_(data) {
  var payload = {};
  VFORGE_REPORTS.forEach(function(report) {
    payload[report.key] = data[report.key] || [];
  });
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    JSON.stringify(payload),
    Utilities.Charset.UTF_8
  );
  return Utilities.base64Encode(digest);
}

/**
 * Keep the newest 1,000 records in Sync Log. Older rows are moved into
 * monthly archive tabs. Rows are deleted from the live log only after their
 * archive write succeeds. Request IDs prevent duplicate archiving on retry.
 */
function archiveOldSyncLogs_(ss) {
  var keepRows = 1000;
  var sh = ss.getSheetByName('Sync Log');
  if (!sh) return;

  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  var dataRows = Math.max(0, lastRow - 1);
  var archiveCount = dataRows - keepRows;
  if (archiveCount <= 0 || lastCol <= 0) return;

  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var rows = sh.getRange(2, 1, archiveCount, lastCol).getValues();
  var receivedAtIndex = headers.indexOf('Received At');
  var requestIdIndex = headers.indexOf('Request ID');
  var groups = {};

  rows.forEach(function(row) {
    var rawDate = receivedAtIndex >= 0 ? row[receivedAtIndex] : null;
    var date = rawDate instanceof Date ? rawDate : new Date(rawDate);
    var monthKey = rawDate && !isNaN(date.getTime())
      ? Utilities.formatDate(date, 'Asia/Kolkata', 'yyyy-MM')
      : 'Undated';
    if (!groups[monthKey]) groups[monthKey] = [];
    groups[monthKey].push(row);
  });

  // Archive each month in batches. Existing Request IDs are checked before
  // appending so a retry after a partial failure cannot duplicate archived rows.
  Object.keys(groups).sort().forEach(function(monthKey) {
    var archiveName = 'Sync Log Archive ' + monthKey;
    var archive = ss.getSheetByName(archiveName) || ss.insertSheet(archiveName);
    removeVforgeProtection_(archive);

    var archiveLastCol = archive.getLastColumn();
    var archiveHeaders = archive.getLastRow() === 0
      ? [] : archive.getRange(1, 1, 1, archiveLastCol).getValues()[0];

    headers.forEach(function(header) {
      if (archiveHeaders.indexOf(header) === -1) archiveHeaders.push(header);
    });

    if (archive.getLastRow() === 0) {
      archive.getRange(1, 1, 1, archiveHeaders.length).setValues([archiveHeaders]);
      archive.setFrozenRows(1);
    } else if (archiveHeaders.length !== archiveLastCol) {
      archive.getRange(1, 1, 1, archiveHeaders.length).setValues([archiveHeaders]);
    }

    var archivedKeys = {};
    var archiveRequestIndex = archiveHeaders.indexOf('Request ID');
    var archiveRows = Math.max(0, archive.getLastRow() - 1);
    if (archiveRows > 0) {
      archive.getRange(2, 1, archiveRows, archiveHeaders.length)
        .getValues().forEach(function(archivedRow) {
          var archivedRequestId = archiveRequestIndex >= 0
            ? archivedRow[archiveRequestIndex] : '';
          var archivedKey = archivedRequestId
            ? 'id:' + String(archivedRequestId)
            : 'row:' + JSON.stringify(archivedRow);
          archivedKeys[archivedKey] = true;
        });
    }

    var pending = [];
    groups[monthKey].forEach(function(row) {
      var requestId = requestIdIndex >= 0 ? row[requestIdIndex] : '';
      var mapped = archiveHeaders.map(function(header) {
        var sourceIndex = headers.indexOf(header);
        return sourceIndex >= 0 ? row[sourceIndex] : '';
      });
      var key = requestId ? 'id:' + String(requestId) : 'row:' + JSON.stringify(mapped);
      if (archivedKeys[key]) return;
      archivedKeys[key] = true;
      pending.push(mapped);
    });

    if (pending.length) {
      var writeAt = archive.getLastRow() + 1;
      archive.getRange(writeAt, 1, pending.length, archiveHeaders.length)
        .setValues(pending);
      archive.getRange(1, 1, 1, archiveHeaders.length).setFontWeight('bold');
      archive.autoResizeColumns(1, archiveHeaders.length);
    }
    protectReportSheet_(ss, archiveName);
  });

  // All archive writes completed. Preserve the header and newest 1,000 rows.
  sh.deleteRows(2, archiveCount);
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

  // The web app executes as its owner, who creates this protection and
  // remains able to edit the sheet. Avoid Session.getEffectiveUser(): it
  // requires the userinfo.email OAuth scope and can fail after report writes.
  // Leave existing collaborators unchanged; the spreadsheet owner retains access.
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
