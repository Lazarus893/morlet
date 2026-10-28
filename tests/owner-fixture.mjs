import { createOwnerAuth, setOwnerPassword, OWNER_EMAIL } from '../plugins/webui/owner-auth.mjs';
export async function ownerSession(root, origin) {
  const password = 'fixture-only-password-23456';
  let service = await createOwnerAuth({ root, origin });
  if (!service.ready()) { service.close(); await setOwnerPassword({ root, origin, password }); service = await createOwnerAuth({ root, origin }); }
  try { return await service.auth.api.signInEmail({ body: { email: OWNER_EMAIL, password }, asResponse: true }); }
  finally { service.close(); }
}
