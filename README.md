# @hlw2326/jsonl

轻量、零运行时依赖的 JSONL 文件读写包。自动处理逐行解析、空行、换行和文件写入，支持可选的声明式字段校验，不包含数据库或日志权限逻辑。

支持 Node.js 22+、ESM、CommonJS 和 TypeScript。npm 包仅包含编译后的 JavaScript、类型声明和文档，不发布 `src`。

## 安装

```sh
pnpm add @hlw2326/jsonl
```

## 使用

```ts
import { Jsonl } from '@hlw2326/jsonl'

interface Log {
  appId: string
  message: string
}

const logs = new Jsonl<Log>('./data/logs.jsonl')

await logs.append({ appId: 'app-a', message: '已启动' })
await logs.append([
  { appId: 'app-a', message: '已连接' },
  { appId: 'app-b', message: '已启动' }
])

const records = await logs.read()
const mine = records.filter(record => record.appId === 'app-a')

const removed = await logs.remove(record => record.appId === 'app-a')
await logs.write(mine)
await logs.clear()
```

CommonJS：

```js
const { Jsonl } = require('@hlw2326/jsonl')

const file = new Jsonl('./data/records.jsonl')
```

## API

### `new Jsonl<T>(file, { strict?: boolean, schema?: JsonlSchema })`

`file` 相对当前工作目录解析。默认 `strict: false`，读取时跳过 JSON 语法损坏的行；空行始终忽略，支持 UTF-8 BOM、CRLF 和末尾没有换行的文件。

```ts
const file = new Jsonl<Log>('./logs.jsonl', { strict: true })
```

严格模式遇到 JSON 语法损坏的行时抛出包含文件路径及行号的 `SyntaxError`。

需要字段校验时，声明一次 `schema`，不必手写 `isRecord`：

```ts
const logs = new Jsonl<Log>('./logs.jsonl', {
  schema: {
    appId: 'string',
    message: 'string'
  }
})
```

规则支持 `string`、`number`、`boolean`，以及枚举数组，例如 `level: ['debug', 'info', 'warn', 'error']`、`status: ['ready', null]`。声明的字段必须存在，允许额外字段，不做递归校验。

- 读取：默认跳过不匹配 schema 的记录；严格模式抛出包含路径和行号的 `TypeError`。
- 删除：不匹配 schema 的行原样保留，不传给删除回调；严格模式遇到错误则不修改文件。
- 追加、覆盖：任一记录不匹配 schema，整次写入失败，无论是否开启严格模式。校验的是序列化后的实际值，包括 `toJSON` 的结果。
- 不提供 schema 时只检查 JSON 语法；泛型 `T` 本身不会产生运行时校验。

### `read(): Promise<T[]>`

读取全部有效记录；文件不存在时返回 `[]`，其他文件系统错误正常抛出。

### `append(record | records): Promise<void>`

追加一条或多条记录，自动创建父目录，并补齐已有文件末尾缺失的换行。空数组不写入。

数组参数表示多条记录；如果记录本身就是数组，外面再包一层：

```ts
const arrays = new Jsonl<number[]>('./arrays.jsonl')
await arrays.append([[1, 2, 3]])
```

### `write(records): Promise<void>`

用新记录替换文件。先完整序列化，再写入同目录临时文件，最后重命名替换目标。

### `remove(predicate): Promise<number>`

删除符合条件的记录，返回删除数量。默认模式保留原文件中无法解析或不匹配 schema 的行；严格模式遇到无效记录时拒绝操作，不修改原文件。没有匹配记录时不重写文件。

### `clear(): Promise<void>`

清空全部内容，文件保留；文件不存在时创建空文件。

## 行为边界

- 所有记录按标准 `JSON.stringify` 规则保存，`undefined`、函数、Symbol 等无法作为顶层 JSON 值写入；循环引用、BigInt 等序列化错误会拒绝本次写入。批量写入先完成全部序列化，避免因后续记录无法序列化而只写入部分数据。
- 同一模块实例内、同一绝对路径的操作按调用顺序串行执行，包括不同 `Jsonl` 对象；一次操作失败不会阻塞后续操作。
- 不提供跨进程、Worker、不同模块副本或符号链接别名之间的文件锁；请让一个进程统一管理同一文件。
- `write`、`remove`、`clear` 使用临时文件替换，替换前失败会保留旧文件；`append` 是直接追加，底层写入失败可能留下部分数据。这里不承诺断电持久性，也不执行 `fsync`。
- `read`、`remove` 会读取整个文件，适合按天分文件的日志及中小型 JSONL 数据，不是大文件流式查询引擎。
- 包不自动轮转文件、不判断应用身份，也不管理日志保留时间。

## 开发与发布

```sh
pnpm install
pnpm typecheck
pnpm test
```

`pnpm test` 会先编译。`pnpm build` 生成：

```text
dist/
├── esm/
│   ├── index.js
│   └── index.d.ts
└── cjs/
    ├── index.js
    ├── index.d.ts
    └── package.json
```

发布前检查实际包内容，再发布：

```sh
npm pack --dry-run
npm login
npm publish --access public
```

`prepack` 自动执行构建和测试，`files` 白名单仅包含 `dist`、`README.md`、`LICENSE`；`package.json` 由 npm 自动包含。源码、测试、构建脚本、配置和 source map 均不发布。

发布账号必须拥有 `@hlw2326` 作用域的发布权限。再次发布前需要修改版本号；具体双因素认证或令牌要求以 npm 提示为准。
