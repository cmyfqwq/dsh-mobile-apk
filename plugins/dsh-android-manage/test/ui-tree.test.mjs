// UI 树祖先回退回归（2026-09-08 修复）：模型引用的是重编号公开 id（n0/n1…），
// 而 byOrig 以原始 XML 路径 id 为键——旧实现用公开 id 查 byOrig 永远落空，
// 不可点击目标的「可点击祖先」回退静默失效。本测试锁死该边界。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseUiTreeXml, pruneNodes, resolveRef, findActionableAncestor } from '../lib/ui-tree.js'

const ATTRS = 'checkable="false" checked="false" enabled="true" focusable="false" focused="false" ' +
  'long-clickable="false" password="false" selected="false" package="com.android.settings"'

function hierarchy(inner) {
  return `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n<hierarchy rotation="0">${inner}</hierarchy>`
}

test('resolves the clickable ancestor of a non-clickable labelled node', () => {
  const xml = hierarchy(
    `<node index="0" text="" resource-id="" class="android.widget.FrameLayout" ${ATTRS} ` +
      `clickable="false" scrollable="false" bounds="[0,0][1080,1920]">` +
      `<node index="1" text="" resource-id="com.android.settings:id/row" class="android.widget.LinearLayout" ${ATTRS} ` +
        `clickable="true" scrollable="false" bounds="[0,100][1080,200]">` +
        `<node index="0" text="设置" resource-id="com.android.settings:id/title" class="android.widget.TextView" ${ATTRS} ` +
          `clickable="false" scrollable="false" bounds="[20,120][200,180]" />` +
      `</node>` +
    `</node>`,
  )
  const { raw } = parseUiTreeXml(xml)
  const { nodes, byId, byOrig, parentByOrig } = pruneNodes(raw)

  const hit = resolveRef(byId, nodes, 'text:设置')
  assert.equal(hit.ok, true)
  assert.equal(hit.node.clickable, false)
  assert.match(hit.node.id, /^n\d+$/)

  const ancestor = findActionableAncestor(byId, byOrig, parentByOrig, hit.node)
  assert.ok(ancestor, 'clickable ancestor must be found through the public id index')
  assert.equal(ancestor.clickable, true)
  assert.equal(ancestor.rid, 'com.android.settings:id/row')
})

test('returns null when no ancestor survived pruning', () => {
  const xml = hierarchy(
    `<node index="0" text="" resource-id="" class="android.widget.FrameLayout" ${ATTRS} ` +
      `clickable="false" scrollable="false" bounds="[0,0][1080,1920]">` +
      `<node index="0" text="仅文本" resource-id="com.android.settings:id/title" class="android.widget.TextView" ${ATTRS} ` +
        `clickable="false" scrollable="false" bounds="[20,120][200,180]" />` +
    `</node>`,
  )
  const { raw } = parseUiTreeXml(xml)
  const { nodes, byId, byOrig, parentByOrig } = pruneNodes(raw)

  const hit = resolveRef(byId, nodes, 'text:仅文本')
  assert.equal(hit.ok, true)
  assert.equal(findActionableAncestor(byId, byOrig, parentByOrig, hit.node), null)
})

test('walks up through an intermediate pruned node via the original path chain', () => {
  const xml = hierarchy(
    `<node index="0" text="" resource-id="" class="android.widget.FrameLayout" ${ATTRS} ` +
      `clickable="false" scrollable="false" bounds="[0,0][1080,1920]">` +
      `<node index="0" text="" resource-id="com.android.settings:id/list" class="android.widget.ListView" ${ATTRS} ` +
        `clickable="false" scrollable="true" bounds="[0,0][1080,1920]">` +
        `<node index="0" text="" resource-id="com.android.settings:id/wrapper" class="android.widget.FrameLayout" ${ATTRS} ` +
          `clickable="false" scrollable="false" bounds="[0,100][1080,200]">` +
          `<node index="0" text="无线网络" resource-id="com.android.settings:id/title" class="android.widget.TextView" ${ATTRS} ` +
            `clickable="false" scrollable="false" bounds="[20,120][200,180]" />` +
        `</node>` +
      `</node>` +
    `</node>`,
  )
  const { raw } = parseUiTreeXml(xml)
  const { nodes, byId, byOrig, parentByOrig } = pruneNodes(raw)

  const hit = resolveRef(byId, nodes, 'text:无线网络')
  assert.equal(hit.ok, true)
  const ancestor = findActionableAncestor(byId, byOrig, parentByOrig, hit.node)
  assert.ok(ancestor)
  assert.equal(ancestor.scrollable, true)
  assert.equal(ancestor.rid, 'com.android.settings:id/list')
})

// ── 0.13.5：同名节点消歧（用户指出的误判风险）───────────────────────────────
test('同名节点保留且歧义时拒绝静默挑选，列出候选', () => {
  const xml = hierarchy(
    `<node index="0" text="" class="android.widget.FrameLayout" ${ATTRS} clickable="false" scrollable="false" bounds="[0,0][1080,1920]">` +
      `<node index="0" text="新建会话" class="android.widget.Button" ${ATTRS} clickable="true" scrollable="false" bounds="[0,100][400,200]" />` +
      `<node index="1" text="新建会话" class="android.widget.Button" ${ATTRS} clickable="true" scrollable="false" bounds="[500,100][900,200]" />` +
    `</node>`,
  )
  const { raw } = parseUiTreeXml(xml)
  const { nodes, byId } = pruneNodes(raw)
  const dup = nodes.filter((n) => n.text === '新建会话')
  assert.equal(dup.length, 2, '同名节点必须都保留')

  const ambiguous = resolveRef(byId, nodes, 'text:新建会话')
  assert.equal(ambiguous.ok, false, '多候选不得静默挑一个')
  assert.match(ambiguous.error, /匹配 2 个节点/)
  assert.match(ambiguous.error, /id:nN/)
  assert.equal(ambiguous.matches.length, 2)

  const byOccurrence = resolveRef(byId, nodes, 'text:新建会话#2')
  assert.equal(byOccurrence.ok, true)
  assert.equal(byOccurrence.node.id, dup[1].id)

  const outOfRange = resolveRef(byId, nodes, 'text:新建会话#3')
  assert.equal(outOfRange.ok, false)

  const byIdRef = resolveRef(byId, nodes, 'id:' + dup[0].id)
  assert.equal(byIdRef.ok, true)
  assert.equal(byIdRef.node.id, dup[0].id)
})

test('作用域引用 @nX 只在子树内匹配，避免侧边栏/主区同名互相污染', () => {
  const xml = hierarchy(
    `<node index="0" text="" class="android.widget.FrameLayout" ${ATTRS} clickable="false" scrollable="false" bounds="[0,0][1080,1920]">` +
      `<node index="0" text="" class="android.widget.LinearLayout" ${ATTRS} clickable="false" scrollable="false" bounds="[0,0][300,1920]">` +
        `<node index="0" text="确定" class="android.widget.Button" ${ATTRS} clickable="true" scrollable="false" bounds="[10,10][290,90]" />` +
      `</node>` +
      `<node index="1" text="" class="android.widget.LinearLayout" ${ATTRS} clickable="false" scrollable="false" bounds="[300,0][1080,1920]">` +
        `<node index="0" text="确定" class="android.widget.Button" ${ATTRS} clickable="true" scrollable="false" bounds="[320,10][600,90]" />` +
      `</node>` +
    `</node>`,
  )
  const { raw } = parseUiTreeXml(xml)
  const { nodes, byId } = pruneNodes(raw)
  const scopes = nodes.filter((n) => n.type === 'LinearLayout')
  assert.equal(scopes.length, 2)
  const right = resolveRef(byId, nodes, `text:确定@${scopes[1].id}`)
  assert.equal(right.ok, true)
  assert.equal(right.node.cx > 300, true, '应命中右半区那个「确定」')
})
