// CLI: node dist/bench/report-cli.js [resultsDir]  (defaults to newest run)
import * as path from 'node:path';
import { generateReport, newestResultsDir } from './report';

const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const dir = arg ? path.resolve(arg) : newestResultsDir();
if (!dir) {
  console.error('No benchmark results found. Run `npm run bench` first.');
  process.exit(1);
}
generateReport(dir);
console.log(`Report written to ${path.join(dir, 'report.md')} and report.html`);
