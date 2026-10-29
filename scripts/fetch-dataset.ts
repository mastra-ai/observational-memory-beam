/**
 * Downloads the BEAM dataset into data/beam, at the commit our numbers were run on.
 *
 * The repository carries a .pickle duplicate of every file and generator notes that
 * hold the answers, none of which the harness reads. A sparse checkout fetches only
 * the two files it does read per conversation: chat.json and
 * probing_questions/probing_questions.json.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = 'https://github.com/mohammadtavakoli78/BEAM.git';
const COMMIT = '3e12035532eb85768f1a7cd779832b650c4b2ef9';
const dest = resolve(process.env.BEAM_DATA_DIR ?? './data/beam');

if (existsSync(dest)) {
  console.log(`${dest} already exists, skipping.`);
  process.exit(0);
}

const git = (...args: string[]) => execFileSync('git', args, { cwd: dest, stdio: 'inherit' });
console.log(`Fetching BEAM ${COMMIT.slice(0, 7)} into ${dest}...`);
execFileSync('git', ['init', '-q', dest], { stdio: 'inherit' });
git('remote', 'add', 'origin', REPO);
git('sparse-checkout', 'set', '--no-cone', '/chats/*/*/chat.json', '/chats/*/*/probing_questions/probing_questions.json');
git('fetch', '--depth', '1', '--filter=blob:none', 'origin', COMMIT);
git('checkout', '-q', 'FETCH_HEAD');
console.log('Done.');
