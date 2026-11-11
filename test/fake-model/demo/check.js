// The demo's "test suite": checks that the three files carry the config command.
// `npm test -- --slow` sleeps for two minutes, to test cancelling a long run_tests.
const fs = require('fs');

if (process.argv.includes('--slow')) {
  console.log('slow tests started');
  setTimeout(() => process.exit(0), 120000);
} else {
  const checks = [
    ['app/cli.py has the config command', fs.readFileSync('app/cli.py', 'utf8').includes('def config_command')],
    ['tests/test_cli.py tests it', fs.readFileSync('tests/test_cli.py', 'utf8').includes('def test_config_masks_secrets')],
    ['docs/cli.md documents it', fs.readFileSync('docs/cli.md', 'utf8').includes('## config')],
  ];
  for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
}
