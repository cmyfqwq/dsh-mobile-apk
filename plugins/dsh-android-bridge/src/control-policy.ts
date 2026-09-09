/**
 * 设备控制通道策略（0.13.5 W4，PRD-0.13.2 §3.3 B2/B3 + HANDOVER-0.13.3 §196）。
 *
 * 两个后端：
 *   - `a11y` 无障碍通道（壳侧 AccessibilityService）：语义树 + performAction，
 *     需要用户显式开启无障碍服务；**这是「一次系统开关」就能用的轻量通道**；
 *   - `adb` 设备级通道（既有通道）：uiautomator dump + input，需要 ADB 三道人门，
 *     保留给 shell 执行、原图截图、系统面（pm/dumpsys）等高级场景。
 *
 * 不变量（fail-closed）：
 *   - 会话档位不是 danger-full-access → 两个后端都拒绝（隐私敏感面不因通道简化而放宽）；
 *   - a11y 未开启且 ADB 门未齐 → 拒绝并给出可执行的引导；
 *   - 策略是纯函数，便于单测；调用方（工具层）必须使用它的结论，不得自行旁路。
 */

export type ControlOp = 'snapshot' | 'click' | 'setText' | 'scroll' | 'global' | 'screenshot' | 'state'
  | 'nodeText' | 'webSnapshot' | 'webAction'

export interface ControlPolicyInput {
  op: ControlOp
  /** 壳侧无障碍服务已连接（live prefs 的 a11yEnabled）。 */
  a11yEnabled: boolean
  /** 既有 ADB 三道人门是否齐备（fullAccess && allowSwitch && paired && wirelessDebug）。 */
  adbReady: boolean
  /** 会话档位（sandboxPolicy.resolve({session}).mode）。 */
  sessionMode?: string
  /** 强制后端（调试/回退用）；缺省按可用性自动选择。 */
  forceBackend?: 'a11y' | 'adb'
}

export interface ControlDecision {
  backend: 'a11y' | 'adb' | 'deny'
  reason: string
  /** 拒绝时给用户/模型的下一步引导。 */
  guidance?: string
}

export const REQUIRED_SESSION_MODE = 'danger-full-access'

/** a11y 通道能覆盖的操作：五个语义操作 + 截屏（API 30+，见 A11Y-CONTROL-DESIGN.md §2.2）
 *  + `state`（便宜的状态读数：快照代次/失效标记，供点击生效校验，issue #129）
 *  + `webSnapshot`/`webAction`（issue #128 L1：自有 WebView 的 DOM 语义快照与动作——
 *  与 a11y 共用同一队列/心跳，壳侧在页面不在场时明确报错）。 */
export const A11Y_OPS: readonly ControlOp[] = [
  'snapshot', 'click', 'setText', 'scroll', 'global', 'screenshot', 'state', 'nodeText', 'webSnapshot', 'webAction',
]

export function decideControl(input: ControlPolicyInput): ControlDecision {
  if (input.sessionMode !== REQUIRED_SESSION_MODE) {
    return {
      backend: 'deny',
      reason: `会话档位为 ${input.sessionMode ?? '未知'}，设备控制面要求 ${REQUIRED_SESSION_MODE}`,
      guidance: '在会话的权限档位里切到「完全访问」后重试（无障碍通道同样受此门约束）。',
    }
  }

  if (input.forceBackend === 'adb') {
    return input.adbReady
      ? { backend: 'adb', reason: '已显式指定 ADB 通道' }
      : {
        backend: 'deny',
        reason: '显式指定 ADB 通道，但 ADB 三道人门未齐',
        guidance: '打开「手机管理」授权页，依次完成完全访问 / 授权开关 / 无线调试配对。',
      }
  }

  if (input.a11yEnabled) {
    if (A11Y_OPS.includes(input.op)) return { backend: 'a11y', reason: '无障碍服务已开启，优先走无障碍通道' }
    return {
      backend: 'deny',
      reason: `无障碍通道暂不支持操作 ${input.op}`,
      guidance: '该操作请用 ADB 通道（android_adb_shell_exec / 截图等）。',
    }
  }

  if (input.forceBackend === 'a11y') {
    return {
      backend: 'deny',
      reason: '显式指定无障碍通道，但无障碍服务未开启',
      guidance: '到系统设置 → 无障碍 → 已下载的服务里开启「DSH 设备控制」。',
    }
  }

  if (input.adbReady) return { backend: 'adb', reason: '无障碍服务未开启，回退到 ADB 通道' }

  return {
    backend: 'deny',
    reason: '无障碍服务未开启，且 ADB 三道人门未齐——设备控制不可用',
    guidance: '任选其一：① 系统设置 → 无障碍 → 开启「DSH 设备控制」（推荐，一次开关）；'
      + '② 打开「手机管理」授权页完成 ADB 三道人门（完全访问 + 授权开关 + 无线调试配对）。',
  }
}
