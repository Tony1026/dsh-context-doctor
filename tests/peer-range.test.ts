/**
 * `dsh-tools` peer 范围的契约测试。
 *
 * 回归背景：0.7.2 声明 `^0.1.2-rc.1`，在 DSH 0.2.0-rc.2 上被兼容性闸门拒装
 * （`^0.1.2-rc.1` 展开为 `>=0.1.2-rc.1 <0.2.0-0`，再叠加预发布放行规则）。
 * 这条契约此前只有 `bundle.test.ts` 里「peer 键存在」的断言，所以范围被改窄
 * 时没有任何测试会响。本文件把「接受哪些、拒绝哪些」钉死。
 *
 * 本仓库不引入依赖（宿主包走 DSH 源码检出软链），因此这里实现一个**只覆盖
 * package.json 实际写法**的 caret 判定器，而不是通用 semver：遇到不认识的
 * 范围写法直接抛错——宁可测试响亮地失败，也不要静默放过一个可能重新引发
 * 拒装的范围。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  peerDependencies?: Record<string, string>
}

/** 拆开的语义化版本；`prerelease` 为空数组表示正式版。 */
interface ParsedVersion {
  major: number
  minor: number
  patch: number
  prerelease: (string | number)[]
}

/** 解析 `X.Y.Z[-pre]`；不符合该形状返回 undefined。 */
function parseVersion(text: string): ParsedVersion | undefined {
  const matched = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(text.trim())
  if (matched === null) return undefined
  const pre = matched[4]
  return {
    major: Number(matched[1]),
    minor: Number(matched[2]),
    patch: Number(matched[3]),
    prerelease: pre === undefined ? [] : pre.split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)),
  }
}

/**
 * semver §11 的优先级比较。
 * @param a - 左值。
 * @param b - 右值。
 * @returns a 小于/等于/大于 b 时为 -1 / 0 / 1。
 */
function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1 // 正式版优先级高于同号预发布
  if (b.prerelease.length === 0) return -1
  const width = Math.max(a.prerelease.length, b.prerelease.length)
  for (let i = 0; i < width; i++) {
    const left = a.prerelease[i]
    const right = b.prerelease[i]
    if (left === undefined) return -1
    if (right === undefined) return 1
    if (left === right) continue
    const leftNumeric = typeof left === 'number'
    const rightNumeric = typeof right === 'number'
    if (leftNumeric && rightNumeric) return left < right ? -1 : 1
    if (leftNumeric) return -1 // 数字标识符优先级低于字母数字
    if (rightNumeric) return 1
    return left < right ? -1 : 1
  }
  return 0
}

/**
 * 判定 `^X.Y.Z[-pre]` 形式的 caret 范围（`||` 分隔的备选任一命中即可）是否接受该版本。
 *
 * 只支持 caret + 可选预发布这一种写法；caret 在 0.x 上锁 minor
 * （`^0.1.2` → `>=0.1.2-0 <0.2.0-0`），1.0.0 起才锁 major。
 *
 * **判定口径对齐 DSH**：宿主用的是
 * `semver.satisfies(version, range, { includePrerelease: true })`。在这个口径下
 * semver 的「预发布版本只在同 major.minor.patch 才放行」规则是**关闭**的，
 * 能否命中完全由上界的 `-0` 决定——这正是 `^0.1.2-rc.1`（上界 `0.2.0-0`）
 * 会拒掉 `0.2.0-rc.2` 的原因，也是本次拒装的根因。上界少了 `-0`，
 * 下一代的预发布版本就会被误放进来。
 *
 * @param version - 待判定的精确版本。
 * @param range - package.json 里声明的范围字符串。
 * @returns 该版本是否落在范围内。
 * @throws 版本或范围不是本函数支持的写法时——避免静默放过。
 */
function caretAdmits(version: string, range: string): boolean {
  const candidate = parseVersion(version)
  if (candidate === undefined) throw new Error(`测试用例版本号无法解析: ${JSON.stringify(version)}`)

  return range.split('||').some((raw) => {
    const alternative = raw.trim()
    const matched = /^\^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(alternative)
    if (matched === null) {
      throw new Error(
        `未支持的 caret 写法 ${JSON.stringify(alternative)}——请改用 semver 或扩展本辅助函数`,
      )
    }
    /**
     * 注意：**不**给普通下界补 `-0`。`includePrerelease` 并不会把 `^1.2.3`
     * 展开成 `>=1.2.3-0` —— semver 的 `replaceCaret` 里 `z = '-0'` 只用于
     * `isX(minor)` / `isX(patch)` 两个分支，普通 `X.Y.Z` 的 "no pr" 分支不用它。
     * 实测 semver 7.8.5（DSH 归档自带）：
     *   new Range('^1.2.3', { includePrerelease: true }).range === '>=1.2.3 <2.0.0-0'
     *   satisfies('1.2.3-rc.1', '^1.2.3', { includePrerelease: true }) === false
     * 这一点反直觉，曾被自动 review 误报为缺陷。
     */
    const low = parseVersion(matched[1]!)!
    const high: ParsedVersion = low.major === 0
      ? { major: 0, minor: low.minor + 1, patch: 0, prerelease: [0] }
      : { major: low.major + 1, minor: 0, patch: 0, prerelease: [0] }

    return compareVersions(candidate, low) >= 0 && compareVersions(candidate, high) < 0
  })
}

const PEER = pkg.peerDependencies?.['@deepseek-ai/dsh-tools']

test('package.json: dsh-tools 声明为 peerDependency', () => {
  assert.equal(typeof PEER, 'string')
})

test('dsh-tools peer 接受 0.1.x（不丢旧版本覆盖）', () => {
  for (const version of ['0.1.2-rc.1', '0.1.2-rc.2', '0.1.5', '0.1.7-rc.1', '0.1.9']) {
    assert.ok(caretAdmits(version, PEER!), `${version} 应被接受`)
  }
})

test('dsh-tools peer 接受 0.2.x（本次修复的目标）', () => {
  for (const version of ['0.2.0-rc.1', '0.2.0-rc.2', '0.2.0', '0.2.1', '0.2.9']) {
    assert.ok(caretAdmits(version, PEER!), `${version} 应被接受`)
  }
})

test('dsh-tools peer 覆盖当前 DSH 运行时 0.2.0-rc.2', () => {
  assert.ok(caretAdmits('0.2.0-rc.2', PEER!), '0.2.0-rc.2 必须被接受，否则安装会被拒')
})

test('dsh-tools peer 拒绝范围外版本（不放宽成任意版本）', () => {
  for (const version of ['0.1.0', '0.1.1', '0.1.2-rc.0', '0.3.0-rc.1', '0.3.0', '1.0.0']) {
    assert.ok(!caretAdmits(version, PEER!), `${version} 不应被接受`)
  }
})

test('拒装口径：上界的 -0 才是预发布的闸门（includePrerelease）', () => {
  // DSH 用 includePrerelease: true，预发布排除规则关闭，完全由上界决定。
  // 同 minor 内的预发布照常放行 —— 与真实 semver 实测一致。
  assert.ok(caretAdmits('0.1.7-rc.1', '^0.1.2-rc.1'))
  // 新旧范围的差别恰好在这里：0.2.0 的预发布被 0.2.0-0 上界挡住。
  assert.ok(!caretAdmits('0.2.0-rc.1', '^0.1.2-rc.1'), '旧范围挡住 0.2.x 预发布')
  assert.ok(!caretAdmits('0.2.0-rc.2', '^0.1.2-rc.1'), '旧范围正是这样拒掉 0.2.0-rc.2')
  assert.ok(caretAdmits('0.2.0-rc.2', '^0.1.2-rc.1 || ^0.2.0-rc.1'), '补上第二段后放行')
})

test('caretAdmits 自身与本仓库用到的 semver 语义一致', () => {
  // 用几个不经 package.json 的样例反向校验辅助函数，防止它悄悄写错。
  assert.ok(caretAdmits('1.2.3', '^1.2.3'))
  assert.ok(caretAdmits('1.9.0', '^1.2.3'))
  assert.ok(!caretAdmits('2.0.0', '^1.2.3'), '>=1.0.0 的 caret 锁 major')
  assert.ok(!caretAdmits('1.2.2', '^1.2.3'))
  assert.ok(!caretAdmits('1.2.3-rc.1', '^1.2.3'), '普通下界不补 -0，预发布被挡在下界之外')
  assert.ok(!caretAdmits('0.2.0-rc.1', '^0.2.0'), '0.x 的普通下界同样不补 -0')
  assert.ok(caretAdmits('1.2.3-rc.0', '^1.2.3-rc.0'), '带预发布的下界才放行同号预发布')
  assert.ok(caretAdmits('1.2.3-rc.2', '^1.2.3-rc.1'), '同一 major.minor.patch 的预发布放行')
  assert.ok(caretAdmits('0.1.9', '^0.1.0'), '0.x 的 caret 锁 minor，0.1.x 全放行')
  assert.ok(!caretAdmits('0.2.0', '^0.1.0'), '0.x 的 caret 锁 minor，不进 0.2.x')
  assert.ok(!caretAdmits('0.2.0-rc.1', '^0.1.0'), '0.x 的 caret 锁 minor，预发布也不进 0.2.x')
})
