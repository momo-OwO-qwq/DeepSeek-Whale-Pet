'use strict'
// ============================================================================
// DeepSeek 余额小鲸鱼桌宠 —— Electron 主进程
// 职责：透明置顶窗口、独立设置窗口、托盘、全局热键、开机自启、单实例、
//       余额/用量拉取（lib/balance.js）、配置持久化（lib/config.js）、IPC 桥。
// ============================================================================
const path = require('path')
const fs = require('fs')
const os = require('os')
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, screen, Notification, nativeImage, dialog, nativeTheme, shell } = require('electron')

const configMod = require('./lib/config')
const balanceMod = require('./lib/balance')
const linesMod = require('./lib/lines')

const IS_SMOKE = process.argv.includes('--smoke-test')
const BASE_PX = 320
const MENU_W = 520
const MENU_H = 700
const LOW_NOTIFY_THROTTLE_MS = 30 * 60 * 1000

// ---- Wayland：强制走 XWayland，否则 setPosition / 拖拽不可用 --------------
// （用户可用 ELECTRON_OZONE_PLATFORM_HINT 显式覆盖）
if (process.platform === 'linux' && process.env.WAYLAND_DISPLAY && !process.env.ELECTRON_OZONE_PLATFORM_HINT) {
  app.commandLine.appendSwitch('ozone-platform', 'x11')
}

let petWin = null
let menuWin = null
let tray = null
let balanceService = null
let dragState = null
let lastLowNotifyAt = 0

// 拖拽引擎（主进程持有唯一权威）：
//  - 主通道：轮询 screen.getCursorScreenPoint()。注意 Electron 中光标坐标、
//    getBounds() 与渲染进程 clientX/Y 均为 DIP 坐标，直接做「增量位移」
//    （窗口位移 = 光标位移），不做任何 ×scaleFactor 换算 —— 放大锚点是
//    导致缩放环境下「拖回屏幕边缘遇空气墙」的根因。
//  - 备通道：光标通道停滞（>150ms 无光标移动，Windows 下 getCursorScreenPoint
//    可能在拖拽中被冻结）时，采用渲染进程上报的原始位移增量（movementX 累加
//    + client 坐标），主进程按 Δclient≈Δmovement−Δwin 做一致性守卫，
//    拒绝窗口移动合成的回送事件。
let dragTimer = null

// ------------------------------- 单实例 ------------------------------------
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (petWin && !petWin.isDestroyed()) {
      petWin.showInactive()
    }
  })
  main()
}

function main() {
  app.whenReady().then(onReady)
  app.on('window-all-closed', () => {
    app.quit()
  })
  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
  })
}

async function onReady() {
  balanceService = new balanceMod.BalanceService()
  linesMod.readPool() // 启动即生成随机台词默认池（~/.config/whale-pet/lines.json，首次）
  createPetWindow()
  createMenuWindow() // 隐藏创建；打开时由 openMenu() 居中
  applyNativeTheme()
  setupTray()
  setupShortcuts()
  registerIpc()

  if (IS_SMOKE) await runSmoke()
}

// ================================ 鲸鱼窗口 =================================
// 置顶 + （macOS/Linux）全工作区可见。Windows 不支持 'screen-saver' level 与
// setVisibleOnAllWorkspaces，作降级处理（仅置顶），避免异常。
function pinPetWindow(win) {
  try { win.setAlwaysOnTop(true, 'screen-saver') } catch (err) {
    try { win.setAlwaysOnTop(true) } catch (e) { /* ignore */ }
  }
  if (process.platform !== 'win32') {
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }) } catch (err) { /* ignore */ }
  }
}

function createPetWindow() {
  // 首帧前按配置缩放尺寸与位置创建（否则启动时 setSize 在窗口映射前可能被 WM 丢弃，
  // 导致改过的尺寸/位置不生效、回到 320 默认）
  let initX = 0
  let initY = 0
  let initSize = BASE_PX
  try {
    const cfg = configMod.getEffective()
    const wa = screen.getPrimaryDisplay().workArea
    initSize = Math.round(BASE_PX * (cfg.scale || 1))
    if (typeof cfg.posX === 'number' && typeof cfg.posY === 'number') {
      initX = Math.max(wa.x, Math.min(cfg.posX, wa.x + wa.width - initSize))
      initY = Math.max(wa.y, Math.min(cfg.posY, wa.y + wa.height - initSize))
    } else {
      initX = wa.x + wa.width - initSize
      initY = wa.y + wa.height - initSize
    }
  } catch (err) { /* 保持默认 */ }

  petWin = new BrowserWindow({
    width: initSize,
    height: initSize,
    x: initX,
    y: initY,
    transparent: true,
    frame: false,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
      spellcheck: false,
    },
  })
  petWin.setAlwaysOnTop(true)
  pinPetWindow(petWin)
  petWin.loadFile(path.join(__dirname, 'renderer', 'pet.html'))
  petWin.once('ready-to-show', () => {
    if (!petWin) return
    petWin.showInactive()
  })
  // Windows 11 偶发：透明置顶窗口在点击桌面（失焦）后被 DWM 从合成中剔除，
  // 表现为「鲸鱼消失，再点一次才恢复」。失焦时用 showInactive 重新强制显示
  // （不抢焦点），保持鲸鱼始终可见。
  petWin.on('blur', () => {
    if (petWin && !petWin.isDestroyed()) {
      try { petWin.showInactive() } catch (err) { /* ignore */ }
    }
  })
  petWin.on('closed', () => {
    petWin = null
    app.quit()
  })
}

// ================================ 设置窗口 =================================
// 系统原生窗口（带系统标题栏，非透明），Tab 标签页布局
function applyNativeTheme() {
  try {
    const cfg = configMod.getEffective()
    nativeTheme.themeSource = cfg.theme === 'dark' ? 'dark' : (cfg.theme === 'light' ? 'light' : 'system')
  } catch (err) { /* ignore */ }
}

function createMenuWindow(initX, initY) {
  menuWin = new BrowserWindow({
    width: MENU_W,
    height: MENU_H,
    x: typeof initX === 'number' ? Math.round(initX) : undefined,
    y: typeof initY === 'number' ? Math.round(initY) : undefined,
    frame: true,
    transparent: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: false,
    icon: path.join(__dirname, 'assets', 'DSniang1.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })
  menuWin.setMenuBarVisibility(false)
  menuWin.loadFile(path.join(__dirname, 'renderer', 'menu.html'))
  menuWin.on('closed', () => { menuWin = null })
}

function openMenu() {
  // 用户直接叉掉窗口后 menuWin 为 null —— 按需重建
  if (!menuWin || menuWin.isDestroyed()) createMenuWindow()
  if (!menuWin || menuWin.isDestroyed()) return
  // 居中打开：大尺寸鲸鱼不再遮挡设置窗（用户反馈）
  const d = (petWin && !petWin.isDestroyed()) ? screen.getDisplayMatching(petWin.getBounds()) : screen.getPrimaryDisplay()
  menuWin.center()
  menuWin.show()
  menuWin.focus()
}

// ================================ 托盘 =====================================
function trayIcon() {
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'DSniang1.png'))
    return img.isEmpty() ? img : img.resize({ width: 64, height: 64 })
  } catch (err) {
    return nativeImage.createEmpty()
  }
}

function setupTray() {
  try {
    tray = new Tray(trayIcon())
    tray.setToolTip('DeepSeek 余额小鲸鱼')
    tray.on('click', togglePet)
    tray.on('double-click', togglePet)
    rebuildTrayMenu()
  } catch (err) {
    console.warn('[tray] 托盘不可用: ' + ((err && err.message) || err))
  }
}

function rebuildTrayMenu() {
  if (!tray) return
  const cfg = configMod.getEffective()
  try {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示 / 隐藏鲸鱼', click: togglePet },
      { label: '立即刷新余额', click: () => sendRefresh() },
      { label: '打开设置', click: () => openMenu() },
      { type: 'separator' },
      { label: '开机自启', type: 'checkbox', checked: !!cfg.autostart, click: (item) => setAutostart(item.checked) },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]))
  } catch (err) { /* 少数桌面环境不支持动态菜单，忽略 */ }
}

function togglePet() {
  if (!petWin || petWin.isDestroyed()) return
  if (petWin.isVisible()) petWin.hide()
  else petWin.showInactive()
}

function sendRefresh() {
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send('whale:refresh')
}

function broadcast(channel, payload) {
  for (const w of [petWin, menuWin]) {
    try {
      if (w && !w.isDestroyed()) w.webContents.send(channel, payload)
    } catch (err) { /* ignore */ }
  }
}

// ================================ 热键 / 自启 ==============================
function setupShortcuts() {
  const accel = process.env.WHALE_PET_SHORTCUT || 'CommandOrControl+Shift+R'
  try {
    const ok = globalShortcut.register(accel, sendRefresh)
    if (!ok) console.warn('[shortcut] 注册失败（可能已被占用）: ' + accel)
  } catch (err) {
    console.warn('[shortcut] ' + ((err && err.message) || err))
  }
}

// XDG autostart（~/.config/autostart/*.desktop）；非 Linux 走 setLoginItemSettings
function applyAutostart(enabled) {
  try {
    if (process.platform === 'linux') {
      const dir = path.join(os.homedir(), '.config', 'autostart')
      const file = path.join(dir, 'deepseek-whale-pet.desktop')
      if (enabled) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
        const exec = app.isPackaged
          ? '"' + process.execPath + '"'
          : '"' + process.execPath + '" "' + app.getAppPath() + '"'
        // 桌面图标统一使用 DSniang1.png：打包后指向 electron-builder 由
        // DSniang1.png 生成的安装图标名；开发运行时指向仓库内的资产文件。
        const iconVal = app.isPackaged
          ? 'deepseek-whale-pet'
          : path.join(__dirname, 'assets', 'DSniang1.png')
        fs.writeFileSync(file, [
          '[Desktop Entry]',
          'Type=Application',
          'Name=DeepSeek Whale Pet',
          'Comment=DeepSeek 余额小鲸鱼桌宠',
          'Icon=' + iconVal,
          'Exec=' + exec,
          'Terminal=false',
          'X-GNOME-Autostart-enabled=true',
          'Categories=Utility;',
          '',
        ].join('\n'), 'utf8')
      } else {
        fs.rmSync(file, { force: true })
      }
      return true
    }
    app.setLoginItemSettings({ openAtLogin: !!enabled })
    return true
  } catch (err) {
    console.warn('[autostart] ' + ((err && err.message) || err))
    return false
  }
}

function setAutostart(enabled) {
  const ok = applyAutostart(enabled)
  configMod.save({ autostart: ok ? !!enabled : false })
  rebuildTrayMenu()
}

// ================================ 低余额通知 ==============================
function checkLowBalance(payload) {
  if (!payload || !payload.ok || !payload.ok) return
  const cfg = configMod.getEffective()
  const th = Number(cfg.lowBalanceThreshold)
  const b = Number(payload.totalBalance)
  if (!isFinite(th) || !isFinite(b) || b < 0 || b >= th) return
  const now = Date.now()
  if (now - lastLowNotifyAt < LOW_NOTIFY_THROTTLE_MS) return
  lastLowNotifyAt = now
  try {
    if (Notification.isSupported()) {
      const n = new Notification({
        title: '小鲸鱼提醒',
        body: '余额已不足 ' + th.toFixed(2) + ' 元（当前 ' + b.toFixed(2) + ' 元），记得充值哦~',
        icon: path.join(__dirname, 'assets', 'DSniang1.png'),
      })
      n.on('click', sendRefresh)
      n.show()
    }
  } catch (err) { /* 忽略通知失败 */ }
}

// ================================ IPC =====================================
function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o || {}, k) }

function sanitizeRects(rects) {
  if (!Array.isArray(rects)) return []
  const out = []
  for (const r of rects) {
    if (!r || typeof r !== 'object') continue
    const x = Number(r.x)
    const y = Number(r.y)
    const w = Number(r.w)
    const h = Number(r.h)
    if (isFinite(x) && isFinite(y) && isFinite(w) && isFinite(h) && w > 0 && h > 0) {
      out.push({ x, y, w, h })
    }
  }
  return out
}

async function getWorkAreaForPet() {
  const b = (petWin && !petWin.isDestroyed()) ? petWin.getBounds() : null
  const wa = b ? screen.getDisplayMatching(b).workArea : screen.getPrimaryDisplay().workArea
  return { x: wa.x, y: wa.y, width: wa.width, height: wa.height }
}

function registerIpc() {
  // ---------- 配置 ----------
  ipcMain.handle('config:get', () => {
    const cfg = configMod.getEffective()
    if (process.env.WHALE_PET_TRACE === '1') console.log('[trace] config:get scale=' + cfg.scale + ' dir=' + configMod.CONFIG_DIR)
    // 附带配置路径，供设置窗「打开文件/目录」按钮使用
    cfg.paths = {
      config: configMod.CONFIG_FILE,
      usage: configMod.USAGE_FILE,
      lines: linesMod.LINES_FILE,
      configDir: configMod.CONFIG_DIR,
      sounds: path.join(configMod.CONFIG_DIR, 'sounds'),
      images: path.join(configMod.CONFIG_DIR, 'images'),
    }
    return cfg
  })

  ipcMain.handle('config:set', (e, patch) => {
    const next = configMod.save(patch)
    if (!next) return configMod.getEffective()
    // 影响余额结果的字段变化 → 使缓存失效，下次立即按新配置计算
    if (hasOwn(patch, 'apiKey') || hasOwn(patch, 'platformToken') || hasOwn(patch, 'usageMode')) {
      balanceService.invalidate()
    }
    if (hasOwn(patch, 'autostart')) {
      setAutostart(!!next.autostart)
    }
    if (hasOwn(patch, 'theme')) {
      applyNativeTheme()
    }
    broadcast('config:changed', configMod.getEffective())
    return configMod.getEffective()
  })

  // ---------- 余额 ----------
  ipcMain.handle('balance:get', async () => {
    const payload = await balanceService.getSnapshot(configMod.getEffective())
    checkLowBalance(payload)
    return payload
  })

  // ---------- 窗口 ----------
  ipcMain.handle('window:get-workarea', () => getWorkAreaForPet())

  // 显示器完整包围盒（不含面板扣除）——拖拽钳制用，让鲸鱼可贴到桌面物理边缘
  ipcMain.handle('window:get-display-bounds', (e, msg) => {
    try {
      const b = (petWin && !petWin.isDestroyed()) ? petWin.getBounds() : null
      const d = b ? screen.getDisplayMatching(b) : screen.getPrimaryDisplay()
      return { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height }
    } catch (err) {
      const d = screen.getPrimaryDisplay()
      return { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height }
    }
  })

  // ---------- 透明像素点击穿透（window.setShape 只保留鲸鱼/气泡/按钮区域）----------
  ipcMain.on('pet:shape', (e, msg) => {
    if (!petWin || petWin.isDestroyed()) return
    const rects = sanitizeRects(msg && msg.rects)
    // 空 shape 在 Windows 上会把整个窗口从合成中剔除（鲸鱼「消失」且不可点）。
    // 守卫：渲染进程偶发算出空矩形（如图片换载瞬间）时保留上一次 shape。
    if (rects.length === 0) return
    if (process.env.WHALE_PET_TRACE === '1') console.log('[trace] shape', JSON.stringify(rects))
    try { petWin.setShape(rects) } catch (err) { /* 个别环境不支持 shape，忽略 */ }
  })

  ipcMain.handle('window:resize', (e, msg) => {
    if (!petWin || petWin.isDestroyed()) return { x: 0, y: 0, width: 0, height: 0 }
    const w = Math.max(80, Math.round(Number(msg && msg.w) || BASE_PX))
    const h = Math.max(80, Math.round(Number(msg && msg.h) || BASE_PX))
    if (process.env.WHALE_PET_TRACE === '1') console.log('[trace] resize ->', w, h)
    petWin.setSize(w, h)
    // 部分 WM 在 setSize 后会掉置顶层，重新声明
    pinPetWindow(petWin)
    return petWin.getBounds()
  })

  ipcMain.handle('window:set-pos', (e, msg) => {
    if (!petWin || petWin.isDestroyed()) return { x: 0, y: 0, width: 0, height: 0 }
    const x = Math.round(Number(msg && msg.x) || 0)
    const y = Math.round(Number(msg && msg.y) || 0)
    petWin.setPosition(x, y)
    return petWin.getBounds()
  })

  // ---------- 拖拽（主进程单权威引擎，见文件头注释）----------
  // 主通道：渲染进程 pointer 事件里的绝对屏幕坐标（screenX/Y 由 OS 实时下发，
  // 不会像 getCursorScreenPoint 那样在 Windows 拖拽中被缓存冻结）。主进程只做
  // 「目标位置 = 光标绝对坐标 − 抓取点锚点」，再钳制到窗口所在显示器 workArea。
  // 全部坐标均为 DIP，不做任何 ×scaleFactor —— 放大锚点正是缩放环境下
  // 「拖回屏幕边缘遇空气墙」的根因。增量（dx/dy）仅作冒烟测试与无绝对坐标时的备用。
  ipcMain.handle('drag:start', (e, msg) => {
    if (!petWin || petWin.isDestroyed()) return { ok: false }
    if (process.env.WHALE_PET_TRACE === '1') console.log('[trace] drag:start', JSON.stringify(msg), 'bounds', JSON.stringify(petWin.getBounds()))
    const b = petWin.getBounds()
    const sx = Number(msg && msg.screenX)
    const sy = Number(msg && msg.screenY)
    // 锚点 = 抓取瞬间「光标绝对坐标 − 窗口左上角」，用主进程实际窗口位置计算，
    // 保证与渲染进程 viewport 缩放无关（全部 DIP）。
    // XWayland 下渲染进程 screenX/Y 可能全为 0（不可用），此刻必须回退增量通道；
    // 仅当至少一个坐标非零（OS 真下发了绝对坐标）才使用绝对锚点。
    const hasAbs = isFinite(sx) && isFinite(sy) && (sx !== 0 || sy !== 0)
    dragState = {
      anchorX: hasAbs ? sx - b.x : (Number(msg && msg.offsetX) || 0),
      anchorY: hasAbs ? sy - b.y : (Number(msg && msg.offsetY) || 0),
      hasAbs,
      lastCursor: screen.getCursorScreenPoint(), // 主通道轮询起点
      lastCursorMoveAt: 0, // 上次光标通道生效时间（用于增量通道的让位判断）
      lastClientX: Number(msg && msg.offsetX) || 0,
      lastClientY: Number(msg && msg.offsetY) || 0,
      lastAppliedDx: 0,
      lastAppliedDy: 0,
      lastPos: null,
    }
    if (dragTimer) clearInterval(dragTimer)
    // 主力通道：主进程 16ms 轮询 getCursorScreenPoint（X11/Wayland/XWayland 下
    // 由 OS 实时上报，绝对可靠；渲染进程 screenX/Y 在部分 Linux 环境不可用，
    // 故不再依赖它作为唯一通道）。冒烟测试同样启动，因光标不动不会触发位移。
    dragTimer = setInterval(dragTick, 16)
    return { ok: true }
  })

  // 主通道：光标增量为权威（与文件头注释一致）。窗口位移 = 光标位移（DIP）。
  // 顶部不钳在 workArea.y，而是放款到「显示器完整边界 − headRoom」：
  // 鲸鱼图形位于窗口右下（上部留 40.55% 空白），只有允许窗口把空白推出屏幕，
  // 鲸鱼本体才能触到屏幕上缘（Linux/Windows 通用；这是「拖不到上部 1/4」的根因）。
  function dragTick() {
    if (!dragState || !petWin || petWin.isDestroyed()) return
    const b = petWin.getBounds()
    const cursor = screen.getCursorScreenPoint()
    if (dragState.lastCursor && (cursor.x !== dragState.lastCursor.x || cursor.y !== dragState.lastCursor.y)) {
      if (IS_SMOKE) { dragState.lastCursor = cursor; return }
      // 绝对锚点（纯 DIP，不乘 scaleFactor）：窗口顶 = 光标绝对坐标 − 抓取偏移。
      // 光标贴物理屏顶（y=0）时目标 ny=0−anchorY 可为负，窗口把鲸鱼图形上方的
      // 空白（headRoom）推出屏幕，鲸鱼本体才能触到屏幕上缘 —— 纯增量做不到：
      // 光标无法为负，窗口就永远卡在「光标能到的最上方」，表现为空气墙。
      dragState.lastCursor = cursor
      dragState.lastCursorMoveAt = Date.now() // 门控：增量通道据此让位
      const d = screen.getDisplayMatching(b)
      const head = Math.round(b.height * 0.4055) // 图形上/左侧留白
      const nx = Math.round(Math.min(Math.max(cursor.x - dragState.anchorX, d.bounds.x - head), Math.max(d.bounds.x, d.bounds.x + d.bounds.width - b.width)))
      const ny = Math.round(Math.min(Math.max(cursor.y - dragState.anchorY, d.bounds.y - head), Math.max(d.bounds.y, d.bounds.y + d.bounds.height - b.height)))
      if (nx !== b.x || ny !== b.y) petWin.setPosition(nx, ny)
      dragState.lastPos = { x: nx, y: ny }
      dragState.lastAppliedDx = nx - b.x
      dragState.lastAppliedDy = ny - b.y
    }
  }

  ipcMain.on('drag:delta', (e, msg) => {
    if (!dragState || !petWin || petWin.isDestroyed()) return
    // 光标通道仍活跃（<150ms 内有光标移动）时由其接管；渲染进程增量仅在\n    // 光标通道停滞时接管（Windows 下 getCursorScreenPoint 偶发冻结），\n    // 避免两个通道同时位移导致抖动/飞移。\n    if (dragState.lastCursorMoveAt && Date.now() - dragState.lastCursorMoveAt < 150) return
    // 纯增量位移：窗口位移 = 指针位移（与 dragTick 同一公式，不依赖任何锚点）。
    // 不使用绝对锚点公式 —— issue #1 空气墙的根因正是「绝对坐标 - 锚点」在
    // 坐标系不一致（Linux/XWayland 渲染进程 screenX/Y 与主进程 DIP 边界）时产生
    // 方向性漂移；增量公式天然免疫。
    const b = petWin.getBounds()
    const d = screen.getDisplayMatching(b)
    const bd = d.bounds // 顶部钳制用显示器完整边界（配合 headRoom 推出屏幕）
    const wa = d.workArea // 底部仍按 workArea 防止被任务栏/面板遮挡
    // 鲸鱼图形锚定在窗口右下、上部留空 40.55%（CSS: .wp-img 59.45%/bottom）。
    // 允许窗口顶部上移至多 40.55% 窗口高，让鲸鱼本体能触到屏幕上缘。
    const headRoom = Math.round(b.height * 0.4055) // 图形上/左侧留白
    const clampX = (v) => Math.round(Math.min(Math.max(v, bd.x - headRoom), Math.max(bd.x, bd.x + bd.width - b.width)))
    const clampY = (v) => Math.round(Math.min(Math.max(v, bd.y - headRoom), Math.max(wa.y, wa.y + wa.height - b.height)))
    // 绝对锚点主分支：渲染进程的 screenX/screenY 是 Linux 上唯一可靠的光标源
    // （本机实测 screen.getCursorScreenPoint() 冻结）。光标贴物理屏顶（sy=0）时
    // ny=0−anchorY 可为负，窗口把头部空白推出屏幕、鲸鱼图形触顶 —— 增量做不到。
    const sx = Number(msg && msg.screenX)
    const sy = Number(msg && msg.screenY)
    if (isFinite(sx) && isFinite(sy) && (sx !== 0 || sy !== 0)) {
      if (!dragState.hasAbs) {
        // 这次才拿到可靠绝对坐标：以当前窗口边界重算锚点
        dragState.anchorX = sx - b.x
        dragState.anchorY = sy - b.y
        dragState.hasAbs = true
      }
      const nx = clampX(sx - dragState.anchorX)
      const ny = clampY(sy - dragState.anchorY)
      if (nx !== b.x || ny !== b.y) petWin.setPosition(nx, ny)
      dragState.lastPos = { x: nx, y: ny }
      dragState.lastAppliedDx = nx - b.x
      dragState.lastAppliedDy = ny - b.y
      return
    }
    // 增量备分支：仅供冒烟合成事件 / 无法取得绝对坐标的老渲染进程。
    const dx = Number(msg && msg.dx) || 0
    const dy = Number(msg && msg.dy) || 0
    if (dx === 0 && dy === 0) return
    dragState.lastClientX = Number(msg && msg.cx) || 0
    dragState.lastClientY = Number(msg && msg.cy) || 0
    const nx = clampX(b.x + dx)
    const ny = clampY(b.y + dy)
    if (nx !== b.x || ny !== b.y) petWin.setPosition(nx, ny)
    dragState.lastPos = { x: nx, y: ny }
    dragState.lastAppliedDx = nx - b.x
    dragState.lastAppliedDy = ny - b.y
  })

  ipcMain.handle('drag:end', () => {
    if (dragTimer) { clearInterval(dragTimer); dragTimer = null }
    let pos = null
    if (dragState && dragState.lastPos) pos = dragState.lastPos
    else if (petWin && !petWin.isDestroyed()) {
      const p = petWin.getPosition()
      pos = { x: p[0], y: p[1] }
    }
    dragState = null
    return pos || { x: 0, y: 0 }
  })

  // ---------- 主图 / 预警图上传（复制到配置目录，与源文件解耦）----------
  function imagePatchFor(kind) {
    // 预警图默认取 assets/DSniang03.png（无此素材 → getEffective 置空 = 无默认预警图）
    return kind === 'alert' ? { alertImgPath: 'assets/DSniang03.png' } : { mainImgPath: 'assets/DSniang1.png' }
  }

  ipcMain.handle('image:pick', async (e, msg) => {
    const kind = msg && msg.kind === 'alert' ? 'alert' : 'main'
    try {
      const res = await dialog.showOpenDialog(menuWin && !menuWin.isDestroyed() ? menuWin : undefined, {
        title: kind === 'alert' ? '选择预警图片' : '选择主图',
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
        properties: ['openFile'],
      })
      if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, canceled: true }
      const src = res.filePaths[0]
      const imagesDir = path.join(configMod.CONFIG_DIR, 'images')
      fs.mkdirSync(imagesDir, { recursive: true, mode: 0o700 })
      const ext = (path.extname(src) || '.png').toLowerCase()
      const dest = path.join(imagesDir, (kind === 'alert' ? 'alert' : 'main') + ext)
      fs.copyFileSync(src, dest)
      const patch = kind === 'alert' ? { alertImgPath: dest } : { mainImgPath: dest }
      configMod.save(patch)
      broadcast('config:changed', configMod.getEffective())
      return { ok: true, path: dest }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) }
    }
  })

  ipcMain.handle('image:reset', (e, msg) => {
    const kind = msg && msg.kind === 'alert' ? 'alert' : 'main'
    configMod.save(imagePatchFor(kind))
    broadcast('config:changed', configMod.getEffective())
    return { ok: true }
  })

  // ---------- 自定义音效上传（复制到配置目录，与源文件解耦）----------
  const SOUND_KEY = { press: 'pressSound', release: 'releaseSound' }

  ipcMain.handle('sound:pick', async (e, msg) => {
    const which = msg && msg.which === 'release' ? 'release' : 'press'
    try {
      const res = await dialog.showOpenDialog(menuWin && !menuWin.isDestroyed() ? menuWin : undefined, {
        title: which === 'release' ? '选择松手音效（mp3/wav/ogg…）' : '选择按压音效（mp3/wav/ogg…）',
        filters: [{ name: '音频', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac'] }],
        properties: ['openFile'],
      })
      if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, canceled: true }
      const src = res.filePaths[0]
      const soundsDir = path.join(configMod.CONFIG_DIR, 'sounds')
      fs.mkdirSync(soundsDir, { recursive: true, mode: 0o700 })
      const ext = (path.extname(src) || '.mp3').toLowerCase()
      const dest = path.join(soundsDir, which + ext)
      fs.copyFileSync(src, dest)
      const patch = {}
      patch[SOUND_KEY[which]] = dest
      configMod.save(patch)
      broadcast('config:changed', configMod.getEffective())
      return { ok: true, path: dest }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) }
    }
  })

  ipcMain.handle('sound:reset', (e, msg) => {
    const which = msg && msg.which === 'release' ? 'release' : 'press'
    const patch = {}
    patch[SOUND_KEY[which]] = ''
    configMod.save(patch)
    broadcast('config:changed', configMod.getEffective())
    return { ok: true }
  })

  // ---------- 随机台词/动图（~/.config/whale-pet/lines.json，含默认池）----------
  // 首次访问自动写入默认池文件；用户可编辑后点「重载」实时生效。
  const LINES_FILE = linesMod.LINES_FILE
  ipcMain.handle('custom:get', () => {
    const data = linesMod.readPool()
    return { ...data, file: LINES_FILE }
  })

  ipcMain.handle('custom:reload', () => {
    const data = linesMod.readPool()
    broadcast('custom:changed', data)
    return { ...data, file: LINES_FILE }
  })

  // ---------- 透明像素点击穿透 ----------
  // 注意：不做 setIgnoreMouseEvents —— Linux/XWayland 下其事件转发与
  // screen.getCursorScreenPoint() 均不可靠（转发不触发、光标为事件缓存），
  // 曾导致真实点击全部穿透到桌面。本版与参考实现（deepseek-whale-pet）
  // 保持一致：整个窗口始终接收事件，鲸鱼本体外的点击由渲染进程忽略
  // （isWhaleHit 判定），实际交互区域只保留鲸鱼/气泡/菜单按钮覆盖区。

  // ---------- 设置窗口 ----------
  ipcMain.on('menu:open', () => openMenu())
  ipcMain.on('menu:close', () => {
    if (menuWin && !menuWin.isDestroyed()) menuWin.hide()
  })

  // ---------- 用系统默认程序打开文件/目录/URL（设置里的「打开」按钮）----------
  ipcMain.handle('shell:open-path', async (e, msg) => {
    const target = String(msg && msg.path || '')
    if (!target) return { ok: false, error: 'empty path' }
    try {
      if (/^(https?:|file:)/.test(target)) { await shell.openExternal(target); return { ok: true } }
      const p = target.replace(/^file:\/\//, '')
      let err = await shell.openPath(p)
      if (err && fs.existsSync(p)) {
        // 文件打开失败（如无法识别）→ 打开所在目录
        err = await shell.openPath(path.dirname(p))
      } else if (err) {
        // 目标不存在 → 打开配置目录
        await shell.openPath(configMod.CONFIG_DIR)
      }
      return err ? { ok: false, error: err } : { ok: true }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) }
    }
  })
}

// ================================ Smoke 测试 ===============================
// 说明：--smoke-test 用于自动化验证（CI / 开发机）。除基础状态外，还会：
//   1) capturePage 截图鲸鱼窗口与设置窗口（验证渲染）
//   2) sendInputEvent 模拟点击鲸鱼 → 验证点击刷新 + 气泡弹出链路
async function runSmoke() {
  const outDir = process.env.WHALE_PET_HOME || os.tmpdir()
  const results = { petCreated: !!petWin, menuCreated: !!menuWin, tray: !!tray }
  // 兜底：无论如何 20s 内退出，避免 CI/开发机挂死
  setTimeout(() => app.exit(0), 30000)
  const withTimeout = (p, ms, fallback) =>
    Promise.race([
      Promise.resolve(p).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })),
      new Promise((r) => setTimeout(() => r({ ok: false, e: 'timeout' }), ms)),
    ]).then((r) => (r.ok ? r.v : fallback))

  const capturer = async (win, name) => {
    const img = await withTimeout(win.webContents.capturePage(), 4000, null)
    if (img) {
      try {
        fs.writeFileSync(path.join(outDir, name), img.toPNG())
        results[name] = true
      } catch (err) {
        results[name] = 'WRITE FAIL: ' + String((err && err.message) || err)
      }
    } else {
      results[name] = 'CAPTURE TIMEOUT'
    }
  }
  await new Promise((r) => setTimeout(r, 1800))
  await capturer(petWin, 'smoke-pet-1.png')

  // 模拟点击鲸鱼（右下角鲸鱼区域中心）
  try {
    const b = petWin.getBounds()
    petWin.webContents.sendInputEvent({ type: 'mouseDown', x: b.width - 60, y: b.height - 60, button: 'left', clickCount: 1 })
    petWin.webContents.sendInputEvent({ type: 'mouseUp', x: b.width - 60, y: b.height - 60, button: 'left', clickCount: 1 })
    results.clickInjected = true
  } catch (err) {
    results.clickInjected = 'FAIL: ' + String((err && err.message) || err)
  }
  await new Promise((r) => setTimeout(r, 900))
  await capturer(petWin, 'smoke-pet-2.png')

  // 模拟拖拽（走真实输入管线：mouseDown → 系列 mouseMove → mouseUp），
  // 渲染进程 pointermove 驱动窗口移动 + 松手吸附。坐标必须保持在窗口内
  // （sendInputEvent 对窗口外坐标的行为不可控，会导致指针丢失）。
  // 模拟拖拽：向渲染进程派发合成 PointerEvent（movementX/Y 由脚本显式给出 ——
  // 与真实 X11 事件一致：movementX 是窗口位置无关的原始位移），
  // 覆盖真实事件走到的同一段处理器代码（pointerdown → pointermove×N →
  // pointerup → rAF 位移 → setWindowPos → 吸附）。
  const dragTrace = []
  const dispatchPtr = async (js) => {
    await withTimeout(petWin.webContents.executeJavaScript(js, true), 2000, null)
    await new Promise((r) => setTimeout(r, 45)) // 等 rAF 应用位置
    const p = petWin.getPosition()
    dragTrace.push({ x: p[0], y: p[1] })
  }
  const ptrDown = `(function(){document.dispatchEvent(new PointerEvent('pointerdown',{clientX:260,clientY:260,button:0,buttons:1,pointerId:7,pointerType:'mouse',isPrimary:true,bubbles:true,cancelable:true}))})()`
  // 物理一致的合成事件：client 随指针真实位移变化（movementX 与 client 增量相匹配）
  const ptrMove = (mx, my, cxi, cyi) => `(function(){document.dispatchEvent(new PointerEvent('pointermove',{clientX:${cxi},clientY:${cyi},movementX:${mx},movementY:${my},button:0,buttons:1,pointerId:7,pointerType:'mouse',isPrimary:true,bubbles:true,cancelable:true}))})()`
  const ptrUp = `(function(){document.dispatchEvent(new PointerEvent('pointerup',{clientX:260,clientY:260,button:0,buttons:1,pointerId:7,pointerType:'mouse',isPrimary:true,bubbles:true,cancelable:true}))})()`

  // 抽搐检测：拖拽轨迹上碎步位移必须单调同向（出现回摆即视为抽搐）
  const monotonic = (trace, axis, from) => {
    const signs = []
    for (const p of trace) {
      const d = p[axis] - from
      if (Math.abs(d) < 2) continue
      signs.push(d > 0 ? 1 : -1)
      from = p[axis]
    }
    for (let i = 1; i < signs.length; i++) if (signs[i] !== signs[0]) return false
    return true
  }
  try {
    results.drag = {}
    const wa = await getWorkAreaForPet()
    results.drag.workArea = wa
    results.drag.movementXProbe = await withTimeout(petWin.webContents.executeJavaScript('(function(){var e=new PointerEvent("pointermove",{movementX:-12,movementY:-20});return [e.movementX,e.movementY]})()', true), 2000, 'probe-timeout')
    results.customFile = await withTimeout(petWin.webContents.executeJavaScript('window.whaleAPI.getCustom()', true), 2000, 'custom-timeout')
    // 等渲染进程完成初始化定位（避免与 smoke 动作竞态）
    const expectedInit = { x: wa.x + wa.width - petWin.getBounds().width, y: wa.y + wa.height - petWin.getBounds().height }
    for (let i = 0; i < 50; i++) {
      const p = petWin.getPosition()
      if (Math.abs(p[0] - expectedInit.x) <= 2 && Math.abs(p[1] - expectedInit.y) <= 2) break
      await new Promise((r) => setTimeout(r, 100))
    }

    // ① 常规拖拽：每步 movement(-12,-20) × 8 → 位移 (-96,-160)，验证 1:1 跟手 + 不抽搐
    const before = petWin.getPosition()
    const traceStart = dragTrace.length
    // 记录渲染进程实际收到的所有 pointermove（含窗口移动引发的回送事件）
    await withTimeout(petWin.webContents.executeJavaScript(
      "window.__mvLog=[];document.addEventListener('pointermove',function(e){window.__mvLog.push([e.movementX,e.movementY,e.clientX,e.clientY,Date.now()%100000])},true)", true), 2000, null)
    await dispatchPtr(ptrDown)
    for (let i = 0; i < 8; i++) {
      // 物理一致的合成事件：首事件后 client 恒定（指针 × 窗口同速位移）
      await dispatchPtr(ptrMove(-12, -20, 248, 240))
      await new Promise((r) => setTimeout(r, 35))
    }
    await dispatchPtr(ptrUp)
    await new Promise((r) => setTimeout(r, 600))
    const c1 = petWin.getPosition()
    results.drag.mvLog = await withTimeout(petWin.webContents.executeJavaScript('window.__mvLog.slice(0,40)', true), 2000, 'timeout')
    const basicTrace = dragTrace.slice(traceStart)
    const preSnap = basicTrace.slice(0, -1) // 最后一笔是松手吸附后的位置，不计入轨迹
    results.drag.basic = {
      before,
      after: { x: c1[0], y: c1[1] },
      moved: Math.hypot(c1[0] - before[0], c1[1] - before[1]) > 20,
      noTwitch: monotonic(preSnap, 'x', before[0]) && monotonic(preSnap, 'y', before[1]),
      // 净位移 = 注入的 movement 总和（已取消贴边吸附，落点即指针位移终点）
      exact: Math.abs(c1[0] - (before[0] - 96)) <= 2 && Math.abs(c1[1] - (before[1] - 160)) <= 2,
    }

    // ② 验证拖到屏幕上缘（Linux 修复点）：引擎直连一次大幅上移，断言窗口顶部能到达
    // 「显示器完整边界 − headRoom」（即鲸鱼图形——位于窗口下 59.45%——能贴上屏幕上缘）。
    // 旧断言只检查 workArea 顶（面板下沿），未覆盖负坐标；XWayland 下若 WM 把负坐标
    // 钳回 0，此处会失败，从而复现「拖不到上方 1/4」。
    const disp = screen.getDisplayMatching(petWin.getBounds())
    const bd = disp.workArea
    const headRoom = Math.round(petWin.getBounds().height * 0.4055)
    const topLimit = disp.bounds.y - headRoom // 允许窗口顶超出屏幕上沿 headRoom
    // 分步 async（走渲染进程→主进程的正常 IPC 方向）：每个调用单独 executeJavaScript，
    // 前一个 invoke 完成后才开始下一步 —— 之前同步块写法在 dragState 建立前就发送了
    // delta，且上一版误用 webContents.send（主→渲染方向，渲染进程没有该监听），
    // 两者都导致引擎直达测试被丢弃（after==before 的伪通过）。
    const beforeTop = petWin.getPosition()
    await withTimeout(petWin.webContents.executeJavaScript('window.whaleAPI.dragStart(260,260,260,260)', true), 2000, null)
    await new Promise((r) => setTimeout(r, 150)) // 等主进程 dragState 就绪
    await withTimeout(petWin.webContents.executeJavaScript('window.whaleAPI.dragDelta(0,-4000,260,-3740,260,-3740)', true), 2000, null)
    await new Promise((r) => setTimeout(r, 200))
    await withTimeout(petWin.webContents.executeJavaScript('window.whaleAPI.dragEnd()', true), 2000, null)
    await new Promise((r) => setTimeout(r, 400))
    const c3 = petWin.getPosition()
    results.drag.topEdge = {
      beforeTop: { x: beforeTop[0], y: beforeTop[1] },
      after: { x: c3[0], y: c3[1] },
      // 应能到达上限（负坐标），证明鲸鱼图形可触屏幕上缘
      reachedTop: c3[1] <= topLimit + 2,
      topLimit,
      workAreaTop: bd.y,
      note: c3[1] < bd.y - 2 ? '窗口顶已越过任务栏/面板（负坐标生效）' : '窗口顶被钳回 workArea（负坐标可能被 WM 拒绝）',
    }

    // ③ 修改大小（用户曾报告改大小后难以移动——根因是贴边吸附在放大后
    // 把窗口拽回边缘，本次已取消吸附）。验证：缩放生效、鲸鱼右下角锚定、
    // 窗口仍在屏幕内。（拖拽行为由 ①② 覆盖；真实用户拖拽事件在开发机上
    // 会与本测试并发，不再在此处注入。）
    const posBeforeScale = petWin.getPosition()
    await withTimeout(petWin.webContents.executeJavaScript('window.whaleAPI.setConfig({scale: 1.5})', true), 3000, null)
    await new Promise((r) => setTimeout(r, 900))
    const sb = petWin.getBounds()
    const sbd = screen.getDisplayMatching(screen.getDisplayNearestPoint({ x: sb.x + sb.width / 2, y: sb.y + sb.height / 2 }).workArea).workArea
    results.drag.scaleDrag = {
      resized: sb.width === 480 && sb.height === 480,
      cornerAnchored: Math.abs((sb.x + sb.width) - (posBeforeScale[0] + 320)) <= 3 && Math.abs((sb.y + sb.height) - (posBeforeScale[1] + 320)) <= 3,
      inScreen: sb.x >= sbd.x && sb.y >= sbd.y && sb.x + sb.width <= sbd.x + sbd.width && sb.y + sb.height <= sbd.y + sbd.height,
    }

    // ④ 方向感知锚点：拖到左半屏后鲸鱼应镜像贴左（可触左边缘）。
    // 走真实 pointer 路径（pointerdown → 大幅度左移 pointermove → pointerup）：
    // 渲染进程 finishDrag → advancePos(左) → updateAnchor → wp-left。
    const cDown = `(function(){document.dispatchEvent(new PointerEvent('pointerdown',{clientX:260,clientY:260,button:0,buttons:1,pointerId:9,pointerType:'mouse',isPrimary:true,bubbles:true,cancelable:true}))})()`
    const cMove = (mx, cxi) => `(function(){document.dispatchEvent(new PointerEvent('pointermove',{clientX:${cxi},clientY:260,movementX:${mx},movementY:0,button:0,buttons:1,pointerId:9,pointerType:'mouse',isPrimary:true,bubbles:true,cancelable:true}))})()`
    const cUp = `(function(){document.dispatchEvent(new PointerEvent('pointerup',{clientX:-500,clientY:260,button:0,buttons:1,pointerId:9,pointerType:'mouse',isPrimary:true,bubbles:true,cancelable:true}))})()`
    await withTimeout(petWin.webContents.executeJavaScript(cDown, true), 2000, null)
    let cxi = 260 - 600
    for (let j = 0; j < 5; j++) { await withTimeout(petWin.webContents.executeJavaScript(cMove(-600, cxi), true), 2000, null); cxi -= 600; await new Promise((r) => setTimeout(r, 30)) }
    await withTimeout(petWin.webContents.executeJavaScript(cUp, true), 2000, null)
    await new Promise((r) => setTimeout(r, 700))
    const anchor = await withTimeout(petWin.webContents.executeJavaScript("(function(){var r=document.querySelector('.wp-root');return r?r.classList.contains('wp-left'):null})()", true), 2000, null)
    const ap = petWin.getPosition()
    results.drag.anchor = { pos: { x: ap[0], y: ap[1] }, flipped: anchor === true }
  } catch (err) {
    results.drag = 'FAIL: ' + String((err && err.message) || err)
  }

  openMenu()
  await new Promise((r) => setTimeout(r, 700))
  await capturer(menuWin, 'smoke-menu.png')

  // ④ 设置窗被直接叉掉后：应能按需重建并再次打开，且默认居中（不被大鲸鱼遮挡）
  try {
    menuWin.close()
    await new Promise((r) => setTimeout(r, 500))
    openMenu()
    await new Promise((r) => setTimeout(r, 600))
    const mb = menuWin && !menuWin.isDestroyed() ? menuWin.getBounds() : null
    const d = screen.getDisplayMatching(mb || petWin.getBounds())
    const cx = d.bounds.x + d.bounds.width / 2
    const cy = d.bounds.y + d.bounds.height / 2
    results.menuReopen = mb ? {
      recreated: true,
      visible: menuWin.isVisible(),
      // center() 包含系统标题栏高度（约 1 位数十 px），容忍 30px
      centered: Math.abs((mb.x + mb.width / 2) - cx) <= 8 && Math.abs((mb.y + mb.height / 2) - cy) <= 30,
      pos: { x: mb.x, y: mb.y },
    } : { recreated: false }
  } catch (err) {
    results.menuReopen = 'FAIL: ' + String((err && err.message) || err)
  }

  // ⑤ Linux 拖顶专项（受控真机验证）：直接在渲染进程派发带真实屏幕绝对坐标的
  // pointer 事件序列，验证主进程拖拽引擎能把窗口顶推到 topLimit
  // （= 显示器上界 − headRoom，即鲸鱼图形触到屏幕上缘）。
  try {
    const d5 = screen.getDisplayMatching(petWin.getBounds())
    const head5 = Math.round(petWin.getBounds().height * 0.4055)
    const topLimit5 = d5.bounds.y - head5
    const wb = petWin.webContents
    const bottomPos = {
      x: d5.bounds.x + d5.bounds.width - petWin.getBounds().width,
      y: d5.bounds.y + d5.bounds.height - petWin.getBounds().height,
    }
    petWin.setPosition(bottomPos.x, bottomPos.y)
    await new Promise((r) => setTimeout(r, 700))
    const js5 = `(async function(){
  var iw = window.innerWidth, ih = window.innerHeight
  var winX = window.screenX, winY = window.screenY
  var base = { winX: winX, winY: winY, iw: iw, ih: ih }
  var fire = function(type, sx, sy, cx, cy) {
    document.dispatchEvent(new PointerEvent(type, {
      clientX: cx, clientY: cy, screenX: sx, screenY: sy,
      button: 0, buttons: type === 'pointerup' ? 0 : 1,
      pointerId: 11, pointerType: 'mouse', isPrimary: true, bubbles: true, cancelable: true
    }))
  }
  var startSX = winX + Math.round(iw * 0.7), startSY = winY + Math.round(ih * 0.9)
  fire('pointerdown', startSX, startSY, iw * 0.7, ih * 0.9)
  var ys = []
  var sy = startSY
  while (sy >= 0) {
    sy = Math.max(sy - 60, 0)
    fire('pointermove', startSX, sy, iw * 0.7, sy - winY)
    ys.push(sy)
    await new Promise(function (r) { setTimeout(r, 40) })
  }
  fire('pointerup', startSX, 0, iw * 0.7, 0 - winY)
  await new Promise(function (r) { setTimeout(r, 700) })
  return { base: base, steps: ys.length }
})()`
    await withTimeout(wb.executeJavaScript(js5, true), 5000, null)
    await new Promise((r) => setTimeout(r, 400))
    const after5 = petWin.getPosition()
    results.drag.linuxTop = {
      start: bottomPos,
      after: { x: after5[0], y: after5[1] },
      topLimit: topLimit5,
      reachedTop: after5[1] <= topLimit5 + 4,
      note: after5[1] < d5.workArea.y ? '窗口顶已越过面板（负坐标生效，图形触顶）' : '窗口顶仍在面板下方（未触顶）',
    }
  } catch (err) {
    results.drag.linuxTop = 'FAIL: ' + String((err && err.message) || err)
  }

  const cfg = configMod.getEffective()
  results.configPath = configMod.CONFIG_FILE
  results.apiKeySource = cfg.apiKeySource || (cfg.apiKey ? 'config' : 'missing')
  results.balance = await withTimeout(balanceService.getSnapshot(cfg), 25000, { ok: false, error: 'balance timeout' })
  const summary = JSON.stringify(results, null, 2)
  // GUI 重定向下 stdout 不可靠：结果同时写盘，便于 CI / 真机验证
  try { fs.writeFileSync(path.join(outDir, 'smoke-results.json'), summary, 'utf8') } catch (err) {}
  console.log('[smoke] ' + summary)
  app.exit(0)
}
