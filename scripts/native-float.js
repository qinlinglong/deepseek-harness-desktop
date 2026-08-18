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
const NSWindowCollectionBehaviorCanJoinAllSpaces = 1 << 0 // 1
const NSWindowCollectionBehaviorFullScreenAuxiliary = 1 << 8 // 256
const NSWindowCollectionBehaviorStationary = 1 << 4 // 16
const NSWindowCollectionBehaviorIgnoresCycle = 1 << 6 // 64
const FLOAT_COLLECTION_BEHAVIOR =
  NSWindowCollectionBehaviorCanJoinAllSpaces |
  NSWindowCollectionBehaviorFullScreenAuxiliary |
  NSWindowCollectionBehaviorStationary |
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
let selWindow = null
let selSetCollectionBehavior = null
let selSetLevel = null
let selSetHidesOnDeactivate = null
let selSetExcludedFromWindowsMenu = null
let selSetCanHide = null
let selSetHasShadow = null
let selDisableVideoOpacitySafe = null

// NSCursor（悬浮球拖动时强制手型，参考豆包拖动交互）
let clsNSCursor = null
let selPointingHandCursor = null
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

    // 之前尝试用 object_setClass 把 NSWindow → NSPanel 升级，但 NSPanel
    // 比 NSWindow 多 ivar，反父子类化导致 SIGTRAP 崩溃。不安全，已移除。
    // 改回纯 NSWindow API + setHidesOnDeactivate:NO 等，让 macOS 把窗口
    // 视为"非激活辅助窗口"进入全屏 Space。

    selWindow = selReg('window')
    selSetCollectionBehavior = selReg('setCollectionBehavior:')
    selSetLevel = selReg('setLevel:')
    selSetHidesOnDeactivate = selReg('setHidesOnDeactivate:')
    selSetExcludedFromWindowsMenu = selReg('setExcludedFromWindowsMenu:')
    selSetCanHide = selReg('setCanHide:')
    // NSCursor：拖动悬浮球期间强制手型光标（拖动窗口频繁 setPosition 时
    // Chromium 的重绘可能把 CSS cursor 重置为默认箭头，原生 set 保证手型）
    const objcGetClass = libA.func('void * objc_getClass(const char *name)')
    clsNSCursor = objcGetClass('NSCursor')
    selPointingHandCursor = selReg('pointingHandCursor')
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
 * @returns {boolean} 是否成功
 */
function applyNativeFloatTop(win) {
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
    if (selSetLevel) msg1(nsWindow, selSetLevel, SCREEN_SAVER_LEVEL)
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
    const cursor = msg0(clsNSCursor, isHand ? selPointingHandCursor : selArrowCursor)
    if (!cursor) return false
    msg0(cursor, selSetCursor)
    return true
  } catch (_) {
    return false
  }
}

module.exports = { applyNativeFloatTop, setFloatCursor, FLOAT_COLLECTION_BEHAVIOR, SCREEN_SAVER_LEVEL: 27 }
