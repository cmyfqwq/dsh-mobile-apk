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
