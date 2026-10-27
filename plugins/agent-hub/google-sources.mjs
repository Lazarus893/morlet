import { createHash } from 'node:crypto';
import { failure } from './store.mjs';

export const GOOGLE_SCOPES = Object.freeze({
  gmail: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.modify', 'https://mail.google.com/'],
  calendar: ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar'],
  drive: ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive'],
  docs: ['https://www.googleapis.com/auth/documents.readonly', 'https://www.googleapis.com/auth/documents'],
  sheets: ['https://www.googleapis.com/auth/spreadsheets.readonly', 'https://www.googleapis.com/auth/spreadsheets'],
  contacts: ['https://www.googleapis.com/auth/contacts.readonly', 'https://www.googleapis.com/auth/contacts'],
});
export const validGoogleId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value);
export function sheetBounds(range) {
  if (typeof range !== 'string' || range.length > 200 || /[\x00-\x1f\x7f\\]/.test(range)) return null;
  const match = /^(?:(?:'(?:[^']|'')+'|[^'!\[\]:*?\/]+)!)?([A-Z]{1,3})([1-9]\d{0,6}):([A-Z]{1,3})([1-9]\d{0,6})$/.exec(range);
  if (!match || range.startsWith('-')) return null;
  const column = value => [...value].reduce((sum, c) => sum * 26 + c.charCodeAt(0) - 64, 0);
  const startColumn = column(match[1]), startRow = Number(match[2]), endColumn = column(match[3]), endRow = Number(match[4]);
  const rows = endRow - startRow + 1, columns = endColumn - startColumn + 1;
  return rows > 0 && columns > 0 && rows <= 200 && columns <= 50 && rows * columns <= 1000 && endRow <= 1000000 && endColumn <= 18278 ? { rows, columns } : null;
}

/** Called only after the exact auth-list --check command, never from source text. */
export function googleIdentity(data, account, service) {
  if (!data || !Array.isArray(data.accounts) || data.accounts.length > 100) throw failure('INVALID_SOURCE_RESPONSE');
  const matches = data.accounts.filter(row => typeof row?.email === 'string' && row.email.toLowerCase() === account.toLowerCase());
  if (matches.length !== 1) throw failure('SOURCE_ACCOUNT_CHANGED');
  const row = matches[0];
  if (row.valid !== true) throw failure('SOURCE_AUTHORIZATION_REQUIRED');
  if (!Array.isArray(row.services) || row.services.length > 100 || row.services.some(v => typeof v !== 'string' || v.length > 500) ||
      !Array.isArray(row.scopes) || row.scopes.length > 100 || row.scopes.some(v => typeof v !== 'string' || v.length > 500)) throw failure('INVALID_SOURCE_RESPONSE');
  if (!row.services.includes(service) || !GOOGLE_SCOPES[service]?.some(scope => row.scopes.includes(scope))) throw failure('SOURCE_SCOPE_MISSING');
  const metadata = { account: account.toLowerCase(), services: [...new Set(row.services)].sort(), scopes: [...new Set(row.scopes)].sort() };
  for (const key of ['client', 'created_at', 'auth']) {
    if (row[key] !== undefined && (typeof row[key] !== 'string' || row[key].length > 500)) throw failure('INVALID_SOURCE_RESPONSE');
    metadata[key] = row[key] ?? null;
  }
  return createHash('sha256').update(JSON.stringify(metadata)).digest('hex');
}

/** Fixed gog read commands; no export/download, URLs, scripts or mutation verbs. */
export async function googleSource({ args, json, clean, boundedText, secretContent, sensitiveName }) {
  const max = args.max ?? 10;
  const text = (value, limit) => {
    if (typeof value !== 'string') throw failure('INVALID_SOURCE_RESPONSE');
    if (secretContent(value)) throw failure('SOURCE_SENSITIVE_CONTENT');
    const normalized = clean(value, Number.MAX_SAFE_INTEGER), output = boundedText(normalized);
    if (limit === undefined) return output;
    const clipped = clean(normalized, limit), truncated = clipped !== normalized;
    return { text: clipped, complete: !truncated, truncated };
  };
  const file = value => {
    if (!value || !validGoogleId(value.id) || typeof value.name !== 'string' || typeof value.mimeType !== 'string') throw failure('INVALID_SOURCE_RESPONSE');
    if (sensitiveName(value.name) || secretContent(value.name)) throw failure('SOURCE_SENSITIVE_CONTENT');
    return { id: value.id, name: clean(value.name, 500), mimeType: clean(value.mimeType, 150), modifiedAt: clean(value.modifiedTime, 80),
      size: /^\d{1,20}$/.test(String(value.size ?? '')) ? String(value.size) : null, url: 'https://drive.google.com/file/d/' + value.id + '/view' };
  };
  if (['drive_search', 'drive_recent'].includes(args.operation)) {
    const value = await json(args.operation === 'drive_search' ? ['drive', 'search', args.query, '--max', String(max)] : ['drive', 'ls', '--max', String(max)]);
    if (!Array.isArray(value.files)) throw failure('INVALID_SOURCE_RESPONSE');
    let excludedSensitive = 0;
    const files = value.files.slice(0, max).flatMap(entry => {
      if (typeof entry?.name === 'string' && (sensitiveName(entry.name) || secretContent(entry.name))) { excludedSensitive++; return []; }
      return [file(entry)];
    });
    const truncated = value.files.length > max || Boolean(value.nextPageToken);
    return { files, coverage: args.operation === 'drive_recent' ? 'drive_root_folder_recent_metadata_only' : 'matching_file_metadata_only',
      ...(args.operation === 'drive_recent' ? { note: 'Recent modified files in the My Drive root folder only; nested folders and the entire Drive are not covered.' } : {}), excludedSensitive, complete: !truncated, truncated };
  }
  if (args.operation === 'drive_metadata') {
    const value = await json(['drive', 'get', args.fileId]);
    if (value.file?.id !== args.fileId) throw failure('INVALID_SOURCE_RESPONSE');
    const description = text(value.file.description ?? '', 3000);
    return { file: { ...file(value.file), description: description.text }, coverage: 'file_metadata_only', complete: description.complete, truncated: description.truncated };
  }
  if (args.operation === 'docs_read') {
    // gog 0.9 emits only {text}, and may cut a UTF-8 byte sequence at this limit.
    const value = await json(['docs', 'cat', args.documentId, '--max-bytes', '80004'], 600000);
    if (typeof value.text !== 'string') throw failure('SOURCE_BODY_UNAVAILABLE');
    const output = text(value.text), truncated = output.truncated || Buffer.byteLength(value.text, 'utf8') >= 80000 || value.text.endsWith('\ufffd');
    return { documentId: args.documentId, coverage: 'document_body_plain_text_only', note: 'Extracted body paragraphs and tables; comments, images, external links and other tabs are not read.', ...output, complete: !truncated, truncated };
  }
  if (args.operation === 'sheets_metadata') {
    const value = await json(['sheets', 'metadata', args.spreadsheetId], 1500000);
    if (value.spreadsheetId !== args.spreadsheetId || typeof value.title !== 'string' || !Array.isArray(value.sheets)) throw failure('INVALID_SOURCE_RESPONSE');
    if (secretContent(value.title)) throw failure('SOURCE_SENSITIVE_CONTENT');
    const sheets = value.sheets.slice(0, 50).map(sheet => {
      const p = sheet?.properties;
      if (!p || p.sheetId !== undefined && (!Number.isSafeInteger(p.sheetId) || p.sheetId < 0) || typeof p.title !== 'string' || secretContent(p.title)) throw failure(secretContent(p?.title || '') ? 'SOURCE_SENSITIVE_CONTENT' : 'INVALID_SOURCE_RESPONSE');
      // Google sheets with ID 0 omit sheetId through gog's Go omitempty encoding.
      return { id: p.sheetId ?? 0, title: clean(p.title, 200), rows: Number.isSafeInteger(p.gridProperties?.rowCount) ? p.gridProperties.rowCount : null, columns: Number.isSafeInteger(p.gridProperties?.columnCount) ? p.gridProperties.columnCount : null };
    });
    return { spreadsheetId: args.spreadsheetId, title: clean(value.title, 500), locale: clean(value.locale, 80), timeZone: clean(value.timeZone, 100), sheets,
      coverage: 'spreadsheet_metadata_only', complete: value.sheets.length <= 50, truncated: value.sheets.length > 50 };
  }
  if (args.operation === 'sheets_read') {
    const bounds = sheetBounds(args.range), value = await json(['sheets', 'get', args.spreadsheetId, args.range, '--dimension', 'ROWS', '--render', 'FORMATTED_VALUE'], 1500000);
    if (typeof value.range !== 'string' || value.range.length > 250 || value.values !== undefined && value.values !== null && !Array.isArray(value.values)) throw failure('INVALID_SOURCE_RESPONSE');
    const rows = value.values ?? [];
    if (rows.length > bounds.rows || rows.some(row => !Array.isArray(row) || row.length > bounds.columns)) throw failure('INVALID_SOURCE_RESPONSE');
    let remaining = 20000, truncated = false;
    const values = rows.map(row => row.map(cell => {
      if (typeof cell === 'number' && Number.isFinite(cell) || typeof cell === 'boolean' || cell === null) return cell;
      if (typeof cell !== 'string') throw failure('INVALID_SOURCE_RESPONSE');
      if (secretContent(cell)) throw failure('SOURCE_SENSITIVE_CONTENT');
      const normalized = clean(cell, Number.MAX_SAFE_INTEGER), clipped = clean(normalized, Math.min(2000, remaining));
      remaining -= Array.from(clipped).length; truncated ||= clipped !== normalized; return clipped;
    }));
    return { spreadsheetId: args.spreadsheetId, requestedRange: args.range, range: clean(value.range, 250), values, coverage: 'requested_formatted_values_only', fullSpreadsheetRead: false, complete: !truncated, truncated };
  }
  if (args.operation === 'contacts_search') {
    const value = await json(['contacts', 'search', args.query, '--max', String(max)]);
    if (!Array.isArray(value.contacts)) throw failure('INVALID_SOURCE_RESPONSE');
    const contacts = value.contacts.slice(0, max).map(contact => {
      if (typeof contact?.resource !== 'string' || !/^people\/[A-Za-z0-9_-]{1,200}$/.test(contact.resource)) throw failure('INVALID_SOURCE_RESPONSE');
      const fields = ['name', 'email', 'phone'].map(key => [key, text(contact[key] ?? '', 500)]);
      return { id: contact.resource, ...Object.fromEntries(fields.map(([key, item]) => [key, item.text])), truncated: fields.some(([, item]) => item.truncated) };
    });
    const truncated = value.contacts.length >= max || contacts.some(contact => contact.truncated);
    return { contacts, coverage: 'matching_contacts_primary_fields_only', fullAddressBookRead: false, complete: !truncated, truncated };
  }
  throw failure('INVALID_INPUT');
}
