#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { setOwnerPassword } from '../plugins/webui/owner-auth.mjs';

const args = process.argv.slice(2), reset = args.includes('--reset');
if (args.some(arg => !['--reset', '--password-stdin'].includes(arg))) { console.error('Usage: pa.sh owner [--reset] [--password-stdin]'); process.exit(2); }
const root = fileURLToPath(new URL('..', import.meta.url));
let password;
if (args.includes('--password-stdin')) {
  let text = ''; for await (const chunk of process.stdin) { text += chunk; if (text.length > 256) throw new Error('PASSWORD_TOO_LONG'); }
  password = text.replace(/\r?\n$/, '');
} else {
  if (!process.stdin.isTTY) { console.error('请在终端运行；脚本调用可用 --password-stdin。'); process.exit(2); }
  let muted = false;
  const output = new Writable({ write(chunk, _encoding, next) { if (!muted) process.stdout.write(chunk); next(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  process.stdout.write(reset ? '新主人密码（至少 12 位，将退出所有设备）：' : '主人密码（至少 12 位）：'); muted = true;
  try { password = await rl.question(''); process.stdout.write('\n再次输入：'); const confirmed = await rl.question(''); if (confirmed !== password) throw new Error('两次密码不一致'); }
  finally { muted = false; process.stdout.write('\n'); rl.close(); }
}
try { await setOwnerPassword({ root, password, reset }); console.log('主人密码已保存。打开小满后登录。'); }
catch (error) { console.error(error.message === 'OWNER_ALREADY_CONFIGURED' ? '已经设置主人密码；重设请使用 --reset。' : '未保存密码，请检查长度或稍后重试。'); process.exitCode = 1; }
