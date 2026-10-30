import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import {
  access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Jsonl } from '../dist/esm/index.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'jsonl-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, file: join(directory, 'records.jsonl') };
}

test('basic API creates parents, appends, replaces, removes and clears', async (t) => {
  const { directory } = await fixture(t);
  const file = join(directory, 'nested', 'data', 'records.jsonl');
  const jsonl = new Jsonl(file);

  await jsonl.append({ id: 1 });
  await jsonl.append([{ id: 2 }, { id: 3 }]);
  assert.deepEqual(await jsonl.read(), [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.equal(await jsonl.remove((record) => record.id % 2 === 1), 2);
  assert.deepEqual(await jsonl.read(), [{ id: 2 }]);
  assert.equal(await jsonl.remove(() => false), 0);

  await jsonl.write([{ id: 4 }]);
  assert.deepEqual(await jsonl.read(), [{ id: 4 }]);
  await jsonl.clear();
  assert.equal(await readFile(file, 'utf8'), '');
  assert.deepEqual(await jsonl.read(), []);
  assert.deepEqual(await readdir(join(directory, 'nested', 'data')), ['records.jsonl']);
});

test('missing and empty files return no records', async (t) => {
  const { directory } = await fixture(t);
  const file = join(directory, 'missing', 'records.jsonl');
  const jsonl = new Jsonl(file);

  assert.deepEqual(await jsonl.read(), []);
  assert.equal(await jsonl.remove(() => true), 0);
  await jsonl.append([]);
  await assert.rejects(access(file), { code: 'ENOENT' });

  await jsonl.clear();
  assert.equal(await readFile(file, 'utf8'), '');
  await jsonl.append(1);
  await jsonl.write([]);
  assert.deepEqual(await jsonl.read(), []);
  assert.equal(await readFile(file, 'utf8'), '');
});

test('all JSON value types are records, including wrapped arrays', async (t) => {
  const { file } = await fixture(t);
  const jsonl = new Jsonl(file);
  const values = [null, true, false, 0, -1.5, '', '你好\nworld', { id: 1 }, [1, null], []];

  await jsonl.write(values);
  assert.deepEqual(await jsonl.read(), values);
  await jsonl.append([[2, 3]]);
  assert.deepEqual(await jsonl.read(), [...values, [2, 3]]);
  await jsonl.append([4, 5]);
  assert.deepEqual(await jsonl.read(), [...values, [2, 3], 4, 5]);
});

test('reads BOM, CRLF, blank lines and a final record without a newline', async (t) => {
  const { file } = await fixture(t);
  await writeFile(file, '\uFEFF{"id":1}\r\n\r\n \t\r\nfalse\r\nnull\r\n[2,3]');
  assert.deepEqual(await new Jsonl(file).read(), [{ id: 1 }, false, null, [2, 3]]);
  assert.deepEqual(await new Jsonl(file, { strict: true }).read(), [
    { id: 1 }, false, null, [2, 3],
  ]);
});

test('default and explicit non-strict reads skip malformed lines', async (t) => {
  const { file } = await fixture(t);
  await writeFile(file, 'broken\nnull\n{"id":1}\n{\n0\nfalse\n""\n[]\n');
  const expected = [null, { id: 1 }, 0, false, '', []];
  assert.deepEqual(await new Jsonl(file).read(), expected);
  assert.deepEqual(await new Jsonl(file, { strict: false }).read(), expected);
});

test('strict errors identify the file and physical line; remove leaves bytes unchanged', async (t) => {
  const { file } = await fixture(t);
  const original = '\uFEFF{"id":1}\r\n\r\ntrue\r\n{broken}\r\nnull';
  await writeFile(file, original);
  const jsonl = new Jsonl(file, { strict: true });
  const check = (error) => {
    assert.ok(error instanceof SyntaxError);
    assert.ok(error.message.includes(`${file}:4:`));
    assert.ok(error.message.includes('Invalid JSON'));
    return true;
  };

  await assert.rejects(jsonl.read(), check);
  await assert.rejects(jsonl.remove(() => true), check);
  assert.equal(await readFile(file, 'utf8'), original);
});

test('remove preserves malformed and blank lines verbatim and visits every valid value', async (t) => {
  const { file } = await fixture(t);
  await writeFile(file, '\uFEFF{"id":1}\r\nbroken\r\n\r\nnull\r\n[1,2]\nfalse\n0\n""\n{"id":2}\ntrailing broken');
  const jsonl = new Jsonl(file);
  const visited = [];
  const removed = await jsonl.remove((record) => {
    visited.push(record);
    return !(record !== null && typeof record === 'object' && record.id === 2);
  });

  assert.equal(removed, 6);
  assert.deepEqual(visited, [{ id: 1 }, null, [1, 2], false, 0, '', { id: 2 }]);
  assert.equal(await readFile(file, 'utf8'), 'broken\r\n\r\n{"id":2}\ntrailing broken');
  assert.deepEqual(await jsonl.read(), [{ id: 2 }]);
});

test('remove with no match does not normalize the original file', async (t) => {
  const { file } = await fixture(t);
  const original = '\uFEFF1\r\ninvalid\n\r\n2';
  await writeFile(file, original);
  assert.equal(await new Jsonl(file).remove(() => false), 0);
  assert.equal(await readFile(file, 'utf8'), original);
});

test('append supplies a missing separator without adding unnecessary blank lines', async (t) => {
  const { file } = await fixture(t);
  const jsonl = new Jsonl(file);
  for (const ending of ['', '\n', '\r\n']) {
    const original = `{"id":1}${ending}`;
    await writeFile(file, original);
    await jsonl.append([{ id: 2 }, { id: 3 }]);
    const separator = ending ? '' : '\n';
    assert.equal(await readFile(file, 'utf8'), `${original}${separator}{"id":2}\n{"id":3}\n`);
    assert.deepEqual(await jsonl.read(), [{ id: 1 }, { id: 2 }, { id: 3 }]);
  }
  await writeFile(file, '');
  await jsonl.append(null);
  assert.equal(await readFile(file, 'utf8'), 'null\n');
});

test('serialization failures never partially append or replace existing data', async (t) => {
  const { file } = await fixture(t);
  const original = '{"original":true}';
  await writeFile(file, original);
  const jsonl = new Jsonl(file);
  const circular = {};
  circular.self = circular;
  const invalid = [
    undefined,
    () => {},
    Symbol('record'),
    1n,
    circular,
    { toJSON: () => undefined },
    { toJSON() { throw new Error('serialization failed'); } },
  ];

  for (const value of invalid) {
    await assert.rejects(jsonl.append(value));
    assert.equal(await readFile(file, 'utf8'), original);
    await assert.rejects(jsonl.append([{ valid: true }, value]));
    assert.equal(await readFile(file, 'utf8'), original);
    await assert.rejects(jsonl.write([{ valid: true }, value]));
    assert.equal(await readFile(file, 'utf8'), original);
  }
  assert.deepEqual(await readdir(join(file, '..')), ['records.jsonl']);
});

test('schema requires basic field types, allows extra fields and skips mismatches by default', async (t) => {
  const { file } = await fixture(t);
  const schema = { name: 'string', count: 'number', enabled: 'boolean' };
  const valid = [
    { name: '', count: 0, enabled: false },
    { name: 'item', count: -1.5, enabled: true, extra: { nested: [null] } },
  ];
  const invalid = [
    { count: 1, enabled: true },
    { name: 'item', enabled: true },
    { name: 'item', count: 1 },
    { name: null, count: 1, enabled: true },
    { name: 1, count: 1, enabled: true },
    { name: 'item', count: '1', enabled: true },
    { name: 'item', count: null, enabled: true },
    { name: 'item', count: 1, enabled: 1 },
    { name: 'item', count: 1, enabled: 'true' },
    null, [], ['item', 1, true], 'item', 1, true,
  ];
  await writeFile(file, [...valid, ...invalid].map((value) => JSON.stringify(value)).join('\n'));

  assert.deepEqual(await new Jsonl(file, { schema }).read(), valid);
  assert.deepEqual(await new Jsonl(file, { schema, strict: false }).read(), valid);
  const jsonl = new Jsonl(file, { schema, strict: true });
  await jsonl.write(valid);
  assert.deepEqual(await jsonl.read(), valid);
});

test('schema enums support strings, numbers, booleans and null without coercion', async (t) => {
  const { file } = await fixture(t);
  const schema = {
    level: ['debug', 'info', 'warn', 'error'],
    value: ['ready', 2, true, null],
    nullable: ['set', null],
  };
  const valid = [
    { level: 'debug', value: 'ready', nullable: null },
    { level: 'info', value: 2, nullable: 'set' },
    { level: 'warn', value: true, nullable: null },
    { level: 'error', value: null, nullable: 'set' },
  ];
  const invalid = [
    { ...valid[0], level: 'trace' },
    ...['2', 'true', 1, false, {}, []].map((value) => ({ ...valid[0], value })),
    { level: 'info', nullable: null },
    { level: 'info', value: null },
    { ...valid[0], nullable: false },
  ];
  await writeFile(file, [...valid, ...invalid].map((value) => JSON.stringify(value)).join('\n'));
  const jsonl = new Jsonl(file, { schema });
  assert.deepEqual(await jsonl.read(), valid);
  await jsonl.write(valid);
  await jsonl.append(valid);
  assert.deepEqual(await jsonl.read(), [...valid, ...valid]);

  const emptyEnum = new Jsonl(file, { schema: { level: [] } });
  assert.deepEqual(await emptyEnum.read(), []);
  await assert.rejects(emptyEnum.append({ level: 'info' }), TypeError);
});

test('even an empty schema requires an object and fields must be own properties', async (t) => {
  const { file } = await fixture(t);
  const values = [{}, { extra: true }, null, [], false, 0, ''];
  await new Jsonl(file).write(values);
  assert.deepEqual(await new Jsonl(file, { schema: {} }).read(), values.slice(0, 2));
  assert.deepEqual(await new Jsonl(file, { schema: { toString: 'string' } }).read(), []);
  const jsonl = new Jsonl(file, { schema: { toString: 'string' }, strict: true });
  await jsonl.write([{ toString: 'own field' }]);
  assert.deepEqual(await jsonl.read(), [{ toString: 'own field' }]);
});

test('strict schema reads and removes distinguish syntax and schema errors without changing bytes', async (t) => {
  const { file } = await fixture(t);
  const jsonl = new Jsonl(file, { schema: { id: 'number' }, strict: true });
  for (const [line, ErrorType, message] of [
    ['{broken}', SyntaxError, 'Invalid JSON'],
    ['{"id":"wrong"}', TypeError, 'schema'],
    ['{}', TypeError, 'schema'],
    ['null', TypeError, 'schema'],
    ['[]', TypeError, 'schema'],
  ]) {
    const original = `\uFEFF{"id":1}\r\n\r\n{"id":2}\r\n${line}\r\n{"id":3}`;
    await writeFile(file, original);
    const check = (error) => {
      assert.ok(error instanceof ErrorType);
      assert.ok(error.message.includes(`${file}:4:`));
      assert.ok(error.message.includes(message));
      return true;
    };
    await assert.rejects(jsonl.read(), check);
    await assert.rejects(jsonl.remove(() => true), check);
    assert.equal(await readFile(file, 'utf8'), original);
  }
});

test('remove preserves schema mismatches, malformed and blank lines without visiting them', async (t) => {
  const { file } = await fixture(t);
  const original = '\uFEFF{"id":"wrong"}\r\nbroken\r\n\r\n{"id":1}\r\nnull\n[]\n{"id":2}\r\n{"id":3}\n{"extra":true}';
  await writeFile(file, original);
  const jsonl = new Jsonl(file, { schema: { id: 'number' } });
  const visited = [];
  assert.equal(await jsonl.remove((record) => {
    visited.push(record);
    return record.id !== 2;
  }), 2);
  assert.deepEqual(visited, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  const remaining = '\uFEFF{"id":"wrong"}\r\nbroken\r\n\r\nnull\n[]\n{"id":2}\r\n{"extra":true}';
  assert.equal(await readFile(file, 'utf8'), remaining);
  assert.deepEqual(await jsonl.read(), [{ id: 2 }]);
  assert.equal(await jsonl.remove(() => false), 0);
  assert.equal(await readFile(file, 'utf8'), remaining);
});

test('schema errors reject entire append and write batches regardless of strict mode', async (t) => {
  const { directory, file } = await fixture(t);
  const original = '{"id":0}';
  await writeFile(file, original);
  for (const options of [{}, { strict: false }, { strict: true }]) {
    const jsonl = new Jsonl(file, { ...options, schema: { id: 'number' } });
    // 数组作为一条记录要再包一层，[] 本身表示空批次
    for (const invalid of [{}, { id: 'wrong' }, { id: null }, null, [[]], 1, false]) {
      await assert.rejects(jsonl.append(invalid), TypeError);
      assert.equal(await readFile(file, 'utf8'), original);
      for (const method of ['append', 'write']) {
        await assert.rejects(jsonl[method]([{ id: 1 }, invalid, { id: 2 }]), (error) => {
          assert.ok(error instanceof TypeError);
          assert.ok(error.message.includes(`${file}:2:`));
          return true;
        });
        assert.equal(await readFile(file, 'utf8'), original);
      }
    }
  }
  assert.deepEqual(await readdir(directory), ['records.jsonl']);

  const missing = join(directory, 'missing', 'records.jsonl');
  const jsonl = new Jsonl(missing, { schema: { id: 'number' } });
  for (const method of ['append', 'write']) {
    await assert.rejects(jsonl[method]([{ id: 1 }, { id: 'wrong' }]), TypeError);
    await assert.rejects(access(join(directory, 'missing')), { code: 'ENOENT' });
  }
});

test('schema validates the actual serialized toJSON result and serializes each record once', async (t) => {
  const { file } = await fixture(t);
  const jsonl = new Jsonl(file, { schema: { id: 'number' } });
  let calls = 0;
  const record = {
    id: 'not the output',
    toJSON() {
      calls++;
      return { id: 7, extra: true };
    },
  };
  await jsonl.write([record]);
  await jsonl.append(record);
  assert.equal(calls, 2);
  assert.deepEqual(await jsonl.read(), [{ id: 7, extra: true }, { id: 7, extra: true }]);
  const original = await readFile(file, 'utf8');

  for (const result of [{ id: 'wrong' }, {}, null, [], 'text', 7, false, undefined]) {
    const invalid = { id: 1, toJSON: () => result };
    for (const method of ['append', 'write']) {
      await assert.rejects(jsonl[method]([{ id: 2 }, invalid]), TypeError);
      assert.equal(await readFile(file, 'utf8'), original);
    }
  }
});

test('schema checks normalized numbers, omitted fields and field-level toJSON values', async (t) => {
  const { file } = await fixture(t);
  const jsonl = new Jsonl(file, { schema: { value: 'number' } });
  await jsonl.write([{ value: 1 }]);
  const original = await readFile(file, 'utf8');
  for (const value of [NaN, Infinity, -Infinity, undefined, () => {}, Symbol('field')]) {
    for (const method of ['append', 'write']) {
      await assert.rejects(jsonl[method]([{ value: 2 }, { value }]), TypeError);
      assert.equal(await readFile(file, 'utf8'), original);
    }
  }
  await jsonl.append({ value: { toJSON: () => 3 } });
  assert.deepEqual(await jsonl.read(), [{ value: 1 }, { value: 3 }]);

  const nullable = new Jsonl(file, { schema: { value: [null] } });
  await nullable.write([{ value: NaN }]);
  await nullable.append({ value: Infinity });
  assert.deepEqual(await nullable.read(), [{ value: null }, { value: null }]);
  const strings = new Jsonl(file, { schema: { value: 'string' } });
  await strings.write([{ value: new Date('2026-01-01T00:00:00.000Z') }]);
  assert.deepEqual(await strings.read(), [{ value: '2026-01-01T00:00:00.000Z' }]);
});

test('schema failures do not poison the shared queue', async (t) => {
  const { file } = await fixture(t);
  const first = new Jsonl(file, { schema: { id: 'number' } });
  const second = new Jsonl(file, { schema: { id: 'number' } });
  await first.write([{ id: 0 }]);
  const rejected = assert.rejects(first.append([{ id: 1 }, { id: 'wrong' }]), TypeError);
  const appended = second.append({ id: 2 });
  const snapshot = first.read();
  await Promise.all([rejected, appended]);
  assert.deepEqual(await snapshot, [{ id: 0 }, { id: 2 }]);
});

test('omitted and undefined schemas retain generic JSONL and toJSON behavior', async (t) => {
  const { file } = await fixture(t);
  for (const options of [undefined, { schema: undefined }, { strict: true }]) {
    const jsonl = new Jsonl(file, options);
    await jsonl.write([null, true, 1, 'text', {}, [], NaN, { toJSON: () => 'changed' }]);
    await jsonl.append([[1, 2]]);
    assert.deepEqual(await jsonl.read(), [null, true, 1, 'text', {}, [], null, 'changed', [1, 2]]);
  }
});

test('two instances share a queue by absolute path, including reads not awaiting prior writes', async (t) => {
  const { directory, file } = await fixture(t);
  const first = new Jsonl(file);
  const second = new Jsonl(join(directory, 'unused', '..', 'records.jsonl'));
  const operations = [first.write([{ id: 0 }])];
  for (let id = 1; id <= 40; id++) {
    operations.push((id % 2 ? first : second).append({ id }));
  }
  const removed = second.remove((record) => record.id % 2 === 0);
  const snapshot = first.read();
  await Promise.all(operations);
  assert.equal(await removed, 21);
  assert.deepEqual(await snapshot, Array.from({ length: 20 }, (_, index) => ({ id: index * 2 + 1 })));
});

test('write and clear participate in the same invocation-order queue', async (t) => {
  const { file } = await fixture(t);
  const first = new Jsonl(file);
  const second = new Jsonl(file);
  const operations = [
    first.append(1), second.write([2]), first.append(3), second.clear(), first.append(4),
  ];
  const snapshot = second.read();
  await Promise.all(operations);
  assert.deepEqual(await snapshot, [4]);
});

test('a throwing predicate leaves the original untouched and does not poison the queue', async (t) => {
  const { file } = await fixture(t);
  const jsonl = new Jsonl(file);
  await jsonl.write([1, 2]);
  const original = await readFile(file, 'utf8');
  const failure = jsonl.remove((value) => {
    if (value === 2) throw new Error('predicate failed');
    return true;
  });
  const rejection = assert.rejects(failure, /predicate failed/);
  const snapshot = new Jsonl(file).read();
  await rejection;
  assert.deepEqual(await snapshot, [1, 2]);
  assert.equal(await readFile(file, 'utf8'), original);
  await jsonl.append(3);
  assert.deepEqual(await jsonl.read(), [1, 2, 3]);
});

test('failed rename preserves destination data, removes temporary files and releases the queue', async (t) => {
  const { directory } = await fixture(t);
  const file = join(directory, 'blocked.jsonl');
  await mkdir(file);
  const marker = join(file, 'keep.txt');
  await writeFile(marker, 'original data');
  const jsonl = new Jsonl(file);

  for (const operation of [() => jsonl.write([1]), () => jsonl.clear()]) {
    await assert.rejects(operation());
    assert.equal(await readFile(marker, 'utf8'), 'original data');
    assert.deepEqual(await readdir(directory), ['blocked.jsonl']);
  }
  await assert.rejects(jsonl.read());
  await assert.rejects(jsonl.remove(() => true));
  await rm(file, { recursive: true });
  await jsonl.append(2);
  assert.deepEqual(await jsonl.read(), [2]);
});

test('failed temporary-file creation preserves an existing JSONL file', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    t.skip('requires POSIX directory permissions and a non-root user');
    return;
  }
  const { directory, file } = await fixture(t);
  const jsonl = new Jsonl(file);
  await jsonl.write([1, 2]);
  const original = await readFile(file, 'utf8');
  await chmod(directory, 0o500);
  try {
    try {
      await access(directory, constants.W_OK);
      t.skip('filesystem does not enforce directory write permissions');
      return;
    } catch (error) {
      if (error.code !== 'EACCES') throw error;
    }
    for (const operation of [
      () => jsonl.write([3]), () => jsonl.remove(() => true), () => jsonl.clear(),
    ]) {
      await assert.rejects(operation());
      assert.equal(await readFile(file, 'utf8'), original);
      assert.deepEqual(await readdir(directory), ['records.jsonl']);
    }
  } finally {
    await chmod(directory, 0o700);
  }
});
