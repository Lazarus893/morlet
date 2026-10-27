import { readFile, stat } from 'node:fs/promises';

const directory = new URL('../../skills/xiaoman-journal-design/', import.meta.url);
const files = ['SKILL.md', 'references/runtime-design.md', 'references/selection-protocol.md',
  'references/design-principles.md', 'references/dashboard-patterns.md', 'references/states-motion.md'];

// Passive providers have no filesystem tool. Load the packaged rules ourselves,
// so installed skills are used without widening the model's permissions.
export async function designSkillInstructions(rolePath) {
  const parts = [];
  let bytes = 0;
  for (const name of files) {
    const path = new URL(name, directory), info = await stat(path);
    if (!info.isFile() || info.size > 24000) throw new Error('INVALID_DESIGN_SKILL');
    const value = await readFile(path, 'utf8');
    bytes += Buffer.byteLength(value);
    if (bytes > 80000) throw new Error('INVALID_DESIGN_SKILL');
    parts.push(`## ${name}\n${value}`);
  }
  if (rolePath) {
    const value = await readFile(rolePath, 'utf8');
    if (Buffer.byteLength(value) > 24000) throw new Error('INVALID_DESIGN_ROLE');
    parts.push('## 本实例的设计补充\n' + value);
  }
  return parts.join('\n\n');
}
