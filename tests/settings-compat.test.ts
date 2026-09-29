/**
 * settings 服务两种形态的回归测试（DSH 0.1.x 与 0.2.x）。
 *
 * 回归背景：0.2.x 的 `settings` 服务移除了 `get(ns)`，改为 `describe()`。
 * 插件原先直接调 `ctx.get('settings')?.get(NS)`——`?.` 只挡住服务不存在、
 * 挡不住方法不存在——于是 `context_audit` 每次调用都抛
 * `Error: ctx.get(...)?.get is not a function`。
 *
 * 既有的 `plugin.test.ts` 里 `makeCtx().get` 恒返回 `undefined`，两个分支
 * 都没被走到，所以上面这个崩溃当时没有任何测试能拦住。本文件把两种形态、
 * 异常与畸形输入、以及英文回退都钉死。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { apply } from '../src/index.ts'

/** 中文与英文报告的标题，用来判定 reportLocale() 取到了哪个语言。 */
const ZH_TITLE = '# Context Doctor 审计报告'
const EN_TITLE = '# Context Doctor audit report'

/**
 * 构造只够 `apply` → `execute` → `render` 跑起来的最小 mock ctx。
 * @param settings - 注入到 `ctx.get('settings')` 的服务替身；undefined 表示宿主没有该服务。
 * @returns mock ctx，`registered` 收集注册的工具定义。
 */
function makeCtx(settings: unknown) {
  const registered: unknown[] = []
  return {
    fs: {
      async resolve(path: string, opts?: { cwd?: string }): Promise<unknown> {
        return { targetKey: resolve(opts?.cwd ?? process.cwd(), path) }
      },
      processPath(target: { targetKey: string }): string {
        return target.targetKey
      },
      async stat(target: { targetKey: string }): Promise<unknown> {
        try {
          const st = statSync(target.targetKey)
          return { version: 1, type: st.isDirectory() ? 'directory' : 'file', size: st.size }
        } catch {
          return undefined
        }
      },
      async readText(target: { targetKey: string }): Promise<string> {
        return readFileSync(target.targetKey, 'utf8')
      },
    },
    skills: {
      list: async () => [],
      get: async (name: string) => ({ name, description: '', content: '', source: 'user-dsh', provider: 'skill-local' }),
    },
    tools: {
      schemas: () => [],
      register: (def: unknown) => { registered.push(def) },
    },
    // headless 形态：没有 webServer，路由跳过；sessions / agents 也不存在。
    inject: () => {},
    effect: (fn: () => unknown) => fn(),
    get: (service: string) => (service === 'settings' ? settings : undefined),
    registered,
  }
}

/**
 * 用给定的 settings 替身跑一遍完整链路，返回渲染出的报告文本。
 * @param settings - 注入的 settings 服务替身。
 * @returns `output.render` 产出的第一段文本。
 */
async function renderReportText(settings: unknown): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'ctxdoc-settings-'))
  try {
    const ctx = makeCtx(settings)
    apply(ctx as never)
    const tool = ctx.registered[0] as {
      execute: (args: unknown, exec: unknown) => Promise<unknown>
      output: { render: (args: unknown, value: unknown) => { text: string }[] }
    }
    const args = { cwd: dir }
    const exec = { signal: new AbortController().signal }
    const report = await tool.execute(args, exec)
    const blocks = tool.output.render(args, report)
    return blocks[0]!.text
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('settings 0.1.x 形态：get(ns) 返回区段 → 中文', async () => {
  const text = await renderReportText({
    get: (ns: string) => (ns === 'locale' ? { preference: 'zh' } : undefined),
  })
  assert.ok(text.startsWith(ZH_TITLE), `应为中文报告，实际开头：${text.slice(0, 40)}`)
})

test('settings 0.2.x 形态：describe() 的 value 命中 locale → 中文', async () => {
  const text = await renderReportText({
    describe: () => [
      { ns: 'other', value: { preference: 'en' } },
      { ns: 'locale', value: { preference: 'zh' } },
    ],
  })
  assert.ok(text.startsWith(ZH_TITLE))
})

test('settings 0.2.x 形态：只有 user 层时同样认', async () => {
  const text = await renderReportText({
    describe: () => [{ ns: 'locale', user: { preference: 'zh' } }],
  })
  assert.ok(text.startsWith(ZH_TITLE))
})

test('settings 两个方法都没有 → 回退英文', async () => {
  const text = await renderReportText({})
  assert.ok(text.startsWith(EN_TITLE))
})

test('settings 服务整个缺失（宿主没有该服务）→ 回退英文', async () => {
  const text = await renderReportText(undefined)
  assert.ok(text.startsWith(EN_TITLE))
})

test('get 抛错时不否决 describe：仍能读到语言', async () => {
  const text = await renderReportText({
    get: () => { throw new Error('boom') },
    describe: () => [{ ns: 'locale', value: { preference: 'zh' } }],
  })
  assert.ok(text.startsWith(ZH_TITLE), '分支应各自独立容错')
})

test('describe 抛错 → 回退英文，且不让审计失败', async () => {
  const text = await renderReportText({
    describe: () => { throw new Error('boom') },
  })
  assert.ok(text.startsWith(EN_TITLE))
})

test('get 返回畸形值（非对象）时落到 describe', async () => {
  const text = await renderReportText({
    get: () => 'zh',
    describe: () => [{ ns: 'locale', value: { preference: 'zh' } }],
  })
  assert.ok(text.startsWith(ZH_TITLE))
})

test('describe 返回非数组 → 回退英文', async () => {
  const text = await renderReportText({ describe: () => ({ ns: 'locale', value: { preference: 'zh' } }) })
  assert.ok(text.startsWith(EN_TITLE))
})

test('namespace 不匹配时不被误用', async () => {
  const text = await renderReportText({
    describe: () => [{ ns: 'not-locale', value: { preference: 'zh' } }],
  })
  assert.ok(text.startsWith(EN_TITLE))
})

test('preference 非 zh 时回退英文', async () => {
  const text = await renderReportText({
    get: () => ({ preference: 'fr' }),
  })
  assert.ok(text.startsWith(EN_TITLE))
})
