import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { fromNodeHeaders } from 'better-auth/node';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, realpathSync, lstatSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { join } from 'node:path';

export const OWNER_EMAIL = 'owner@xiaoman.local';
export const secureOrigin = origin => { const url = new URL(origin); return url.protocol === 'https:' || ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname); };

export async function createOwnerAuth({ root, origin, provision = false, onResetToken } = {}) {
  const directory = join(root, '.runtime/owner'); mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) throw new Error('OWNER_STORAGE_INVALID');
  chmodSync(directory, 0o700);
  const secretPath = join(directory, 'secret');
  try { writeFileSync(secretPath, randomBytes(48).toString('base64url'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!lstatSync(secretPath).isFile() || lstatSync(secretPath).isSymbolicLink()) throw new Error('OWNER_STORAGE_INVALID');
  chmodSync(secretPath, 0o600);
  const secret = readFileSync(secretPath, 'utf8');
  if (secret.length < 32) throw new Error('OWNER_SECRET_INVALID');
  const path = join(directory, 'auth.sqlite');
  try { if (lstatSync(path).isSymbolicLink()) throw new Error('OWNER_STORAGE_INVALID'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const database = new DatabaseSync(path); chmodSync(path, 0o600);
  database.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  const options = {
    appName: 'Morlet', baseURL: origin, basePath: '/api/auth', secret, database,
    trustedOrigins: [origin], telemetry: { enabled: false }, logger: { disabled: true },
    emailAndPassword: { enabled: true, disableSignUp: !provision, minPasswordLength: 12, maxPasswordLength: 128, autoSignIn: false,
      revokeSessionsOnPasswordReset: true, ...(onResetToken && { sendResetPassword: async ({ token }) => onResetToken(token) }) },
    session: { expiresIn: 7 * 86400, disableSessionRefresh: true, cookieCache: { enabled: false } },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 30, customRules: { '/sign-in/email': { window: 60, max: 5 } } },
    advanced: { cookiePrefix: 'xiaoman_' + createHash('sha256').update(realpathSync(root)).digest('hex').slice(0, 12),
      useSecureCookies: new URL(origin).protocol === 'https:', defaultCookieAttributes: { sameSite: 'strict', httpOnly: true },
      // Never trust caller-supplied proxy headers for login throttling.
      ipAddress: { ipAddressHeaders: ['x-pa-client-address'] } },
  };
  try {
    await (await getMigrations(options)).runMigrations();
    const auth = betterAuth(options);
    return { auth, ready: () => !!database.prepare('SELECT 1 FROM user WHERE email=?').get(OWNER_EMAIL),
      session: async headers => {
        const value = await auth.api.getSession({ headers: fromNodeHeaders(headers) });
        return value?.user?.email === OWNER_EMAIL ? value : null;
      }, close: () => database.close() };
  } catch (error) { database.close(); throw error; }
}

// Local administration only. Never mount this provisioning instance as an HTTP
// handler. A separate SQLite lock serializes owner creation/reset across CLIs.
export async function setOwnerPassword({ root, password, reset = false, origin = 'http://127.0.0.1:3083' }) {
  const directory = join(root, '.runtime/owner'); mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) throw new Error('OWNER_STORAGE_INVALID');
  const lockPath = join(directory, 'admin.sqlite');
  try { if (lstatSync(lockPath).isSymbolicLink()) throw new Error('OWNER_STORAGE_INVALID'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const lock = new DatabaseSync(lockPath); chmodSync(lockPath, 0o600);
  let service, token;
  try {
    lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    service = await createOwnerAuth({ root, origin, provision: true, onResetToken: value => { token = value; } });
    if (service.ready()) {
      if (!reset) throw new Error('OWNER_ALREADY_CONFIGURED');
      await service.auth.api.requestPasswordReset({ body: { email: OWNER_EMAIL } });
      if (!token) throw new Error('OWNER_RESET_FAILED');
      await service.auth.api.resetPassword({ body: { token, newPassword: password } });
    } else await service.auth.api.signUpEmail({ body: { email: OWNER_EMAIL, name: '主人', password } });
  } finally { service?.close(); lock.close(); }
}
