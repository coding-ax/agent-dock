// Run in a child process: a native addon assertion aborts Node, not just a test.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const Database = require(process.argv[2]);
const db = new Database(':memory:');
db.exec('CREATE TABLE events (sequence INTEGER PRIMARY KEY, data TEXT NOT NULL)');

// Collect short-lived prepared statements while another V8 context is active.
// Node 24.20.0's ObjectWrap cleanup asks for that context's Node Environment;
// a plain vm context has none. N-API must finalize these statements safely.
for (let batch = 0; batch < 20; batch++) {
  db.prepare('INSERT INTO events(data) VALUES (?)').run('中文事件');
  for (let i = 0; i < 5000; i++) {
    assert.equal(db.prepare('SELECT data FROM events ORDER BY sequence DESC LIMIT 1').get().data, '中文事件');
  }
  // Explicit gc() alone does not reproduce the failure: allocate in the foreign
  // context so V8 itself collects statements prepared in the main context.
  vm.runInNewContext('const items = []; for (let i = 0; i < 200000; i++) items.push({ value: i });');
}
assert.equal(db.prepare('SELECT count(*) AS count FROM events').get().count, 20);
db.close();
process.stdout.write('sqlite-gc-ok\n');
