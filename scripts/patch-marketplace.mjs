#!/usr/bin/env node
/**
 * patch-marketplace.mjs — 固化 dshmarketplace-plugin@0.1.5 三项修复（幂等）。
 *
 * 修复 A（0.13.0，pre-execute 守卫，lib/index.js）：上游 tools/pre-execute listener 形如
 *   `async t => { if(非安装) return; ... }` —— 所有路径返回 undefined 且不调用 waterfall
 *   的 next()，导致 gate=undefined → 全工具执行读 `gate.kind` 崩溃（Cannot read properties
 *   of undefined (reading 'kind')）。修复：listener 改双参签名 `(t, n)` 并让每条路径
 *   `return n()`（无否决即透传）。
 *
 * 修复 B（0.13.1，安装 runner execPath 安全化，lib/index.js，issue apk#83/#89）：真机禁
 *   exec app-data ELF 时引擎经 /system/bin/linker64 回退启动 → process.execPath 被污染为
 *   linker64；市场安装 execFile(process.execPath,[bin.js,...]) 把 shebang 脚本当 ELF 加载
 *   → "bad ELF magic: 23212f75"。修复：execPath 改快照内真实 node 绝对路径。
 *   （真机 linker64 环境 modlens 端到端实测通过：200 / pnpm Done / profile 登记。）
 *
 * 修复 C（0.13.1 Phase1，不可安装条目置灰，lib/client.js）：installable:false 的条目
 *   （市场无安装命令/需凭据/仅桌面）仍渲染可点「安装」钮 → 风险确认后才 500 NO_COMMAND
 *   （2026-08-29 真机实测）。修复：卡片按钮 disabled + title 说明原因。
 *
 * 用法：node scripts/patch-marketplace.mjs <path/to/lib>（目录：index.js+client.js 双修补）
 *       或 <path/to/lib/index.js>（旧式单文件，仅 index 修复）。
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'

const p = process.argv[2]
if (!p) {
  console.error('用法: node scripts/patch-marketplace.mjs <path/to/lib>')
  process.exit(2)
}
const libDir = statSync(p).isDirectory() ? p : dirname(p)
const indexPath = join(libDir, 'index.js')
const clientPath = join(libDir, 'client.js')

// ── index.js：修复 A（3 锚点）+ 修复 B（execPath）──
const FIXED_INDEX = [
  'function tt(){return async (t,n)=>{if(t?.tool?.name!=="dshmarketplace_install")return n();',
  'if(!r)return n();',
  ')});return n()}}',
  // B：安装 runner execPath 安全化（壳 shellEnv 已注入 TERMUX__PREFIX，兜底烧写设备前缀）。
  'execPath:(process.env.TERMUX__PREFIX||"/data/data/com.dsharnessmobile.shell/files/usr")+"/bin/node"',
]
let indexChanged = 0
if (existsSync(indexPath)) {
  let t = readFileSync(indexPath, 'utf8')
  if (FIXED_INDEX.every((m) => t.includes(m))) {
    console.log('index.js: already fixed (A 3/3 + B execPath)——跳过')
  } else {
    // A-1 签名 + 首路径
    if (t.includes('function tt(){return async t=>{if(t?.tool?.name!=="dshmarketplace_install")return;')) {
      t = t.replace('function tt(){return async t=>{if(t?.tool?.name!=="dshmarketplace_install")return;', 'function tt(){return async (t,n)=>{if(t?.tool?.name!=="dshmarketplace_install")return n();')
      indexChanged++
    } else if (t.includes('dshmarketplace_install")return;')) {
      t = t.replace('dshmarketplace_install")return;', 'dshmarketplace_install")return n();')
      indexChanged++
    }
    // A-2 fullName 空路径
    if (!t.includes('if(!r)return n();') && t.includes('if(!r)return;')) {
      t = t.replace('if(!r)return;', 'if(!r)return n();')
      indexChanged++
    }
    // A-3 尾部
    if (!t.includes(')});return n()}}') && t.includes('join(`\n`)}}')) {
      t = t.replace('join(`\n`)}}', 'join(`\n`)});return n()}}')
      indexChanged++
    }
    // B execPath 安全化
    const EXEC_OLD = 'execPath:process.execPath,cliPath:process.argv[1]'
    const EXEC_NEW = 'execPath:(process.env.TERMUX__PREFIX||"/data/data/com.dsharnessmobile.shell/files/usr")+"/bin/node",cliPath:process.argv[1]'
    if (t.includes(EXEC_OLD)) {
      t = t.replace(EXEC_OLD, EXEC_NEW)
      indexChanged++
    } else if (!t.includes(EXEC_NEW)) {
      console.error('execPath 锚点未命中且安全化形态不在场——T() 实现可能已变，请人工核对')
    }
    if (indexChanged === 0) {
      console.error('index.js: PATTERN NOT FOUND——未匹配任何已知形态；请人工检查 lib/index.js 的 tt()/T() 实现')
      const i = t.indexOf('function tt()')
      if (i >= 0) console.error(t.slice(i, i + 700))
      process.exit(1)
    }
    if (!FIXED_INDEX.every((m) => t.includes(m))) {
      console.error('index.js: 修复后复核失败（锚点缺失）——不写回，请人工检查')
      process.exit(1)
    }
    writeFileSync(indexPath, t)
    console.log(`index.js: patched ok (${indexChanged} 处替换)`)
  }
} else {
  console.error(`index.js 不存在: ${indexPath}`)
  process.exit(1)
}

// ── client.js：修复 C（不可安装条目置灰）──
const GREY_OLD = 'className:"dshm-install",disabled:n==="installing"||n==="installed",onClick:()=>a(e)'
const GREY_NEW = 'className:"dshm-install",title:e.installable===false?"该条目当前不可安装（市场无安装命令，或需凭据/仅桌面环境）":"",disabled:n==="installing"||n==="installed"||e.installable===false,onClick:()=>a(e)'
if (existsSync(clientPath)) {
  let c = readFileSync(clientPath, 'utf8')
  if (c.includes('||e.installable===false')) {
    console.log('client.js: already fixed (C 置灰在场)——跳过')
  } else if (c.includes(GREY_OLD)) {
    c = c.replace(GREY_OLD, GREY_NEW)
    if (!c.includes('||e.installable===false')) {
      console.error('client.js: 置灰复核失败——不写回')
      process.exit(1)
    }
    writeFileSync(clientPath, c)
    console.log('client.js: patched ok (C 不可安装置灰)')
  } else {
    console.error('client.js: 置灰锚点未命中——安装按钮渲染可能已变，请人工核对（不阻断打包，仅警告）')
  }
}

// ── 补丁 D（0.13.2 Phase2-1，PRD W1：移动兼容性徽章 + mobile: 前缀过滤）──
// server：/api/dshmarketplace/search 响应逐条富化 compat/compatNote（嵌入兼容性
//   map，按 fullName 末段匹配；未登记默认 unknown），q 以 "mobile:" 前缀开头时
//   过滤掉 desktop 条目（工具面 schema 不动——B 的 additionalProperties:false 校验
//   只在 dshmarketplace_search 工具输出路径，富化仅发生在 webServer 响应层）。
// client：卡片 meta 行加 compat 徽章（内联样式，免 CSS 修补）；搜索框旁「仅移动端
//   可用」复选框 → 把 "mobile: " 前缀并入搜索词（回显可见、随搜索词一起提交）。
const COMPAT_MAP = {
  modlens: 'ok', 'dsh-better-sidebar': 'ok', 'dsh-whale-widget': 'ok',
  'deepseek-balance-whale-widget': 'ok', 'dsh-ads': 'ok',
  'dsh-at-file': 'ok', 'dsh-routing-suite': 'ok', 'dsh-web': 'ok', 'dsh-context': 'ok',
  'anysearch-dsh': 'ok', 'dsh-mnemon': 'ok', 'whale-girl': 'ok', 'dsh-market': 'ok',
  'dsh-pocket': 'ok', 'dsh-im': 'ok',
  'dsh-desktop': 'desktop', 'pilot-harness': 'desktop', 'guizang-dsh-desktop': 'desktop',
  'deepseek-harness-studio': 'desktop', 'dsh-transparent-ui-plugin': 'desktop',
  'dsh-desktop-base': 'desktop', 'dsh-ios': 'desktop',
  'dsh-browser': 'native',
}
const COMPAT_NOTE = { ok: '移动端可用', desktop: '仅桌面（bionic 不可用）', native: '含原生依赖（bionic 未验证）', unknown: '未验证（装前留意）' }

// ── index.js D-server ──
const D_MARK = 'function Wc('
const D_SRV_INSERT_BEFORE = 'function qt(t){'
const D_SRV = `function Wc(t){let _=${JSON.stringify(COMPAT_MAP)},e=String(t.fullName??"").split("#").pop().split("/").pop().toLowerCase(),f=_?.[e]??"unknown",n=${JSON.stringify(COMPAT_NOTE)}[f];return{...t,compat:f,compatNote:n}}`
const D_SRV_OLD = 'let a=await u({q:s.searchParams.get("q")??void 0,category:s.searchParams.get("category")??void 0,limit:s.searchParams.get("limit")??60});l(e,200,a)'
const D_SRV_NEW = 'let _q=s.searchParams.get("q")??void 0,_m=String(_q??"").startsWith("mobile:");if(_m)_q=String(_q).slice(7).trim()||void 0;let a=await u({q:_q,category:s.searchParams.get("category")??void 0,limit:s.searchParams.get("limit")??60});a.results=(a.results??[]).map(x=>Wc(x));if(_m)a.results=a.results.filter(x=>x.compat!=="desktop");l(e,200,a)'
if (existsSync(indexPath)) {
  let t = readFileSync(indexPath, 'utf8')
  if (t.includes(D_MARK)) {
    // 幂等 + map 强制同步（别名增补等数据更新直接反映到已修补文件）
    const mapRe = /let _=\{.*?\},e=String\(t\.fullName/
    if (!mapRe.test(t)) {
      console.error('index.js: D map 锚点未命中——请人工核对')
      process.exit(1)
    }
    t = t.replace(mapRe, `let _=${JSON.stringify(COMPAT_MAP)},e=String(t.fullName`)
    writeFileSync(indexPath, t)
    console.log('index.js: D map 已同步（幂等刷新）')
  } else {
    if (!t.includes(D_SRV_INSERT_BEFORE)) {
      console.error('index.js: D 插入锚点 qt( 未命中——请人工核对')
      process.exit(1)
    }
    t = t.replace(D_SRV_INSERT_BEFORE, D_SRV + D_SRV_INSERT_BEFORE)
    if (!t.includes(D_SRV_OLD)) {
      console.error('index.js: D 搜索端点锚点未命中——上游 handler 可能已变：')
      const i = t.indexOf('searchParams.get("q")')
      if (i >= 0) console.error(t.slice(i, i + 400))
      process.exit(1)
    }
    t = t.replace(D_SRV_OLD, D_SRV_NEW)
    if (!t.includes(D_MARK) || !t.includes('compat!==\"desktop\"')) {
      console.error('index.js: D 复核失败——不写回')
      process.exit(1)
    }
    writeFileSync(indexPath, t)
    console.log('index.js: patched ok (D 兼容徽章富化 + mobile: 过滤)')
  }
}

// ── client.js D-client（徽章 + 仅移动端复选框）──
const D_CLI_MARK = 'dshm-compat'
const D_CLI_HELPERS = `function Uq(e){return e==="ok"?"#2f9e68":e==="desktop"?"#b96a2a":e==="native"?"#8a5fc0":"#8a8f98"}function Uw(e){return e==="ok"?"移动可用":e==="desktop"?"仅桌面":e==="native"?"原生?":"未验证"}`
const D_CLI_HELPERS_ANCHOR = 'var B=Object.create;var h=Object.defineProperty;'
const D_CLI_BADGE_OLD = 'i?s.default.createElement("span",{className:"dshm-risk"},e.riskFlags.join(" \\xB7 ")):null,s.default.createElement("a",{href:e.url,target:"_blank",rel:"noopener"},r("details"))'
const D_CLI_BADGE_NEW = 'i?s.default.createElement("span",{className:"dshm-risk"},e.riskFlags.join(" \\xB7 ")):null,s.default.createElement("span",{className:"dshm-compat",style:{margin:"0 0 0 6px",fontSize:11,padding:"0 6px",borderRadius:4,color:"#fff",background:Uq(e.compat)}},Uw(e.compat)),s.default.createElement("a",{href:e.url,target:"_blank",rel:"noopener"},r("details"))'
const D_CLI_FILTER_OLD = 'onChange:o=>m(o.target.value)}),l==="loading"'
const D_CLI_FILTER_NEW = 'onChange:o=>m(o.target.value)}),s.default.createElement("label",{style:{marginLeft:10,display:"inline-flex",alignItems:"center",gap:4,fontSize:13}},s.default.createElement("input",{type:"checkbox",checked:/^mobile:/.test(n),onChange:o=>{let v=(n||"").replace(/^mobile:\\s*/,"");m(o.target.checked?"mobile: "+v:v)}}),"仅移动端可用"),l==="loading"'
if (existsSync(clientPath)) {
  let c = readFileSync(clientPath, 'utf8')
  if (c.includes(D_CLI_MARK)) {
    console.log('client.js: already fixed (D 徽章在场)——跳过')
  } else {
    if (!c.includes(D_CLI_HELPERS_ANCHOR)) {
      console.error('client.js: D 助手锚点未命中——请人工核对')
      process.exit(1)
    }
    c = c.replace(D_CLI_HELPERS_ANCHOR, D_CLI_HELPERS + D_CLI_HELPERS_ANCHOR)
    if (!c.includes(D_CLI_BADGE_OLD)) {
      console.error('client.js: D 徽章锚点未命中——dshm-risk 段已变：')
      const i = c.indexOf('dshm-risk"')
      if (i >= 0) console.error(c.slice(i, i + 260))
      process.exit(1)
    }
    c = c.replace(D_CLI_BADGE_OLD, D_CLI_BADGE_NEW)
    if (!c.includes(D_CLI_FILTER_OLD)) {
      console.error('client.js: D 过滤锚点未命中——搜索框段已变：')
      const j = c.indexOf('dshm-search"')
      if (j >= 0) console.error(c.slice(j, j + 200))
      process.exit(1)
    }
    c = c.replace(D_CLI_FILTER_OLD, D_CLI_FILTER_NEW)
    if (!c.includes('dshm-compat') || !c.includes('仅移动端可用')) {
      console.error('client.js: D 复核失败——不写回')
      process.exit(1)
    }
    writeFileSync(clientPath, c)
    console.log('client.js: patched ok (D 徽章 + 仅移动端复选框)')
  }
}
console.log('patch-marketplace: ALL OK')
