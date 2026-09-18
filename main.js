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
const bubbleMod = require('./lib/bubble')
const audioMod = require('./lib/audio')
const storeMod = require('./lib/store')

const IS_SMOKE = process.argv.includes('--smoke-test')
const BASE_PX = 320
// 设置窗口尺寸：v0.3.5 新增「泡泡」Tab（逐模块编辑，控件密集）后 520 偏窄，
// 模块行会被迫折成很多行。加宽到 600 让一行能放下「文本 + 字号 + B/I/U + 颜色 + 渐变」。
const MENU_W = 600
const MENU_H = 720
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
let pendingBlurShow = false // 补全拖拽期间被挂起的"失焦补显示"（drag:end 时兑现）

let dragTimer = null

// 主通道（光标轮询）优先的平台：Windows/macOS 上 getCursorScreenPoint 实时可靠。
// Linux（X11/XWayland）实测拖拽中冻结，改由渲染进程绝对坐标单权威驱动（1.5.2 语义）
const CURSOR_FIRST = process.platform !== 'linux'

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
  // 启动即升级配置文件结构：补齐新版新增字段，**完整保留用户已有数据**
  // （API Key、窗口位置、自定义文案/音效/形象路径等）。失败不影响启动 ——
  // readFile() 仍会在内存里补默认值，只是磁盘文件保持旧结构。
  try {
    const mig = configMod.migrate()
    if (mig && mig.changed) {
      const addedTxt = (mig.added && mig.added.length) ? '，补齐 ' + mig.added.length + ' 个新字段：' + mig.added.join(', ') : ''
      const bakTxt = mig.backedUp ? '（旧配置已备份为 config.json.bak-v' + (mig.fromVersion || 0) + '）' : ''
      console.log('[whale] 配置已升级到 v' + mig.version + addedTxt + bakTxt)
    }
    if (mig && mig.writeError) console.warn('[whale] 配置升级写盘失败（不影响使用）: ' + mig.writeError)
  } catch (err) {
    console.warn('[whale] 配置升级异常（忽略）: ' + String((err && err.message) || err))
  }
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
    // 记忆位置的钳制必须与拖拽钳制一致（左/上允许负 headRoom）：否则「贴到左缘/上缘 → 重启」时会被这里拉回面板内，表现为「贴边位置上没贴住」
    const headRoom = Math.round(initSize * 0.4055)
    if (typeof cfg.posX === 'number' && typeof cfg.posY === 'number') {
      initX = Math.max(wa.x - headRoom, Math.min(cfg.posX, wa.x + wa.width - initSize))
      initY = Math.max(wa.y - headRoom, Math.min(cfg.posY, wa.y + wa.height - initSize))
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
    // Muzyu备注：Windows11小鲸鱼无法贴右下角边缘且碰空气墙离边缘越来越远的bug的真正症结所在！
    // Windows：frameless 窗口默认带 WS_THICKFRAME（不可见调整边框）
    // 且实测会在每次拖拽后把「窗口框」撑大一圈（256→280→…→453）而内容区不变
    // getBounds() 于是与渲染进程的页面尺寸脱钩，钳制按错误尺寸计算，鲸鱼右/下边永远贴不到屏幕边。
    // 关掉它：窗口框 = 内容区（同时去掉不可见边框带来的阴影/动画副作用）。
    thickFrame: false,
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
    // Muzyu备注，修复新增bug：拖拽时组件抖动
    // 拖拽中不重演窗口：Windows 下对正在拖拽的窗口 ShowWindow 会打断鼠标捕获/
    // 触发重新合成（表现为拖拽抖动）。但不能直接丢弃这次失焦 —— 否则可能重新
    // 出现「失焦后鲸鱼被 DWM 剔除不再显示」的老问题，故挂起并在 drag:end 补显示
    if (dragState) { pendingBlurShow = true; return }
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

// 拖拽/定位几何：纯函数模块（可单测），见 lib/geometry.js
const geometry = require('./lib/geometry')

// 渲染进程上报的「可见鲸鱼在窗口内的矩形」（CSS px = DIP，已含镜像与 alpha 收缩）
// 拖拽钳制以它为准 → 哦鲸鲸本体四条边都能贴到屏幕边
//
// 归一化存储（修复「由大变小后空气墙」）：
// drag:start 只发生一次，而缩放大小时窗口会变 —— 若把 px 快照冻结在 dragState 里，
// 缩小后钳制仍按旧尺寸（640）算，右侧会多出「窗口差」那么宽的死区，拖不过去。
// 因此把 fish 存成**相对窗口尺寸的比例**，每次钳制时按当前窗口实时还原。
function fishRectNormOf(msg, b) {
  return geometry.fishNormOf(msg && msg.fish, b)
}

// 按当前窗口尺寸把归一化 fish 还原成 px（并夹在窗口内）
function fishRectFromNorm(norm, b) {
  return geometry.fishFromNorm(norm, b)
}

// 当前生效的 fish / geom：始终按**此刻**的窗口几何重算，不用 drag:start 的快照
function currentDragGeom() {
  const b = petWin.getBounds()
  let cb = petWin.getContentBounds()
  if (!cb || !(cb.width > 0) || !(cb.height > 0)) cb = b
  return {
    b,
    geom: { w: cb.width, h: cb.height, insetX: cb.x - b.x, insetY: cb.y - b.y },
    fish: fishRectFromNorm(dragState && dragState.fishNorm, b),
  }
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

  // ---------- 不做窗口裁剪（按用户要求移除 setShape）----------
  // 历史：曾用 win.setShape() 把窗口裁剪成「鲸鱼/气泡/按钮」区域，让其余透明处
  // 点击穿透。实际带来三个问题：
  //   1) 气泡会被一起裁掉（气泡展开时超出鲸鱼矩形就被切）；
  //   2) shape 只认 {x,y,width,height}，早期传 w/h 导致**每次**都静默失败，
  //      窗口仍是完整矩形 —— 「透明部分有遮挡」与「时好时坏」都源于此；
  //   3) 缩放后若 shape 未及时跟上，右下角那片不在裁剪区内 → 那里点不到、
  //      拖不动（表现为「调整大小后拖不到右下角，重启才好」）。
  // 现在保持窗口为完整矩形：透明区域不穿透（会挡住下方点击），但交互稳定、
  // 气泡完整、缩放后行为一致。渲染进程仍会上报 shape，这里直接忽略以保持
  // 协议兼容（未来若要恢复穿透可在此接回 setShape）。

  // 缩放窗口。关键：**等真实尺寸落地后再返回**。
  //
  // 历史坑：早期直接返回「请求的尺寸」，因为 Linux 透明置顶窗口缩小后 setSize 的
  // getBounds 会短暂返回旧值。但那样渲染进程会立刻把 state.winW/CSS 按新尺寸算，
  // 而真实窗口还是旧尺寸 —— 两者不同源，紧接着的钳制/命中测试就按一个不存在的
  // 尺寸计算，于是出现「由大变小时右侧/底部拖不过去」的空气墙。
  //
  // 现在改为轮询等待真正生效（最多 ~120ms，通常 1 帧内就完成），拿到真实值返回；
  // 超时则回退到请求值（并在结果里标记 settled:false 供诊断）。
  const waitForSize = (win, w, h) => new Promise((resolve) => {
    const deadline = Date.now() + 120
    const tick = () => {
      if (!win || win.isDestroyed()) return resolve({ applied: false })
      let cb = null
      try { cb = win.getContentBounds() } catch (err) { cb = null }
      const cw = cb && cb.width > 0 ? cb.width : 0
      const ch = cb && cb.height > 0 ? cb.height : 0
      if (cw === w && ch === h) return resolve({ applied: true })
      if (Date.now() >= deadline) return resolve({ applied: false })
      setTimeout(tick, 12)
    }
    setTimeout(tick, 0)
  })

  ipcMain.handle('window:resize', async (e, msg) => {
    if (!petWin || petWin.isDestroyed()) return { x: 0, y: 0, width: 0, height: 0, settled: false }
    const w = Math.max(80, Math.round(Number(msg && msg.w) || BASE_PX))
    const h = Math.max(80, Math.round(Number(msg && msg.h) || BASE_PX))
    petWin.setSize(w, h)
    pinPetWindow(petWin)
    const { applied } = await waitForSize(petWin, w, h)
    const b = petWin.getBounds()
    let cb = null
    try { cb = petWin.getContentBounds() } catch (err) { cb = null }
    // 真实内容区尺寸（钳制与 CSS 都以它为准）；未生效时退回请求值
    const realW = applied && cb && cb.width > 0 ? cb.width : w
    const realH = applied && cb && cb.height > 0 ? cb.height : h
    return { x: b.x, y: b.y, width: realW, height: realH, settled: applied }
  })

  ipcMain.handle('window:set-pos', (e, msg) => {
    if (!petWin || petWin.isDestroyed()) return { x: 0, y: 0, width: 0, height: 0 }
    const x = Math.round(Number(msg && msg.x) || 0)
    const y = Math.round(Number(msg && msg.y) || 0)
    petWin.setPosition(x, y)
    return petWin.getBounds()
  })

  // ---------- 拖拽（主进程单权威引擎，见文件头注释）----------
  // 哦鲸鲸备注：
  // 一段拖拽只由一个通道驱动（owner 在 drag:start 一次性定好，整段不可逆）：
  //   · Windows/macOS → 'cursor'：主进程光标轮询，锚点也由主进程自算
  //     （同为 DIP，主进程内相减 = 1:1 跟手，绝不与渲染进程的 CSS 像素坐标混算）
  //   · Linux/XWayland → 'renderer'：渲染进程 screenX/Y 绝对锚点（实测光标轮询冻结）
  // 目标位置统一为「驱动源绝对坐标 − 抓取锚点」再钳制：纯增量在贴边时必然差
  // 最后一段（光标无法越界），是「贴不住边」的根因之一
  ipcMain.handle('drag:start', (e, msg) => {
    if (!petWin || petWin.isDestroyed()) return { ok: false }
    const b = petWin.getBounds()
    // 主进程自有的光标位置：与 getBounds/setPosition 同为 DIP（Electron 文档明确getCursorScreenPoint 返回 DIP 而非物理像素）因此两值相减无需比例换算
    const cursor0 = screen.getCursorScreenPoint() // 主进程自有 DIP 光标（与窗口位置同空间）
    // 几何基准：渲染进程的页面坐标基于「内容区」，而 setPosition 作用于「窗口框」
    // 两者在 Windows 上可能不等（不可见边框，见 thickFrame 注释），钳制必须按内容区
    // 尺寸 + 内容区相对窗口框的偏移计算，否则组件（按页面内位置绘制）贴不到右/下边
    let cb = petWin.getContentBounds()
    if (!cb || !(cb.width > 0) || !(cb.height > 0)) cb = b // 异常/不支持 → 视为窗口框=内容区
    const geom = { w: cb.width, h: cb.height, insetX: cb.x - b.x, insetY: cb.y - b.y }
    const sx = Number(msg && msg.screenX)
    const sy = Number(msg && msg.screenY)
    // XWayland 下渲染进程 screenX/Y 可能全为 0（OS 不下发绝对坐标）→ 回退增量分支
    // 注意用「至少一个非零」：单轴为 0 是真实边界坐标（光标贴屏幕左缘 x=0），
    // 用「两个都非零」判定会把贴左/贴顶时的最后一次事件误判为不可用。
    const hasAbs = isFinite(sx) && isFinite(sy) && (sx !== 0 || sy !== 0)
    dragState = {
      // 单一权威：drag:start 一次性定好，整段拖拽不可逆（禁止双通道交替出价）
      owner: CURSOR_FIRST ? 'cursor' : 'renderer',
      // 渲染进程绝对坐标空间的抓取偏移（owner='renderer' 时使用）
      anchorX: hasAbs ? sx - b.x : (Number(msg && msg.offsetX) || 0),
      anchorY: hasAbs ? sy - b.y : (Number(msg && msg.offsetY) || 0),
      hasAbs,
      // 可见图形矩形：存**归一化比例**（不是 px 快照），钳制时按当前窗口尺寸还原。
      // 这样拖拽途中若发生缩放/窗口尺寸变化，钳制跟着变，不会留下空气墙。
      fishNorm: fishRectNormOf(msg, b),
      // 主进程光标空间的抓取偏移（owner='cursor' 时使用）：两个操作数同取自主进程，
      // 同空间相减 → 窗口跟手 1:1，且四边钳制（同为 DIP）必然可达
      cursorAnchorX: cursor0.x - b.x,
      cursorAnchorY: cursor0.y - b.y,
      // 内容区几何（页面坐标 ↔ 窗口框坐标的换算），见上方 cb/geom 注释
      geom,
      lastCursor: cursor0, // 主通道轮询起点
      // 上次光标通道真正驱动窗口的时间（交棒判据）。初值取当前时间 = 「刚起步，先视为存活」
      // 否则拖拽开始后的第一个 delta 就满足「250ms 无反馈」，
      // 会在光标通道还没来得及跑第一拍时被误判为卡死而立刻交棒
      lastCursorMoveAt: Date.now(),
      lastAbsX: sx, // 渲染进程绝对坐标快照（交棒判据：它在变 = 指针确实在动）
      lastAbsY: sy,
      lastClientX: Number(msg && msg.offsetX) || 0,
      lastClientY: Number(msg && msg.offsetY) || 0,
      lastAppliedDx: 0,
      lastAppliedDy: 0,
      lastPos: null,
      // 诊断计数（drag:end 汇总，一眼看出是哪条通道在驱动）
    }
    if (dragTimer) { clearInterval(dragTimer); dragTimer = null }
    // 只有 Windows/macOS 启动光标轮询（见 CURSOR_FIRST 注释）；Linux 由渲染进程
    // 绝对坐标单权威驱动，不启动轮询 = 不可能出现两通道抢驱动。
    if (CURSOR_FIRST) dragTimer = setInterval(dragTick, 16)
    return { ok: true }
  })

  // 通道 A（owner='cursor'）：窗口位移 = 光标位移，全部在主进程 DIP 空间内完成。
  // 钳制：左/上放款到「显示器完整边界 − headRoom」，底部按 workArea（不藏任务栏）
  // 哦鲸鲸图形位于窗口右下（上/左留 40.55% 空白），只有允许窗口把空白推出屏幕，
  // 哦鲸鲸本体才能触到屏幕上缘/左缘 —— 光标贴屏边（x/y=0）时目标可为负，
  // 钳制放款后图形正好贴边；若钳在 workArea 则永远差 headRoom，即「贴不了边」
  function dragTick() {
    if (!dragState || !petWin || petWin.isDestroyed()) return
    if (dragState.owner !== 'cursor') return // 已交棒给渲染进程 → 主通道永久让位
    const b = petWin.getBounds()
    const cursor = screen.getCursorScreenPoint()
    if (!dragState.lastCursor || (cursor.x === dragState.lastCursor.x && cursor.y === dragState.lastCursor.y)) return
    dragState.lastCursor = cursor
    if (IS_SMOKE) return // 冒烟测试无真实光标运动（合成事件走渲染进程通道）
    dragState.lastCursorMoveAt = Date.now() // 光标通道活着：交棒判据据此否决
    const d = screen.getDisplayMatching(b)
    // 钳制以「可见图形矩形」为准：左/上允许把图片留白推出屏幕（哦鲸鲸本体贴边），
    // 右/下 = 图形右/下边缘贴到屏幕右/下边（底部留出任务栏）。
    // 注意：f/g 取**当前**窗口几何（不是 drag:start 的快照），否则拖拽途中缩放过
    // 窗口尺寸后仍按旧尺寸钳制，会在右/下留下「空气墙」。
    const live = currentDragGeom()
    const f = live.fish
    const g = live.geom // 内容区尺寸 + 相对窗口框的偏移（钳制必须按内容区几何算）
    const pos = geometry.clampWindow(cursor.x - dragState.cursorAnchorX, cursor.y - dragState.cursorAnchorY, f, g, d.bounds, d.workArea)
    const nx = pos.x
    const ny = pos.y
    if (nx !== b.x || ny !== b.y) petWin.setPosition(nx, ny)
    dragState.lastPos = { x: nx, y: ny }
    dragState.lastAppliedDx = nx - b.x
    dragState.lastAppliedDy = ny - b.y
  }

  ipcMain.on('drag:delta', (e, msg) => {
    if (!dragState || !petWin || petWin.isDestroyed()) return
    // 让位判据不再按时间（旧实现：150ms 内光标动过就整段忽略渲染进程事件），
    // 而是看 owner —— 见下方通道 A 分支的「单向交棒」。
    const b = petWin.getBounds()
    const d = screen.getDisplayMatching(b)
    const bd = d.bounds // 左/上钳制用显示器完整边界（配合 headRoom 推出屏幕）
    const wa = d.workArea // 底部仍按 workArea 防止被任务栏/面板遮挡
    // 哦鲸鲸图形锚定在窗口右下、上/左留空 40.55%（CSS: .wp-img 59.45%/bottom）。
    // 允许窗口上/左移出屏幕至多 40.55% 窗口高，让哦鲸鲸本体能触到屏幕上缘/左缘。
    // 钳制以「可见图形矩形」为准（含镜像与透明留白），使哦鲸鲸本体四条边都能贴到
    // 屏幕边；缺失时回退到 40.55% 留白估算。
    // f/g 取当前窗口几何（不是 drag:start 快照）—— 避免拖拽途中缩放后留下空气墙。
    const live = currentDragGeom()
    const f = live.fish
    const g = live.geom // 内容区几何（同上：哦鲸鲸按页面坐标绘制，钳制按页面几何算）
    const clampX = (v) => geometry.clampWindow(v, 0, f, g, bd, wa).x
    const clampY = (v) => geometry.clampWindow(0, v, f, g, bd, wa).y
    const sx = Number(msg && msg.screenX)
    const sy = Number(msg && msg.screenY)
    const absUsable = isFinite(sx) && isFinite(sy) && (sx !== 0 || sy !== 0)

    // 通道 A 已认领（Windows/macOS）：渲染进程事件不参与驱动 —— 两个坐标系
    // （渲染进程 CSS 像素 / 主进程 DIP）轮流出价正是拖拽抖动的根因。
    if (dragState.owner === 'cursor') {
      // 交棒判据（单向，只发生一次）：主通道 >250ms 无任何光标反馈，而渲染进程
      // 绝对坐标仍在变化 —— 后者证明确有指针移动（不是用户原地按住），即
      // getCursorScreenPoint 卡死。交棒时以当前窗口边界重算锚点（不跳位）。
      const absMoving = sx !== dragState.lastAbsX || sy !== dragState.lastAbsY
      dragState.lastAbsX = sx
      dragState.lastAbsY = sy
      const cursorStalled = !dragState.lastCursorMoveAt || Date.now() - dragState.lastCursorMoveAt > 250
      if (!(absUsable && absMoving && cursorStalled)) {
        return
      }
      dragState.anchorX = sx - b.x
      dragState.anchorY = sy - b.y
      dragState.hasAbs = true
      dragState.owner = 'renderer'
      if (dragTimer) { clearInterval(dragTimer); dragTimer = null }
    }

    // 通道 B：渲染进程 screenX/screenY 绝对锚点（Linux/XWayland 唯一可靠源）。
    // 光标贴物理屏顶（sy=0）时 ny=0−anchorY 可为负，窗口把头部空白推出屏幕、
    // 哦鲸鲸图形触顶 —— 纯增量做不到（光标无法为负）。
    if (absUsable) {
      if (!dragState.hasAbs) {
        // 这次才拿到可靠绝对坐标：以当前窗口边界重算锚点
        dragState.anchorX = sx - b.x
        dragState.anchorY = sy - b.y
        dragState.hasAbs = true
      }
      const nx = clampX(sx - dragState.anchorX)
      const ny = clampY(sy - dragState.anchorY)
      if (nx !== b.x || ny !== b.y) petWin.setPosition(nx, ny)
      // 同步 client 基准：绝对通道也可能中途失去绝对坐标而切到增量分支，
      // 那时守卫的基准必须是最近一次事件的值，否则会整段误杀。
      dragState.lastClientX = Number(msg && msg.cx) || 0
      dragState.lastClientY = Number(msg && msg.cy) || 0
      dragState.lastPos = { x: nx, y: ny }
      dragState.lastAppliedDx = nx - b.x
      dragState.lastAppliedDy = ny - b.y
      return
    }
    // 增量备分支：仅供无法取得绝对坐标的渲染进程（老版本/极端环境）。
    // 一致性守卫（1.5.2 曾删除）：窗口移动后 OS 会把新的 client 坐标回送渲染进程，
    // 其 movement 是窗口位移合成的假位移，直接采用会让窗口追着自己跑（抽搐/飞移）。
    // 判据 Δclient ≈ movement − Δwindow，超容差即整条丢弃（逐条独立，不污染其他）。
    const dx = Number(msg && msg.dx) || 0
    const dy = Number(msg && msg.dy) || 0
    if (dx === 0 && dy === 0) return
    const cx = Number(msg && msg.cx) || 0
    const cy = Number(msg && msg.cy) || 0
    if (Math.abs(cx - (dragState.lastClientX + dx - dragState.lastAppliedDx)) > 12 ||
        Math.abs(cy - (dragState.lastClientY + dy - dragState.lastAppliedDy)) > 12) return
    dragState.lastClientX = cx
    dragState.lastClientY = cy
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
    // 兑现拖拽期间挂起的失焦补显示（见 petWin.on('blur')）
    if (pendingBlurShow) {
      pendingBlurShow = false
      if (petWin && !petWin.isDestroyed()) {
        try { petWin.showInactive() } catch (err) { /* ignore */ }
      }
    }
    return pos || { x: 0, y: 0 }
  })

  // ---------- 形象图上传：主形象 / 预警表情 / 播报表情（复制到配置目录，与源文件解耦）----------
  // 三类形象各自的「恢复默认」内置素材（随包 610×610 透明 cut-out）
  function imagePatchFor(kind) {
    if (kind === 'alert') return { alertImgPath: 'assets/DSniang-sad.png' }
    if (kind === 'drop') return { dropImgPath: 'assets/DSniang-happy.png' }
    return { mainImgPath: 'assets/DSniang1.png' }
  }

  ipcMain.handle('image:pick', async (e, msg) => {
    const kind = msg && msg.kind === 'alert' ? 'alert' : (msg && msg.kind === 'drop' ? 'drop' : 'main')
    try {
      const res = await dialog.showOpenDialog(menuWin && !menuWin.isDestroyed() ? menuWin : undefined, {
        title: kind === 'alert' ? '选择预警图片' : (kind === 'drop' ? '选择余额减少播报图片' : '选择主图'),
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
        properties: ['openFile'],
      })
      if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, canceled: true }
      const src = res.filePaths[0]
      const imagesDir = path.join(configMod.CONFIG_DIR, 'images')
      fs.mkdirSync(imagesDir, { recursive: true, mode: 0o700 })
      const ext = (path.extname(src) || '.png').toLowerCase()
      const dest = path.join(imagesDir, kind + ext)
      fs.copyFileSync(src, dest)
      const patch = kind === 'alert' ? { alertImgPath: dest }
        : (kind === 'drop' ? { dropImgPath: dest } : { mainImgPath: dest })
      configMod.save(patch)
      broadcast('config:changed', configMod.getEffective())
      return { ok: true, path: dest }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) }
    }
  })

  ipcMain.handle('image:reset', (e, msg) => {
    const kind = msg && msg.kind === 'alert' ? 'alert' : (msg && msg.kind === 'drop' ? 'drop' : 'main')
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

  // ---------- v0.3.5 新功能 IPC ----------
  // 自定义泡泡配置：GET 返回消毒后的配置 + 渲染层需要的常量（避免两边硬编码漂移）
  ipcMain.handle('bubble:get', () => {
    return {
      ok: true,
      config: storeMod.readBubble(),
      limits: { modMax: bubbleMod.MOD_MAX, rowMax: bubbleMod.ROW_MAX, imgMax: bubbleMod.IMG_MAX },
      gradients: bubbleMod.GRADIENT_KEYS,
      placeholders: bubbleMod.PLACEHOLDERS,
    }
  })

  ipcMain.handle('bubble:set', (e, cfg) => {
    const saved = storeMod.writeBubble(cfg)
    if (!saved) return { ok: false, error: 'write failed' }
    // tapAdvance 镜像进 config，便于渲染层在 config:changed 时立即拿到
    configMod.save({ bubbleTapAdvance: saved.tapAdvance })
    broadcast('bubble:changed', { ok: true, config: saved })
    return { ok: true, config: saved }
  })

  // 音效库：片段 + 自定义音效组 + 任务结束音
  ipcMain.handle('audio:get', () => storeMod.audioPayload())

  ipcMain.handle('audio:upload-fragment', (e, msg) => {
    const m = msg && typeof msg === 'object' ? msg : {}
    const res = storeMod.uploadFragment(m.name, m.audio)
    if (!res.ok) return res
    res.fragments = storeMod.audioPayload().fragments
    return res
  })

  ipcMain.handle('audio:save-group', (e, msg) => storeMod.saveGroup(msg))
  ipcMain.handle('audio:delete-group', (e, msg) => storeMod.deleteGroup(String((msg && msg.id) || '')))
  ipcMain.handle('audio:delete-fragment', (e, msg) => storeMod.deleteFragment(String((msg && msg.id) || '')))
  ipcMain.handle('audio:pin-group', (e, msg) => storeMod.pinGroup(String((msg && msg.id) || ''), !!(msg && msg.pinned)))

  // 读取音频片段字节（渲染进程用 Web Audio 播放；不走 file:// 以便统一 MIME）
  ipcMain.handle('audio:read', (e, msg) => {
    const id = String((msg && msg.id) || '')
    const got = storeMod.loadFragment(id)
    if (!got) return { ok: false, error: 'audio fragment unavailable' }
    return { ok: true, mime: got.mime, base64: got.bytes.toString('base64') }
  })

  // 任务结束音设置（存在 config 里，与上游一致：默认关闭、默认选中内置经验球）
  ipcMain.handle('taskend:set', (e, patch) => {
    const cur = configMod.getEffective()
    const next = audioMod.sanitizeTaskEnd(Object.assign({}, cur.taskEnd, patch || {}))
    const saved = configMod.save({ taskEnd: next })
    if (!saved) return { ok: false, error: 'write failed' }
    broadcast('config:changed', saved)
    return { ok: true, taskEnd: saved.taskEnd }
  })

  // 角色库
  ipcMain.handle('role:list', () => storeMod.rolesPayload())
  ipcMain.handle('role:upload', (e, msg) => {
    const m = msg && typeof msg === 'object' ? msg : {}
    return storeMod.uploadRole(m.name, m.image, m.format)
  })
  ipcMain.handle('role:pin', (e, msg) => storeMod.pinRole(String((msg && msg.id) || ''), !!(msg && msg.pinned)))
  ipcMain.handle('role:delete', (e, msg) => storeMod.deleteRole(String((msg && msg.id) || '')))
  ipcMain.handle('role:read', (e, msg) => {
    const id = String((msg && msg.id) || 'default')
    const got = storeMod.loadRoleImage(id)
    if (!got) return { ok: false, error: 'role image unavailable' }
    return { ok: true, mime: got.mime, base64: got.bytes.toString('base64') }
  })

  // 泡泡图库
  ipcMain.handle('bimg:list', () => storeMod.bubbleImgsPayload())
  ipcMain.handle('bimg:upload', (e, msg) => {
    const m = msg && typeof msg === 'object' ? msg : {}
    return storeMod.uploadBubbleImg(m.name, m.image)
  })
  ipcMain.handle('bimg:delete', (e, msg) => storeMod.deleteBubbleImg(String((msg && msg.id) || '')))
  ipcMain.handle('bimg:read', (e, msg) => {
    const id = String((msg && msg.id) || '')
    const got = storeMod.loadBubbleImg(id)
    if (!got) return { ok: false, error: 'bubble image unavailable' }
    return { ok: true, mime: got.mime, base64: got.bytes.toString('base64') }
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
    const preSettle = basicTrace.slice(0, -1) // 最后一笔是松手定位后的位置，不计入轨迹
    results.drag.basic = {
      before,
      after: { x: c1[0], y: c1[1] },
      moved: Math.hypot(c1[0] - before[0], c1[1] - before[1]) > 20,
      noTwitch: monotonic(preSettle, 'x', before[0]) && monotonic(preSettle, 'y', before[1]),
      // 净位移 = 注入的 movement 总和（自由拖拽无吸附，落点即指针位移终点）
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
