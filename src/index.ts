import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export type JsonlSchema = Readonly<Record<
  string,
  'string' | 'number' | 'boolean' | readonly (string | number | boolean | null)[]
>>;

const queues = new Map<string, Promise<void>>();

function enqueue<R>(file: string, operation: () => Promise<R>): Promise<R> {
  const result = (queues.get(file) ?? Promise.resolve()).then(operation);
  const tail = result.then(() => {}, () => {});
  queues.set(file, tail);
  void tail.then(() => {
    if (queues.get(file) === tail) queues.delete(file);
  });
  return result;
}

async function load(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '';
    throw error;
  }
}

export class Jsonl<T = unknown> {
  private readonly file: string;
  private readonly strict: boolean;
  private readonly schema: JsonlSchema | undefined;

  constructor(file: string, options?: { strict?: boolean; schema?: JsonlSchema }) {
    this.file = resolve(file);
    this.strict = options?.strict ?? false;
    this.schema = options?.schema;
  }

  read(): Promise<T[]> {
    return enqueue(this.file, async () => {
      const lines = (await load(this.file)).split(/(?<=\n)/);
      const records: T[] = [];
      for (const [index, line] of lines.entries()) {
        const parsed = this.parse(line, index);
        if (parsed) records.push(parsed.value);
      }
      return records;
    });
  }

  /** 数组参数表示多条记录；数组本身作为一条记录时使用 append([array])。 */
  append(value: T | readonly T[]): Promise<void> {
    return enqueue(this.file, async () => {
      const data = this.serialize(Array.isArray(value) ? value : [value]);
      if (!data) return;
      await mkdir(dirname(this.file), { recursive: true });
      const file = await open(this.file, 'a+');
      try {
        const { size } = await file.stat();
        const last = Buffer.alloc(1);
        if (size) await file.read(last, 0, 1, size - 1);
        const separator = size && last[0] !== 10 ? '\n' : '';
        await file.writeFile(separator + data, 'utf8');
      } finally {
        await file.close();
      }
    });
  }

  write(records: readonly T[]): Promise<void> {
    return enqueue(this.file, async () => {
      await this.replace(this.serialize(records));
    });
  }

  remove(predicate: (record: T) => boolean): Promise<number> {
    return enqueue(this.file, async () => {
      const lines = (await load(this.file)).split(/(?<=\n)/);
      let removed = 0;
      const remaining = lines.filter((line, index) => {
        const parsed = this.parse(line, index);
        if (!parsed || !predicate(parsed.value)) return true;
        removed++;
        return false;
      });
      if (removed) await this.replace(remaining.join(''));
      return removed;
    });
  }

  clear(): Promise<void> {
    return enqueue(this.file, async () => {
      await this.replace('');
    });
  }

  private validate(value: unknown, index: number): void {
    if (!this.schema) return;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (Object.entries(this.schema).every(([key, rule]) =>
        Object.hasOwn(record, key) && (typeof rule === 'string'
          ? typeof record[key] === rule
          : rule.some((allowed) => allowed === record[key])),
      )) return;
    }
    throw new TypeError(`${this.file}:${index + 1}: Record does not match schema`);
  }

  private serialize(records: readonly unknown[]): string {
    const lines = records.map((record, index) => {
      const line = JSON.stringify(record);
      if (line === undefined) throw new TypeError('Record cannot be serialized as JSON');
      if (this.schema) this.validate(JSON.parse(line), index);
      return line;
    });
    return lines.length ? `${lines.join('\n')}\n` : '';
  }

  private parse(line: string, index: number): { value: T } | undefined {
    const text = line.trim();
    if (!text) return undefined;
    try {
      const value = JSON.parse(text) as T;
      this.validate(value, index);
      return { value };
    } catch (error) {
      if (this.strict) {
        if (error instanceof TypeError) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        throw new SyntaxError(`${this.file}:${index + 1}: Invalid JSON: ${detail}`, {
          cause: error,
        });
      }
      return undefined;
    }
  }

  private async replace(data: string): Promise<void> {
    const directory = dirname(this.file);
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `.jsonl-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, data, { encoding: 'utf8', flag: 'wx' });
      await rename(temporary, this.file);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
}
