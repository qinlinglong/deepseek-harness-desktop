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
const NSWindowCollectionBehaviorIgnoresCycle = 1 << 3 // 8
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
let msg1u = null // objc_msgSend(void*, void*, uint64_t) -> uint64_t
let selWindow = null
let selSetCollectionBehavior = null
let selSetLevel = null
let selSetHidesOnDeactivate = null
let selSetExcludedFromWindowsMenu = null
let selSetCanHide = null
let selSetFloatingPanel = null
let selSetBecomesKeyOnlyIfNeeded = null
let object_setClass = null
let objc_getClass = null
let nsPanelClass = null
let panelAppliedWindows = new WeakSet()

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
    const libC = koffi.load('/usr/lib/libobjc.A.dylib')
    msg1u = libC.func('uint64_t objc_msgSend(void *self, void *op, uint64_t v)')

    // object_setClass: 把 NSWindow 实例动态升级为 NSPanel（运行时改 isa 指针）。
    // 这是 Raycast/Alfred/豆包等成熟悬浮球工具的真正做法：NSPanel 是
    // NSWindow 子类，没有额外 ivar，向上升级安全。NSPanel 在 macOS 全屏
    // Space 的显示行为与 NSWindow 本质不同——辅助面板可进入所有应用的全
    // 屏 Space 并显示，而 NSWindow 即使设了 hidesOnDeactivate:NO +
    // collectionBehavior 仍可能被剔除。
    object_setClass = libA.func('void * object_setClass(void *obj, void *cls)')
    objc_getClass = libA.func('void * objc_getClass(const char *name)')
    nsPanelClass = objc_getClass('NSPanel')

    selWindow = selReg('window')
    selSetCollectionBehavior = selReg('setCollectionBehavior:')
    selSetLevel = selReg('setLevel:')
    selSetHidesOnDeactivate = selReg('setHidesOnDeactivate:')
    selSetExcludedFromWindowsMenu = selReg('setExcludedFromWindowsMenu:')
    selSetCanHide = selReg('setCanHide:')
    selSetFloatingPanel = selReg('setFloatingPanel:')
    selSetBecomesKeyOnlyIfNeeded = selReg('setBecomesKeyOnlyIfNeeded:')
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

    // 一次性把 NSWindow 升级为 NSPanel（只执行一次，WeakSet 去重）
    if (nsPanelClass && object_setClass && !panelAppliedWindows.has(win)) {
      object_setClass(nsWindow, nsPanelClass)
      panelAppliedWindows.add(win)
    }

    // 全屏 Space 显示行为（NSPanel + FullScreenAuxiliary = 豆包同款）
    if (selSetCollectionBehavior) msg1(nsWindow, selSetCollectionBehavior, FLOAT_COLLECTION_BEHAVIOR)
    if (selSetLevel) msg1(nsWindow, selSetLevel, SCREEN_SAVER_LEVEL)
    // NSPanel 辅助面板行为
    if (selSetFloatingPanel) msg1(nsWindow, selSetFloatingPanel, 1)     // YES: 浮动面板始终置顶
    if (selSetBecomesKeyOnlyIfNeeded) msg1(nsWindow, selSetBecomesKeyOnlyIfNeeded, 1) // YES: 仅在需要时抢焦点
    if (selSetHidesOnDeactivate) msg1(nsWindow, selSetHidesOnDeactivate, 0)  // NO: 切到其他应用不隐藏
    if (selSetCanHide) msg1(nsWindow, selSetCanHide, 0)                       // NO: Cmd+H 不跟随隐藏
    if (selSetExcludedFromWindowsMenu) msg1(nsWindow, selSetExcludedFromWindowsMenu, 1) // YES
    return true
  } catch (_) {
    return false
  }
}

module.exports = { applyNativeFloatTop, FLOAT_COLLECTION_BEHAVIOR, SCREEN_SAVER_LEVEL: 27 }
