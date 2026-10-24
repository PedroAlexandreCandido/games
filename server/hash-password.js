// Prints an ADMIN_USERS entry for a new admin account.
// Usage: npm run hash-password -- <username>   (then type the password)
import { createInterface } from 'node:readline/promises';
import { hashPassword } from './auth.js';

const username = process.argv[2];
if (!username || /[:,]/.test(username)) {
  console.error('Usage: npm run hash-password -- <username>   (no ":" or "," in the name)');
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
// Hide the password while it's typed.
rl._writeToOutput = (s) => rl.output.write(s.includes('\n') ? '\n' : '');
process.stderr.write(`Password for ${username}: `);
const password = await rl.question('');
rl.close();

if (password.length < 8) {
  console.error('Use at least 8 characters.');
  process.exit(1);
}
console.log(`${username}:${hashPassword(password)}`);
