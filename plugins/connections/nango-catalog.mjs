// Fixed read surfaces used by the source adapters. No provider URL comes from
// the browser or an Agent. Query names are allowlisted along with each path.
const route = (path, query = []) => ({ path, query });
const page = ['per_page', 'page'];
export const NANGO_APIS = Object.freeze({
  github: { baseUrl: 'https://api.github.com', headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, routes: [
    route('/user'), route('/user/repos', [...page, 'type', 'sort', 'direction', 'affiliation']),
    route('/user/subscriptions', page), route('/user/starred', [...page, 'sort', 'direction']),
    route('/user/starred/:owner/:repo'), route('/search/issues', [...page, 'q', 'sort', 'order']),
    route('/notifications', [...page, 'all', 'participating', 'since', 'before']),
    route('/repos/:owner/:repo'), route('/repos/:owner/:repo/subscription'),
    route('/repos/:owner/:repo/releases', page), route('/repos/:owner/:repo/releases/:id'),
    route('/repos/:owner/:repo/commits', [...page, 'sha', 'since', 'until', 'path', 'author']),
    route('/repos/:owner/:repo/commits/:sha', page),
    route('/repos/:owner/:repo/pulls/:id'), route('/repos/:owner/:repo/issues/:id'),
  ] },
  gmail: { baseUrl: 'https://gmail.googleapis.com', routes: [
    route('/gmail/v1/users/me/profile'),
    route('/gmail/v1/users/me/messages', ['maxResults', 'pageToken', 'q', 'labelIds', 'includeSpamTrash']),
    route('/gmail/v1/users/me/messages/:id', ['format', 'metadataHeaders', 'fields']),
    route('/gmail/v1/users/me/threads', ['maxResults', 'pageToken', 'q', 'labelIds', 'includeSpamTrash']),
    route('/gmail/v1/users/me/threads/:id', ['format', 'metadataHeaders', 'fields']),
  ] },
  calendar: { baseUrl: 'https://www.googleapis.com', routes: [
    route('/calendar/v3/users/me/calendarList', ['maxResults', 'pageToken', 'minAccessRole']),
    route('/calendar/v3/calendars/:calendarId/events', ['timeMin', 'timeMax', 'timeZone', 'singleEvents', 'orderBy', 'maxResults', 'pageToken', 'q', 'fields']),
    route('/calendar/v3/calendars/:calendarId'),
  ] },
  drive: { baseUrl: 'https://www.googleapis.com', routes: [
    route('/drive/v3/about', ['fields']),
    route('/drive/v3/files', ['q', 'pageSize', 'pageToken', 'orderBy', 'fields', 'spaces', 'corpora', 'driveId', 'includeItemsFromAllDrives', 'supportsAllDrives']),
    route('/drive/v3/files/:id', ['fields', 'supportsAllDrives']),
  ] },
  docs: { baseUrl: 'https://docs.googleapis.com', routes: [route('/v1/documents/:id', ['fields', 'includeTabsContent', 'suggestionsViewMode'])] },
  sheets: { baseUrl: 'https://sheets.googleapis.com', routes: [
    route('/v4/spreadsheets/:id', ['fields', 'includeGridData', 'ranges']),
    route('/v4/spreadsheets/:id/values/:range', ['majorDimension', 'valueRenderOption', 'dateTimeRenderOption', 'fields']),
    route('/v4/spreadsheets/:id/values:batchGet', ['ranges', 'majorDimension', 'valueRenderOption', 'dateTimeRenderOption', 'fields']),
  ] },
  people: { baseUrl: 'https://people.googleapis.com', routes: [
    route('/v1/people/me', ['personFields']),
    route('/v1/people/me/connections', ['personFields', 'pageSize', 'pageToken', 'sortOrder']),
    route('/v1/people:searchContacts', ['query', 'readMask', 'pageSize']),
  ] },
  oauth2: { baseUrl: 'https://www.googleapis.com', routes: [route('/oauth2/v2/userinfo')] },
  x: { baseUrl: 'https://api.x.com', routes: [
    route('/2/users/me', ['user.fields']),
    route('/2/users/:id/timelines/reverse_chronological', ['max_results', 'pagination_token', 'since_id', 'until_id', 'start_time', 'end_time', 'exclude', 'post.fields', 'user.fields', 'media.fields', 'expansions']),
    route('/2/tweets', ['ids', 'post.fields', 'user.fields', 'media.fields', 'expansions']),
    route('/2/tweets/:id', ['post.fields', 'user.fields', 'media.fields', 'expansions']),
  ] },
});

export function nangoServiceApis(service) {
  if (service === 'google') return ['gmail', 'calendar', 'drive', 'docs', 'sheets', 'people', 'oauth2'];
  const google = { 'google-mail': 'gmail', 'google-calendar': 'calendar', 'google-drive': 'drive', 'google-docs': 'docs', 'google-sheets': 'sheets', 'google-contacts': 'people' };
  if (google[service]) return [google[service], 'oauth2'];
  return ['github', 'x'].includes(service) ? [service] : [];
}

export function nangoPathMatches(template, path) {
  const expected = template.split('/'), actual = path.split('/');
  return expected.length === actual.length && expected.every((part, i) => part.startsWith(':') ? actual[i].length > 0 : actual[i] === part);
}
