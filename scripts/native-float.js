// 原生 macOS 悬浮球置顶：用 koffi 直接调用 AppKit，设置 NSWindow 的
// collectionBehavior（加入所有 Space + 全屏辅助 + 静止 + 忽略循环）与
// window level（screen-saver 最高层级）。这是豆包等成熟应用实现
// "全屏下悬浮球置顶"的原生做法，比 Electron 高层 API 更可靠。
//
// 依赖 koffi（dsh 传递依赖，自带 darwin/win32/linux 原生二进制）。
// 仅 macOS 使用；其他平台直接 no-op。koffi 延迟到首次调用时加载，
// 避免在非 macOS 平台因 optionalDependencies 缺失而阻塞模块加载。
'use strict'

let koffi = null

// macOS collectionBehavior 位（NSWindow.h）
// 注意：ElectronNSPanel(type:'panel') 的 setCollectionBehavior: 会自动 OR 上
// CanJoinAllSpaces | FullScreenAuxiliary，因此这里只需补充 IgnoresCycle，
// 不要设置 MoveToActiveSpace（与 CanJoinAllSpaces 互斥，会导致 AppKit 异常）。
const NSWindowCollectionBehaviorFullScreenAuxiliary = 1 << 8 // 256
const NSWindowCollectionBehaviorIgnoresCycle = 1 << 6 // 64
const FLOAT_COLLECTION_BEHAVIOR =
  NSWindowCollectionBehaviorFullScreenAuxiliary |
  NSWindowCollectionBehaviorIgnoresCycle
// window level：对齐豆包悬浮球实测 level=27。该值介于 NSStatusWindowLevel(25)
// 与 NSPopUpMenuWindowLevel(101) 之间，是 macOS 上"始终置顶且不被任何
// 全屏/最大化窗口遮挡"的经验值——NSStatusLevel(25) 在全屏 Space 下偶发
// 被剔除，screen-saver(1000) 又过高被系统级窗口过滤。豆包用 27 经大量
// 实测稳定可见。
const SCREEN_SAVER_LEVEL = 27

let initialized = false
let msg0 = null // objc_msgSend(void*, void*)
let msg1 = null // objc_msgSend(void*, void*, uint64_t) -> void*
let msgLong = null // objc_msgSend(void*, void*) -> long long（读属性）
let selWindow = null
let selSetCollectionBehavior = null
let selCollectionBehavior = null
let selSetLevel = null
let selSetHidesOnDeactivate = null
let selSetExcludedFromWindowsMenu = null
let selSetCanHide = null
let selSetHasShadow = null
let selDisableVideoOpacitySafe = null


// NSCursor（悬浮球拖动时强制手型，参考豆包拖动交互）
let clsNSCursor = null
let selClosedHandCursor = null
let selArrowCursor = null
let selSetCursor = null

function init() {
  if (initialized) return true
  if (process.platform !== 'darwin') return false
  try {
    if (!koffi) koffi = require('koffi')
    const libA = koffi.load('/usr/lib/libobjc.A.dylib')
    msg0 = libA.func('void * objc_msgSend(void *self, void *op)')
    const selReg = libA.func('void * sel_registerName(const char *name)')

    const libB = koffi.load('/usr/lib/libobjc.A.dylib')
    msg1 = libB.func('void * objc_msgSend(void *self, void *op, uint64_t v)')
    // 读 long long 属性（collectionBehavior / level），arm64 上返回值在 rax，可用 long long 签名读取
    msgLong = libB.func('long long objc_msgSend(void *self, void *op)')

    // 之前尝试用 object_setClass 把 NSWindow → NSPanel 升级，但 NSPanel
    // 比 NSWindow 多 ivar，反父子类化导致 SIGTRAP 崩溃。不安全，已移除。
    // 改回纯 NSWindow API + setHidesOnDeactivate:NO 等，让 macOS 把窗口
    // 视为"非激活辅助窗口"进入全屏 Space。

    selWindow = selReg('window')
    selSetCollectionBehavior = selReg('setCollectionBehavior:')
    selCollectionBehavior = selReg('collectionBehavior')
    selSetLevel = selReg('setLevel:')
    selSetHidesOnDeactivate = selReg('setHidesOnDeactivate:')
    selSetExcludedFromWindowsMenu = selReg('setExcludedFromWindowsMenu:')
    selSetCanHide = selReg('setCanHide:')

    // NSCursor：拖动悬浮球期间强制手型光标（拖动窗口频繁 setPosition 时
    // Chromium 的重绘可能把 CSS cursor 重置为默认箭头，原生 set 保证手型）
    const objcGetClass = libA.func('void * objc_getClass(const char *name)')
    clsNSCursor = objcGetClass('NSCursor')
    selClosedHandCursor = selReg('closedHandCursor')
    selArrowCursor = selReg('arrowCursor')
    selSetCursor = selReg('set')
    initialized = true
    return true
  } catch (e) {
    initialized = false
    return false
  }
}

/**
 * 把 Electron 窗口的原生 NSWindow 设为"全屏/所有 Space 下置顶"。
 * @param {Electron.BrowserWindow} win
 * @param {number} [level] 窗口层级，默认 SCREEN_SAVER_LEVEL(27)。
 *   悬浮球需要 27 才能"超越一切"置顶；迷你窗等需要接收输入法候选词的窗口
 *   必须用较低 level（如 NSFloatingWindowLevel=3），否则候选词窗口(level~25)
 *   会被高 level 窗口遮挡，导致"能输入中文但看不到候选词"。
 * @returns {boolean} 是否成功
 */
function applyNativeFloatTop(win, level = SCREEN_SAVER_LEVEL) {
  if (!win || win.isDestroyed()) return false
  if (!init()) return false
  try {
    const handle = win.getNativeWindowHandle()
    if (!handle || handle.length < 8) return false
    const nsView = handle.readBigUInt64LE()
    const nsWindow = msg0(nsView, selWindow)
    if (!nsWindow) return false
    // 原生设置 collectionBehavior 和 window level（豆包同款）。
    // Electron 的 setAlwaysOnTop / setVisibleOnAllWorkspaces 在 macOS
    // Sonoma+ 上偶发不生效，直接调 AppKit 是唯一可靠方案。
    if (selSetCollectionBehavior) msg1(nsWindow, selSetCollectionBehavior, FLOAT_COLLECTION_BEHAVIOR)
    if (selSetLevel) msg1(nsWindow, selSetLevel, level)
    // NSWindow 通用属性
    if (selSetHidesOnDeactivate) msg1(nsWindow, selSetHidesOnDeactivate, 0)
    if (selSetCanHide) msg1(nsWindow, selSetCanHide, 0)
    if (selSetExcludedFromWindowsMenu) msg1(nsWindow, selSetExcludedFromWindowsMenu, 1)
    return true
  } catch (_) {
    return false
  }
}

/**
 * 撤销 applyNativeFloatTop：还原为普通窗口（取消"全屏/所有 Space 置顶"）。
 * 否则仅调 Electron setAlwaysOnTop(false) 无法覆盖原生 setLevel(27)，
 * 导致"取消置顶"在 macOS 上失效。
 * @param {Electron.BrowserWindow} win
 * @returns {boolean} 是否成功
 */
function revertNativeFloatTop(win) {
  if (!win || win.isDestroyed()) return false
  if (!init()) return false
  try {
    const handle = win.getNativeWindowHandle()
    if (!handle || handle.length < 8) return false
    const nsView = handle.readBigUInt64LE()
    const nsWindow = msg0(nsView, selWindow)
    if (!nsWindow) return false
    // 还原为普通窗口层级(NSNormalWindowLevel=0)与默认集合行为
    if (selSetCollectionBehavior) msg1(nsWindow, selSetCollectionBehavior, 0)
    if (selSetLevel) msg1(nsWindow, selSetLevel, 0)
    return true
  } catch (_) {
    return false
  }
}

/**
 * 清除 NSWindowCollectionBehaviorCanJoinAllSpaces（bit 0）：
 * 取消"跟随所有 Space"，让窗口只在当前桌面显示（对齐豆包"取消置顶=普通窗口"）。
 * 只清除该位、保留其它集合行为；重复调用幂等。
 * @param {Electron.BrowserWindow} win
 * @returns {boolean} 是否成功
 */
function clearAllSpaces(win) {
  if (!win || win.isDestroyed()) return false
  if (!init()) return false
  try {
    const handle = win.getNativeWindowHandle()
    if (!handle || handle.length < 8) return false
    const nsView = handle.readBigUInt64LE()
    const nsWindow = msg0(nsView, selWindow)
    if (!nsWindow) return false
    const cur = msgLong(nsWindow, selCollectionBehavior) || 0
    const cleared = cur & ~(1 << 0) // 清 CanJoinAllSpaces
    if (selSetCollectionBehavior) msg1(nsWindow, selSetCollectionBehavior, cleared)
    return true
  } catch (_) {
    return false
  }
}

/**
 * 强制系统光标为"手型"或"默认箭头"。
 * 必须在主进程主线程调用（objc_msgSend 限制）。箭头光标惰性初始化，
 * 需 NSApp 已存在（Electron 主进程总是满足，纯 node 进程会返回空）。
 * 拖动结束务必传 false 恢复，否则会全局影响其他窗口的光标。
 * @param {boolean} isHand
 * @returns {boolean} 是否成功
 */
function setFloatCursor(isHand) {
  if (!init()) return false
  try {
    const cursor = msg0(clsNSCursor, isHand ? selClosedHandCursor : selArrowCursor)
    if (!cursor) return false
    msg0(cursor, selSetCursor)
    return true
  } catch (_) {
    return false
  }
}

module.exports = { applyNativeFloatTop, revertNativeFloatTop, clearAllSpaces, setFloatCursor, FLOAT_COLLECTION_BEHAVIOR, SCREEN_SAVER_LEVEL: 27 }
