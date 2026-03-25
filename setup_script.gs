/*
  PREMIUM SETUP SCRIPT for Habit Tracker DB (Isolated & Persistent)
  1. Go to sheets.new and name it "Habit Tracker DB".
  2. Extensions > Apps Script > Paste this code.
  3. Click Run 'setupDB' first.
  4. Deploy > New Deployment > Web App (Set "Who has access" to "Anyone").
*/

const SHEET_HEADERS = {
  Activities: ['id', 'name', 'created_at', 'email', 'exceptional_day'],
  Logs: ['id', 'activity_id', 'activity_name', 'timestamp', 'duration', 'status', 'email'],
  System_Logs: ['id', 'action', 'timestamp', 'details', 'email'],
  Users: ['user_id', 'name', 'email', 'referral_code', 'share_progress', 'otp', 'otp_expiry'],
  Referrals: ['referrer_code', 'referred_user_id', 'created_at']
};

function setupDB() {
  ensureDbSchema();
  SpreadsheetApp.flush();
}

/**
 * Use this to completely clear and reset the database structure.
 * WARNING: This deletes all data!
 */
function resetDB() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SHEET_HEADERS).forEach(name => {
    const sheet = ss.getSheetByName(name);
    if (sheet) ss.deleteSheet(sheet);
  });
  setupDB();
}

function checkAliases() {
  Logger.log(GmailApp.getAliases());
}

function doPost(e) {
  ensureDbSchema();

  const data = JSON.parse(e.postData.contents);
  const action = data.action;
  const email = (data.email || '').trim().toLowerCase();

  if (action === 'sendOTP') {
    const usersSheet = getSheet('Users');
    const user = findRecordBy(usersSheet, 'email', email);
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = new Date(Date.now() + 5 * 60000);

    if (user) {
      updateRecord(usersSheet, user.rowIndex, {
        otp,
        otp_expiry: expiry,
        share_progress: normalizeBoolean(user.record.share_progress, true)
      });
    } else {
      appendRecord(usersSheet, {
        user_id: Utilities.getUuid(),
        name: '',
        email,
        referral_code: generateReferralCode(),
        share_progress: true,
        otp,
        otp_expiry: expiry
      });
    }

    const htmlBody = `
      <div style="font-family: 'Helvetica', sans-serif; background-color: #0f172a; padding: 40px; color: #f8fafc; border-radius: 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #38bdf8; margin: 0; font-size: 28px;">Habit<span style="color: #ffffff;">App</span></h1>
          <p style="color: #64748b; font-size: 10px; text-transform: uppercase; letter-spacing: 2px; margin-top: 5px;">by Dhairya Mehta</p>
        </div>
        <div style="background-color: #1e293b; padding: 30px; border-radius: 16px; border: 1px solid #334155; text-align: center;">
          <p style="color: #94a3b8; font-size: 14px; margin-bottom: 20px;">Use the code below to access your private dashboard.</p>
          <div style="font-size: 42px; font-weight: bold; color: #38bdf8; letter-spacing: 12px; margin: 20px 0;">${otp}</div>
          <p style="color: #64748b; font-size: 11px; margin-top: 20px;">This code expires in <b>5 minutes</b>.</p>
        </div>
        <p style="text-align: center; color: #475569; font-size: 10px; margin-top: 30px;">&copy; 2026 HabitApp. Data is secure and isolated.</p>
      </div>
    `;

    try {
      GmailApp.sendEmail(
        email,
        `Your Login OTP - ${otp}`,
        `Your OTP is ${otp}`,
        {
          from: 'info@dhairyamehta.in',
          name: 'HabitApp by Dhairya Mehta',
          htmlBody: htmlBody
        }
      );
    } catch (err) {
      console.error('Email sending failed:', err);
    }

    return jsonResponse({ success: true });
  }

  if (action === 'verifyOTP') {
    const usersSheet = getSheet('Users');
    const user = findRecordBy(usersSheet, 'email', email);
    const otp = (data.otp || '').toString().trim();

    if (!user) return jsonResponse({ success: false, message: 'Invalid or expired OTP' });
    if ((user.record.otp || '').toString() !== otp) return jsonResponse({ success: false, message: 'Invalid or expired OTP' });
    if (new Date() >= new Date(user.record.otp_expiry)) return jsonResponse({ success: false, message: 'Invalid or expired OTP' });

    const hydrated = ensureUserRecord(usersSheet, user.rowIndex, user.record);
    logAction('LOGIN_SUCCESS', email, 'Success');
    return jsonResponse({
      success: true,
      profileComplete: !!(hydrated.name && hydrated.name.toString().trim()),
      user: serializeUser(hydrated)
    });
  }

  if (action === 'completeProfile') {
    const usersSheet = getSheet('Users');
    const user = findRecordBy(usersSheet, 'email', email);
    const name = (data.name || '').toString().trim();
    const shareProgress = normalizeBoolean(data.share_progress, true);
    const referralCodes = Array.isArray(data.referral_codes) ? data.referral_codes : [];

    if (!name) return jsonResponse({ success: false, message: 'Name is required' });
    if (!user) return jsonResponse({ success: false, message: 'User not found' });

    const hydrated = ensureUserRecord(usersSheet, user.rowIndex, user.record);
    updateRecord(usersSheet, user.rowIndex, {
      name,
      share_progress: shareProgress
    });

    const savedUser = {
      ...hydrated,
      name,
      share_progress: shareProgress
    };

    saveReferralMappings(savedUser, referralCodes);
    logAction('PROFILE_COMPLETED', email, name);
    return jsonResponse({ success: true, user: serializeUser(savedUser) });
  }

  if (action === 'updateShareSettings') {
    const usersSheet = getSheet('Users');
    const user = findRecordBy(usersSheet, 'email', email);
    if (!user) return jsonResponse({ success: false, message: 'User not found' });

    const shareProgress = normalizeBoolean(data.share_progress, true);
    updateRecord(usersSheet, user.rowIndex, { share_progress: shareProgress });
    const hydrated = ensureUserRecord(usersSheet, user.rowIndex, user.record);
    const savedUser = { ...hydrated, share_progress: shareProgress };
    logAction('SHARE_PROGRESS_UPDATED', email, shareProgress ? 'ON' : 'OFF');
    return jsonResponse({ success: true, user: serializeUser(savedUser) });
  }

  if (action === 'createActivity') {
    const { name, exceptional_day } = data;
    const sheet = getSheet('Activities');
    const id = Utilities.getUuid();
    sheet.appendRow(buildRow(sheet, {
      id,
      name,
      created_at: new Date(),
      email,
      exceptional_day
    }));
    logAction('ACTIVITY_CREATED', email, name);
    SpreadsheetApp.flush();
    return jsonResponse({ success: true, id });
  }

  if (action === 'deleteActivity') {
    const { activity_id } = data;
    const activitiesSheet = getSheet('Activities');
    const logsSheet = getSheet('Logs');
    const activityRowsDeleted = deleteRowsMatching(activitiesSheet, row => row.id === activity_id && row.email === email);
    const logRowsDeleted = deleteRowsMatching(logsSheet, row => row.activity_id === activity_id && row.email === email);

    if (activityRowsDeleted === 0) {
      return jsonResponse({ success: false, message: 'Activity not found' });
    }

    logAction('ACTIVITY_DELETED', email, `${activity_id} (${logRowsDeleted} logs removed)`);
    SpreadsheetApp.flush();
    return jsonResponse({ success: true });
  }

  if (action === 'logBuzzer') {
    const { activity_id, status, duration, action_type } = data;
    const logsSheet = getSheet('Logs');
    const timestamp = new Date();
    const activity = getRecords(getSheet('Activities')).find(row => row.id === activity_id && row.email === email);

    logAction(action_type, email, activity_id || 'N/A');

    if (action_type === 'BUZZER_STOP') {
      logsSheet.appendRow(buildRow(logsSheet, {
        id: Utilities.getUuid(),
        activity_id,
        activity_name: activity ? activity.name : '',
        timestamp,
        duration,
        status,
        email
      }));
    }

    SpreadsheetApp.flush();
    return jsonResponse({ success: true });
  }

  if (action === 'logout') {
    logAction('LOGOUT', email, 'Success');
    SpreadsheetApp.flush();
    return jsonResponse({ success: true });
  }

  return jsonResponse({ success: false, message: 'Unsupported action' });
}

function doGet(e) {
  ensureDbSchema();

  const action = e.parameter.action;
  const email = (e.parameter.email || '').trim().toLowerCase();

  if (action === 'getProfile') {
    const usersSheet = getSheet('Users');
    const user = findRecordBy(usersSheet, 'email', email);
    if (!user) return jsonResponse({ success: false, message: 'User not found' });
    const hydrated = ensureUserRecord(usersSheet, user.rowIndex, user.record);
    return jsonResponse({ success: true, user: serializeUser(hydrated) });
  }

  if (action === 'getActivities') {
    const activities = getRecords(getSheet('Activities'))
      .filter(row => row.email === email)
      .map(row => ({ id: row.id, name: row.name, exceptional_day: row.exceptional_day }));
    return jsonResponse(activities);
  }

  if (action === 'getLogs') {
    const activityId = e.parameter.activity_id;
    const logs = getRecords(getSheet('Logs'))
      .filter(row => row.activity_id === activityId && row.email === email)
      .map(row => ({ activity_name: row.activity_name, timestamp: row.timestamp, duration: row.duration, status: row.status }));
    return jsonResponse(logs);
  }

  if (action === 'checkSession') {
    const rows = getRecords(getSheet('System_Logs'));
    let currentSession = null;

    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (row.email !== email) continue;
      if (row.action === 'BUZZER_START') {
        currentSession = { activity_id: row.details, startTime: new Date(row.timestamp).getTime() };
        break;
      }
      if (row.action === 'BUZZER_STOP') break;
    }

    return jsonResponse(currentSession);
  }

  if (action === 'getFriends') {
    const currentUser = getUserByEmail(email);
    if (!currentUser) return jsonResponse({ success: false, message: 'User not found' });

    const referrals = getRecords(getSheet('Referrals'))
      .filter(row => row.referrer_code === currentUser.referral_code);
    const referredIds = Array.from(new Set(referrals.map(row => row.referred_user_id).filter(Boolean)));
    const userMap = {};
    getRecords(getSheet('Users')).forEach(row => {
      userMap[row.user_id] = row;
    });

    const friends = referredIds
      .map(userId => userMap[userId])
      .filter(Boolean)
      .filter(friend => normalizeBoolean(friend.share_progress, true))
      .map(friend => ({
        user_id: friend.user_id,
        name: friend.name || fallbackUserName(friend.user_id),
        email: friend.email
      }));

    return jsonResponse({ success: true, friends });
  }

  if (action === 'getFriendDashboard') {
    const friendUserId = e.parameter.friend_user_id;
    const currentUser = getUserByEmail(email);
    if (!currentUser) return jsonResponse({ success: false, message: 'User not found' });

    const hasAccess = getRecords(getSheet('Referrals')).some(row =>
      row.referrer_code === currentUser.referral_code && row.referred_user_id === friendUserId
    );
    if (!hasAccess) return jsonResponse({ success: false, message: 'Friend not found' });

    const friend = getRecords(getSheet('Users')).find(row => row.user_id === friendUserId);
    if (!friend || !normalizeBoolean(friend.share_progress, true)) {
      return jsonResponse({ success: false, message: 'Friend has hidden their progress' });
    }

    const activities = getRecords(getSheet('Activities')).filter(row => row.email === friend.email);
    const logs = getRecords(getSheet('Logs')).filter(row => row.email === friend.email);
    const logsByActivity = {};

    logs.forEach(log => {
      if (!logsByActivity[log.activity_id]) logsByActivity[log.activity_id] = [];
      logsByActivity[log.activity_id].push({
        timestamp: log.timestamp,
        duration: log.duration,
        status: log.status
      });
    });

    return jsonResponse({
      success: true,
      friend: {
        user_id: friend.user_id,
        name: friend.name || fallbackUserName(friend.user_id),
        habits: activities.map(activity => ({
          id: activity.id,
          name: activity.name,
          exceptional_day: activity.exceptional_day,
          logs: logsByActivity[activity.id] || []
        }))
      }
    });
  }

  return jsonResponse({ success: false, message: 'Unsupported action' });
}

function logAction(action, email, details) {
  const sheet = getSheet('System_Logs');
  sheet.appendRow(buildRow(sheet, {
    id: Utilities.getUuid(),
    action,
    timestamp: new Date(),
    details,
    email
  }));
  SpreadsheetApp.flush();
}

function ensureDbSchema() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  Object.keys(SHEET_HEADERS).forEach(name => {
    let sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    if (name === 'Users') migrateUsersSheet(sheet);
    if (name === 'Logs') migrateLogsSheet(sheet);
    ensureHeaders(sheet, SHEET_HEADERS[name]);
  });

  const usersSheet = getSheet('Users');
  const users = getRecords(usersSheet);
  users.forEach(user => {
    const updates = {};
    if (!user.user_id) updates.user_id = Utilities.getUuid();
    if (!user.referral_code) updates.referral_code = generateReferralCode();
    if (user.share_progress === '' || user.share_progress === null || user.share_progress === undefined) {
      updates.share_progress = true;
    }
    if (Object.keys(updates).length) updateRecord(usersSheet, user.__rowIndex, updates);
  });
}

function ensureHeaders(sheet, expectedHeaders) {
  const requiredWidth = expectedHeaders.length;

  if (sheet.getMaxColumns() < requiredWidth) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), requiredWidth - sheet.getMaxColumns());
  }

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, requiredWidth).setValues([expectedHeaders]);
    return;
  }

  sheet.getRange(1, 1, 1, requiredWidth).setValues([expectedHeaders]);
}

function migrateUsersSheet(sheet) {
  if (sheet.getLastRow() === 0) return;

  const currentWidth = Math.max(sheet.getLastColumn(), SHEET_HEADERS.Users.length);
  const values = sheet.getRange(1, 1, sheet.getLastRow(), currentWidth).getValues();
  const currentHeaders = values[0].map(value => value ? value.toString().trim() : '');
  const alreadyCurrent = SHEET_HEADERS.Users.every((header, index) => currentHeaders[index] === header);
  if (alreadyCurrent) return;

  const headerIndex = {};
  currentHeaders.forEach((header, index) => {
    if (header) headerIndex[header] = index;
  });

  if (headerIndex.email === undefined) return;

  const migratedRows = values.slice(1)
    .filter(row => row.some(cell => cell !== '' && cell !== null))
    .map(row => {
      const email = row[headerIndex.email] || '';
      const otp = headerIndex.otp !== undefined ? row[headerIndex.otp] : '';
      const otpExpiry = headerIndex.otp_expiry !== undefined ? row[headerIndex.otp_expiry] : '';
      const shareProgress = headerIndex.share_progress !== undefined
        ? row[headerIndex.share_progress]
        : true;
      const existingName = headerIndex.name !== undefined ? row[headerIndex.name] : '';
      const existingUserId = headerIndex.user_id !== undefined ? row[headerIndex.user_id] : '';
      const existingReferralCode = headerIndex.referral_code !== undefined ? row[headerIndex.referral_code] : '';

      return [
        existingUserId || Utilities.getUuid(),
        existingName || '',
        email,
        existingReferralCode || generateReferralCode(),
        normalizeBoolean(shareProgress, true),
        otp || '',
        otpExpiry || ''
      ];
    });

  const requiredWidth = SHEET_HEADERS.Users.length;
  if (sheet.getMaxColumns() < requiredWidth) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), requiredWidth - sheet.getMaxColumns());
  }

  sheet.clearContents();
  sheet.getRange(1, 1, 1, requiredWidth).setValues([SHEET_HEADERS.Users]);
  if (migratedRows.length) {
    sheet.getRange(2, 1, migratedRows.length, requiredWidth).setValues(migratedRows);
  }
}

function migrateLogsSheet(sheet) {
  if (sheet.getLastRow() === 0) return;

  const currentWidth = Math.max(sheet.getLastColumn(), SHEET_HEADERS.Logs.length);
  const values = sheet.getRange(1, 1, sheet.getLastRow(), currentWidth).getValues();
  const currentHeaders = values[0].map(value => value ? value.toString().trim() : '');
  const alreadyCurrent = SHEET_HEADERS.Logs.every((header, index) => currentHeaders[index] === header);
  if (alreadyCurrent) return;

  const headerIndex = {};
  currentHeaders.forEach((header, index) => {
    if (header) headerIndex[header] = index;
  });

  if (headerIndex.id === undefined || headerIndex.activity_id === undefined) return;
  const activityNameMap = {};
  getRecords(getSheet('Activities')).forEach(activity => {
    if (!activity.id) return;
    activityNameMap[`${activity.email}:${activity.id}`] = activity.name || '';
  });

  const migratedRows = values.slice(1)
    .filter(row => row.some(cell => cell !== '' && cell !== null))
    .map(row => {
      const activityId = row[headerIndex.activity_id] || '';
      const email = headerIndex.email !== undefined ? row[headerIndex.email] : '';
      const fallbackName = activityNameMap[`${email}:${activityId}`] || '';
      return [
        row[headerIndex.id] || Utilities.getUuid(),
        activityId,
        headerIndex.activity_name !== undefined ? (row[headerIndex.activity_name] || fallbackName) : fallbackName,
        headerIndex.timestamp !== undefined ? row[headerIndex.timestamp] : '',
        headerIndex.duration !== undefined ? row[headerIndex.duration] : '',
        headerIndex.status !== undefined ? row[headerIndex.status] : '',
        email
      ];
    });

  const requiredWidth = SHEET_HEADERS.Logs.length;
  if (sheet.getMaxColumns() < requiredWidth) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), requiredWidth - sheet.getMaxColumns());
  }

  sheet.clearContents();
  sheet.getRange(1, 1, 1, requiredWidth).setValues([SHEET_HEADERS.Logs]);
  if (migratedRows.length) {
    sheet.getRange(2, 1, migratedRows.length, requiredWidth).setValues(migratedRows);
  }
}

function getSheet(name) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
}

function getHeaderMap(sheet) {
  const headers = getSheetHeaders(sheet);
  const map = {};
  headers.forEach((header, index) => {
    map[header] = index;
  });
  return map;
}

function getRecords(sheet) {
  const rowCount = sheet.getLastRow();
  const headers = getSheetHeaders(sheet);
  const colCount = headers.length;
  if (rowCount <= 1 || colCount === 0) return [];

  const rows = sheet.getRange(2, 1, rowCount - 1, colCount).getValues();

  return rows.map((row, rowOffset) => {
    const record = { __rowIndex: rowOffset + 2 };
    headers.forEach((header, index) => {
      record[header] = row[index];
    });
    return record;
  });
}

function findRecordBy(sheet, fieldName, value) {
  const records = getRecords(sheet);
  const record = records.find(row => (row[fieldName] || '').toString().trim().toLowerCase() === value);
  if (!record) return null;
  return { rowIndex: record.__rowIndex, record };
}

function buildRow(sheet, values) {
  const headers = getSheetHeaders(sheet);
  return headers.map(header => values[header] !== undefined ? values[header] : '');
}

function appendRecord(sheet, values) {
  sheet.appendRow(buildRow(sheet, values));
}

function updateRecord(sheet, rowIndex, values) {
  const headerMap = getHeaderMap(sheet);
  const headers = getSheetHeaders(sheet);
  const rowValues = sheet.getRange(rowIndex, 1, 1, headers.length).getValues()[0];

  Object.keys(values).forEach(key => {
    if (headerMap[key] === undefined) return;
    rowValues[headerMap[key]] = values[key];
  });

  sheet.getRange(rowIndex, 1, 1, rowValues.length).setValues([rowValues]);
}

function getSheetHeaders(sheet) {
  const expectedHeaders = SHEET_HEADERS[sheet.getName()] || [];
  if (!expectedHeaders.length) {
    return sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0];
  }
  return expectedHeaders;
}

function deleteRowsMatching(sheet, predicate) {
  const rows = getRecords(sheet);
  let deleted = 0;

  for (let i = rows.length - 1; i >= 0; i--) {
    if (predicate(rows[i])) {
      sheet.deleteRow(rows[i].__rowIndex);
      deleted++;
    }
  }

  return deleted;
}

function getUserByEmail(email) {
  const usersSheet = getSheet('Users');
  const match = findRecordBy(usersSheet, 'email', email);
  if (!match) return null;
  return ensureUserRecord(usersSheet, match.rowIndex, match.record);
}

function ensureUserRecord(sheet, rowIndex, record) {
  const updates = {};
  if (!record.user_id) updates.user_id = Utilities.getUuid();
  if (!record.referral_code) updates.referral_code = generateReferralCode();
  if (record.share_progress === '' || record.share_progress === null || record.share_progress === undefined) {
    updates.share_progress = true;
  }

  if (Object.keys(updates).length) {
    updateRecord(sheet, rowIndex, updates);
    return {
      ...record,
      ...updates
    };
  }

  return record;
}

function saveReferralMappings(user, referralCodes) {
  const referralsSheet = getSheet('Referrals');
  const users = getRecords(getSheet('Users'));
  const validCodes = Array.from(new Set(
    referralCodes
      .map(code => (code || '').toString().trim().toUpperCase())
      .filter(Boolean)
      .filter(code => code !== user.referral_code)
      .filter(code => users.some(candidate => candidate.referral_code === code))
  ));

  if (!validCodes.length) return;

  const existingPairs = new Set(
    getRecords(referralsSheet).map(row => `${row.referrer_code}:${row.referred_user_id}`)
  );

  validCodes.forEach(code => {
    const key = `${code}:${user.user_id}`;
    if (existingPairs.has(key)) return;
    appendRecord(referralsSheet, {
      referrer_code: code,
      referred_user_id: user.user_id,
      created_at: new Date()
    });
    existingPairs.add(key);
  });
}

function serializeUser(user) {
  return {
    user_id: user.user_id,
    name: user.name || '',
    email: user.email,
    referral_code: user.referral_code,
    share_progress: normalizeBoolean(user.share_progress, true)
  };
}

function normalizeBoolean(value, fallback) {
  if (value === true || value === 'TRUE' || value === 'true') return true;
  if (value === false || value === 'FALSE' || value === 'false') return false;
  if (value === '' || value === null || value === undefined) return fallback;
  return Boolean(value);
}

function generateReferralCode() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 6).toUpperCase();
}

function fallbackUserName(userId) {
  return `User${(userId || '').toString().slice(0, 4) || '123'}`;
}

function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
