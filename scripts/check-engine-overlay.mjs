#!/usr/bin/env node
// check-engine-overlay.mjs — 引擎 overlay 快照抽验门禁（0.13.3 W1）
// 对 snapshot.tar.xz 单遍流式扫描，断言 engine-overlay.json 登记表在快照内全量落位：
//   1. 根包 @deepseek-ai/dsh 版本 == engineVersion
//   2. packages 逐包在场且版本精确一致（220 包）
//   3. vendorTop / pins / nested 同上
//   4. keepUnpublished 包仍在树内（任意版本）
//   5. dsh-agent-presets 内置 presets/ 非空（0.1.2-rc.1 新载体）
// 退出 0 = PASS；1 = FAIL（拒绝打包）。双仓同版（雷点 10）。
//
// 用法：node scripts/check-engine-overlay.mjs <snapshot.tar.xz> [--manifest scripts/snapshot-config/engine-overlay.json]
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const snap = process.argv[2]
let manArg = null
{
  const i = process.argv.indexOf('--manifest')
  if (i > 0) manArg = resolve(process.argv[i + 1])
}
const manifestPath = manArg ?? join(HERE, 'snapshot-config', 'engine-overlay.json')
if (!snap) { console.error('用法: node scripts/check-engine-overlay.mjs <snapshot.tar.xz> [--manifest <engine-overlay.json>]'); process.exit(2) }
const M = JSON.parse(readFileSync(manifestPath, 'utf8'))
// W8 合规核验：overlay 新引 npm 依赖的许可证登记（非 copyleft 面，漂移即拒）
const LICENSES = JSON.parse(readFileSync(join(HERE, 'snapshot-config', 'engine-overlay-licenses.json'), 'utf8')).licenses

const NM = 'usr/lib/node_modules/@deepseek-ai/dsh/'
const want = new Map() // tarPath -> { kind, name, version, host }
const put = (rel, kind, name, version) => want.set(NM + rel, { kind, name, version })
put('package.json', 'root', '@deepseek-ai/dsh', M.engineVersion)
for (const [n, v] of Object.entries(M.packages)) put(`node_modules/${n}/package.json`, 'pkg', n, v)
for (const [n, v] of Object.entries(M.vendorTop ?? {})) put(`node_modules/${n}/package.json`, 'vendor', n, v)
for (const [n, v] of Object.entries(M.pins ?? {})) put(`node_modules/${n}/package.json`, 'pin', n, v)
for (const [h, children] of Object.entries(M.nested ?? {})) {
  for (const [n, v] of Object.entries(children)) put(`node_modules/${h}/node_modules/${n}/package.json`, 'nested', n, v)
}
for (const entry of M.keepUnpublished ?? []) {
  const name = entry.replace(/ \(.+\)$/, '')
  put(`node_modules/${name}/package.json`, 'keep', name, null)
}
put('node_modules/@deepseek-ai/dsh-agent-presets/package.json', 'presets-carrier', '@deepseek-ai/dsh-agent-presets', null)
const presetsPrefix = NM + 'node_modules/@deepseek-ai/dsh-agent-presets/presets/'
let presetsEntries = 0
// W4 引擎树补丁 marker（pi-drift-F1）随门禁抽验——快照内 lib/index.js 必须带降级标记
const PATCH_TARGET = NM + 'node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js'
const PATCH_MARKER = 'dsh-mobile drift guard'
want.set(PATCH_TARGET, { kind: 'patch-marker', name: 'pi-drift-F1', version: null })

const py = `
import tarfile, json, sys
want = json.loads(open(sys.argv[2], 'r', encoding='utf-8').read())
hits = {}
presets = 0
with tarfile.open(sys.argv[1], 'r|xz') as t:
    for m in t:
        n = m.name
        if n.startswith(sys.argv[3]) and m.isfile():
            presets += 1
        if n in want:
            hits[n] = t.extractfile(m).read().decode('utf-8', 'replace')
print(json.dumps({'hits': hits, 'presets': presets}))
`
let res
try {
  // python 脚本与 want 清单都经临时文件传递（cmd.exe 对多行 -c 参数/超长 argv 直接碎裂）
  const tmpPy = join(dirname(snap), `.engine-overlay-scan-${process.pid}.py`)
  const wantFile = join(dirname(snap), `.engine-overlay-want-${process.pid}.json`)
  writeFileSync(tmpPy, py)
  writeFileSync(wantFile, JSON.stringify([...want.keys(), presetsPrefix]))
  try {
    const snapWin = snap.replace(/\\/g, '/')
    res = JSON.parse(execSync(`python ${JSON.stringify(tmpPy)} ${JSON.stringify(snapWin)} ${JSON.stringify(wantFile)} ${JSON.stringify(presetsPrefix)}`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
  } finally {
    rmSync(tmpPy, { force: true })
    rmSync(wantFile, { force: true })
  }
} catch (e) {
  console.error(`ENGINE-OVERLAY CHECK FAILED（扫描执行失败）: ${String(e).slice(0, 400)}`)
  process.exit(1)
}

const fails = []
let checked = 0
for (const [path, meta] of want) {
  const content = res.hits[path]
  if (!content) {
    if (meta.kind === 'keep') fails.push(`keep 包缺失: ${meta.name}`)
    else fails.push(`[${meta.kind}] 缺失: ${meta.name} (${path})`)
    continue
  }
  if (meta.version) {
    let ver = null
    try { ver = JSON.parse(content).version } catch { /* 保留 null */ }
    if (ver !== meta.version) fails.push(`[${meta.kind}] 版本不符: ${meta.name} 期望 ${meta.version} 实得 ${ver}`)
    checked++
  } else if (meta.kind === 'patch-marker') {
    if (!content.includes(PATCH_MARKER)) fails.push('[patch-marker] pi-drift-F1 降级标记缺席（补丁未施加或版本漂移）')
    checked++
  } else if (meta.kind === 'vendor' || meta.kind === 'nested' || meta.kind === 'pin') {
    // W8：登记清单内的包顺带核验 license 字段（比对 engine-overlay-licenses.json）
    const expected = LICENSES[meta.name]
    if (expected !== undefined) {
      let license = null
      try { license = JSON.parse(content).license } catch { /* 保留 null */ }
      if (typeof license !== 'string' || !license.toUpperCase().includes(expected.toUpperCase())) {
        fails.push(`[license] ${meta.name} 登记 ${expected} 实得 ${license}——上游许可变更，人工核对后更新登记`)
      }
    }
    checked++
  } else checked++
}
if (res.presets < 1) fails.push(`dsh-agent-presets 内置 presets/ 为空（${res.presets} 项）——0.1.2-rc.1 预设载体缺席`)
else console.log(`  dsh-agent-presets presets/ 条目: ${res.presets}`)

if (fails.length) {
  console.error(`ENGINE-OVERLAY CHECK FAILED（${fails.length} 项）:`)
  for (const f of fails) console.error('  - ' + f)
  process.exit(1)
}
console.log(`ENGINE-OVERLAY CHECK PASSED（${checked} 包版本断言 + presets 在场；引擎 ${M.engineVersion}）`)
