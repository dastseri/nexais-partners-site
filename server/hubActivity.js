// Maps one hub call-log entry (from the in-page activity log) to a CRM
// partner_activity_log row on the business's mission.

export const OUTCOME_CODES = {
  'Not called': 'not_called',
  'Reached decision-maker': 'reached_decision_maker',
  'Gatekeeper': 'gatekeeper',
  'Voicemail left': 'voicemail_left',
  'Not interested': 'not_interested',
  'Callback scheduled': 'callback_scheduled',
  'Demo booked': 'demo_booked',
};

const ACTION_CODES = { Call: 'call', SMS: 'sms', Email: 'email', DM: 'note', Visit: 'visit' };

export function dedupePrefix(businessName) {
  return String(businessName || '').replace(/[^A-Za-z0-9]+/g, '').toLowerCase();
}

function clip(value, max) {
  if (value === undefined || value === null) return null;
  const text = String(value);
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * Validate and translate a hub entry. Returns { row } or { error }.
 * entry: { at, business, what: 'status'|'notes'|'action', from, to }
 */
export function mapHubEntry(entry) {
  if (!entry || typeof entry !== 'object') return { error: 'Invalid entry' };
  const business = clip(entry.business, 200);
  if (!business || !dedupePrefix(business)) return { error: 'Business name is required' };
  const at = clip(entry.at, 40);
  const stamp = at ? ` (logged on device ${at})` : '';
  if (entry.what === 'status') {
    const outcome = OUTCOME_CODES[entry.to];
    if (!outcome) return { error: 'Unknown call outcome' };
    return {
      business,
      row: {
        action: 'call',
        outcome,
        from_value: clip(entry.from, 100),
        to_value: clip(entry.to, 100),
        notes: `Call outcome recorded in hub${stamp}`,
      },
    };
  }
  if (entry.what === 'notes') {
    return { business, row: { action: 'note', notes: (clip(entry.to, 3800) || '') + stamp } };
  }
  if (entry.what === 'action') {
    const action = ACTION_CODES[entry.to];
    if (!action) return { error: 'Unknown action type' };
    return {
      business,
      row: { action, to_value: clip(entry.to, 100), notes: `${entry.to} logged in hub${stamp}` },
    };
  }
  return { error: 'Unknown entry type' };
}
