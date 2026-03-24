/* 
  PREMIUM SETUP SCRIPT for Habit Tracker DB (Isolated & Persistent)
  1. Go to sheets.new and name it "Habit Tracker DB".
  2. Extensions > Apps Script > Paste this code.
  3. Click Run 'setupDB' first.
  4. Deploy > New Deployment > Web App (Set "Who has access" to "Anyone").
*/

function setupDB() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tabs = ['Activities', 'Logs', 'System_Logs', 'Users'];
  
  tabs.forEach(tab => {
    let sheet = ss.getSheetByName(tab);
    if (!sheet) {
      sheet = ss.insertSheet(tab);
      if (tab === 'Activities') sheet.appendRow(['id', 'name', 'created_at', 'email', 'exceptional_day']);
      if (tab === 'Logs') sheet.appendRow(['id', 'activity_id', 'timestamp', 'duration', 'status', 'email']);
      if (tab === 'System_Logs') sheet.appendRow(['id', 'action', 'timestamp', 'details', 'email']);
      if (tab === 'Users') sheet.appendRow(['email', 'otp', 'otp_expiry']);
    }
  });
  SpreadsheetApp.flush();
}

/** 
 * Use this to completely clear and reset the database structure.
 * WARNING: This deletes all data!
 */
function resetDB() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tabs = ['Activities', 'Logs', 'System_Logs', 'Users'];
  tabs.forEach(t => {
    let s = ss.getSheetByName(t);
    if (s) ss.deleteSheet(s);
  });
  setupDB();
}

function doPost(e) {
  const data = JSON.parse(e.postData.contents);
  const action = data.action;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const email = data.email;
  
  if (action === 'sendOTP') {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = new Date(new Date().getTime() + 5 * 60000); // 5 min
    const sheet = ss.getSheetByName('Users');
    const rows = sheet.getDataRange().getValues();
    let found = false;
    for (let i = 1; i < rows.length; i++) {
        if (rows[i][0] === email) {
            sheet.getRange(i + 1, 2, 1, 2).setValues([[otp, expiry]]);
            found = true; break;
        }
    }
    if (!found) sheet.appendRow([email, otp, expiry]);
    SpreadsheetApp.flush();
    
    // Premium HTML Email
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
        MailApp.sendEmail({
          to: email,
          subject: `HabitApp | Access Code for ${email}`,
          htmlBody: htmlBody
        });
    } catch (e) { console.warn("MailApp failed", e); }
    
    return ContentService.createTextOutput(JSON.stringify({ success: true, otp })).setMimeType(ContentService.MimeType.JSON);
  }
  
  if (action === 'verifyOTP') {
    const { otp } = data;
    const sheet = ss.getSheetByName('Users');
    const rows = sheet.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === email && rows[i][1].toString() === otp.toString()) {
        const expiry = new Date(rows[i][2]);
        if (new Date() < expiry) {
          logAction('LOGIN_SUCCESS', email, 'Success');
          return ContentService.createTextOutput(JSON.stringify({ success: true })).setMimeType(ContentService.MimeType.JSON);
        }
      }
    }
    return ContentService.createTextOutput(JSON.stringify({ success: false, message: 'Invalid or expired OTP' })).setMimeType(ContentService.MimeType.JSON);
  }

  if (action === 'createActivity') {
    const { name, exceptional_day } = data;
    const sheet = ss.getSheetByName('Activities');
    const id = Utilities.getUuid();
    sheet.appendRow([id, name, new Date(), email, exceptional_day]);
    logAction('ACTIVITY_CREATED', email, name);
    SpreadsheetApp.flush();
    return ContentService.createTextOutput(JSON.stringify({ success: true, id })).setMimeType(ContentService.MimeType.JSON);
  }

  if (action === 'logBuzzer') {
    const { activity_id, status, duration, action_type } = data;
    const logsSheet = ss.getSheetByName('Logs');
    const timestamp = new Date();
    
    logAction(action_type, email, activity_id || 'N/A');
    
    if (action_type === 'BUZZER_STOP') {
      logsSheet.appendRow([Utilities.getUuid(), activity_id, timestamp, duration, status, email]);
    }
    SpreadsheetApp.flush();
    return ContentService.createTextOutput(JSON.stringify({ success: true })).setMimeType(ContentService.MimeType.JSON);
  }

  if (action === 'logout') {
    logAction('LOGOUT', email, 'Success');
    SpreadsheetApp.flush();
    return ContentService.createTextOutput(JSON.stringify({ success: true })).setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  const action = e.parameter.action;
  const email = e.parameter.email;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  if (action === 'getActivities') {
    const sheet = ss.getSheetByName('Activities');
    const rows = sheet.getDataRange().getValues();
    const data = rows.length > 1 ? rows.slice(1)
        .filter(r => r[3] === email)
        .map(r => ({ id: r[0], name: r[1], exceptional_day: r[4] })) : [];
    return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
  }

  if (action === 'getLogs') {
    const activity_id = e.parameter.activity_id;
    const sheet = ss.getSheetByName('Logs');
    const rows = sheet.getDataRange().getValues();
    const data = rows.length > 1 ? rows.slice(1)
      .filter(r => r[1] === activity_id && r[5] === email)
      .map(r => ({ timestamp: r[2], duration: r[3], status: r[4] })) : [];
    return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
  }

  if (action === 'checkSession') {
    const sheet = ss.getSheetByName('System_Logs');
    const rows = sheet.getDataRange().getValues();
    let currentSession = null;
    
    for (let i = rows.length - 1; i >= 1; i--) {
      if (rows[i][4] === email) {
        if (rows[i][1] === 'BUZZER_START') {
          currentSession = { activity_id: rows[i][3], startTime: new Date(rows[i][2]).getTime() };
          break;
        } else if (rows[i][1] === 'BUZZER_STOP') {
          break;
        }
      }
    }
    return ContentService.createTextOutput(JSON.stringify(currentSession)).setMimeType(ContentService.MimeType.JSON);
  }
}

function logAction(action, email, details) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('System_Logs');
  sheet.appendRow([Utilities.getUuid(), action, new Date(), details, email]);
  SpreadsheetApp.flush();
}
