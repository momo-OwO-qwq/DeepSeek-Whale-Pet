'use strict'
// ============================================================================
// DeepSeek 余额小鲸鱼桌宠 —— Electron 主进程
// 职责：透明置顶窗口、独立设置窗口、托盘、全局热键、开机自启、单实例、
//       余额/用量拉取（lib/balance.js）、配置持久化（lib/config.js）、IPC 桥。
// ============================================================================
const path = require('path')
const fs = require('fs')
const os = require('os')
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, screen, Notification, nativeImage, dialog } = require('electron')

const configMod = require('./lib/config')
const balanceMod = require('./lib/balance')

const IS_SMOKE = process.argv.includes('--smoke-test')
const BASE_PX = 320
const MENU_W = 376
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
let lastLowNotifyAt = 0

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
  createPetWindow()
  createMenuWindow()
  setupTray()
  setupShortcuts()
  registerIpc()

  if (IS_SMOKE) await runSmoke()
}

// ================================ 鲸鱼窗口 =================================
function createPetWindow() {
  // 首帧前先定位到记忆位置（或默认右下角），避免在 (0,0) 闪一下
  let initX = 0
  let initY = 0
  try {
    const cfg = configMod.getEffective()
    const wa = screen.getPrimaryDisplay().workArea
    const w = Math.round(BASE_PX * (cfg.scale || 1))
    if (typeof cfg.posX === 'number' && typeof cfg.posY === 'number') {
      initX = Math.max(wa.x, Math.min(cfg.posX, wa.x + wa.width - w))
      initY = Math.max(wa.y, Math.min(cfg.posY, wa.y + wa.height - w))
    } else {
      initX = wa.x + wa.width - w
      initY = wa.y + wa.height - w
    }
  } catch (err) { /* 保持 0,0，由渲染进程接手 */ }

  petWin = new BrowserWindow({
    width: BASE_PX,
    height: BASE_PX,
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
  petWin.setAlwaysOnTop(true, 'screen-saver')
  petWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  petWin.loadFile(path.join(__dirname, 'renderer', 'pet.html'))
  petWin.once('ready-to-show', () => {
    if (!petWin) return
    petWin.showInactive()
  })
  petWin.on('closed', () => {
    petWin = null
    app.quit()
  })
}

// ================================ 设置窗口 =================================
function createMenuWindow() {
  menuWin = new BrowserWindow({
    width: MENU_W,
    height: MENU_H,
    transparent: true,
    frame: false,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })
  menuWin.setAlwaysOnTop(true, 'floating')
  menuWin.loadFile(path.join(__dirname, 'renderer', 'menu.html'))
  // 点击其他地方 → 自动收起（与常见悬浮菜单一致）
  menuWin.on('blur', () => {
    if (menuWin && menuWin.isVisible()) menuWin.hide()
  })
  menuWin.on('closed', () => { menuWin = null })
}

function openMenu() {
  if (!petWin || !menuWin || petWin.isDestroyed() || menuWin.isDestroyed()) return
  const pb = petWin.getBounds()
  const mb = menuWin.getBounds()
  const wa = screen.getDisplayMatching(pb).workArea
  let x = pb.x + pb.width - mb.width
  let y = pb.y - mb.height - 8
  if (y < wa.y) y = pb.y + pb.height + 8 // 上方放不下 → 放鲸鱼下方
  x = Math.max(wa.x, Math.min(x, wa.x + wa.width - mb.width))
  y = Math.max(wa.y, Math.min(y, wa.y + wa.height - mb.height))
  menuWin.setPosition(Math.round(x), Math.round(y))
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
      const file = path.join(dir, 'deepseek-balance-whale-pet.desktop')
      if (enabled) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
        const exec = app.isPackaged
          ? '"' + process.execPath + '"'
          : '"' + process.execPath + '" "' + app.getAppPath() + '"'
        fs.writeFileSync(file, [
          '[Desktop Entry]',
          'Type=Application',
          'Name=DeepSeek Balance Whale Pet',
          'Comment=DeepSeek 余额小鲸鱼桌宠',
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
        title: '小鲸鱼提醒 🐋',
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

async function getWorkAreaForPet() {
  const b = (petWin && !petWin.isDestroyed()) ? petWin.getBounds() : null
  const wa = b ? screen.getDisplayMatching(b).workArea : screen.getPrimaryDisplay().workArea
  return { x: wa.x, y: wa.y, width: wa.width, height: wa.height }
}

function registerIpc() {
  // ---------- 配置 ----------
  ipcMain.handle('config:get', () => configMod.getEffective())

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

  ipcMain.on('window:resize', (e, msg) => {
    if (!petWin || petWin.isDestroyed()) return
    const w = Math.max(80, Math.round(Number(msg && msg.w) || BASE_PX))
    const h = Math.max(80, Math.round(Number(msg && msg.h) || BASE_PX))
    petWin.setSize(w, h)
    // 部分 WM 在 setSize 后会掉置顶层，重新声明
    petWin.setAlwaysOnTop(true, 'screen-saver')
  })

  ipcMain.on('window:set-pos', (e, msg) => {
    if (!petWin || petWin.isDestroyed()) return
    const x = Math.round(Number(msg && msg.x) || 0)
    const y = Math.round(Number(msg && msg.y) || 0)
    if (process.env.WHALE_PET_TRACE === '1') console.log('[trace] set-pos', x, y, '->', JSON.stringify(petWin.getPosition()))
    petWin.setPosition(x, y)
  })

  // ---------- 主图 / 预警图上传（复制到配置目录，与源文件解耦）----------
  function imagePatchFor(kind) {
    return kind === 'alert' ? { alertImgPath: 'assets/DSniang02.png' } : { mainImgPath: 'assets/DSniang1.png' }
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

  // ---------- 自定义随机台词 / 动图（~/.config/whale-pet/custom.json）----------
  // 文件格式（README 有说明）：
  //   { "lines": [{ "text": "...", "style": "A|B|P|C", "color": "#rrggbb" }], "gif": "/abs/path.gif" }
  const CUSTOM_FILE = path.join(configMod.CONFIG_DIR, 'custom.json')

  function readCustomFile() {
    try {
      const raw = JSON.parse(fs.readFileSync(CUSTOM_FILE, 'utf8'))
      const lines = Array.isArray(raw.lines) ? raw.lines.slice(0, 20) : []
      const out = []
      for (const l of lines) {
        if (!l || typeof l.text !== 'string') continue
        out.push({
          text: l.text.slice(0, 40),
          style: ['A', 'B', 'P', 'C'].includes(String(l.style).toUpperCase()) ? String(l.style).toUpperCase() : 'A',
          color: typeof l.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(l.color.trim()) ? l.color.trim() : '',
        })
      }
      return { lines: out, gif: typeof raw.gif === 'string' ? raw.gif.trim() : '' }
    } catch (err) {
      return { lines: [], gif: '' }
    }
  }

  ipcMain.handle('custom:get', () => readCustomFile())

  ipcMain.handle('custom:reload', () => {
    const data = readCustomFile()
    broadcast('custom:changed', data)
    return data
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
}

// ================================ Smoke 测试 ===============================
// 说明：--smoke-test 用于自动化验证（CI / 开发机）。除基础状态外，还会：
//   1) capturePage 截图鲸鱼窗口与设置窗口（验证渲染）
//   2) sendInputEvent 模拟点击鲸鱼 → 验证点击刷新 + 气泡弹出链路
async function runSmoke() {
  const outDir = process.env.WHALE_PET_HOME || os.tmpdir()
  const results = { petCreated: !!petWin, menuCreated: !!menuWin, tray: !!tray }
  // 兜底：无论如何 20s 内退出，避免 CI/开发机挂死
  setTimeout(() => app.exit(0), 20000)
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
      // client 随累计指针位移递减（窗口尚未到位，指针相对窗口移动）
      await dispatchPtr(ptrMove(-12, -20, 260 - 12 * (i + 1), 260 - 20 * (i + 1)))
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
      // 净位移 = 注入的 movement 总和（x 吸附回右边缘时以贴边为准）
      exact: Math.abs(c1[1] - (before[1] - 160)) <= 2,
    }

    // ② 连续向上拖 → 验证能贴到上边缘（用户报告的重点）。
    // 注：窗口内单次拖拽移动有限，无法单次跨到左边缘四分之一区（会被右吸附拉回）；
    // 左/右/下边缘与上边缘共用同一套 clamp+snap 代码。
    for (let i = 0; i < 12; i++) {
      const p = petWin.getPosition()
      if (p[1] <= wa.y + 2) break
      await dispatchPtr(ptrDown)
      for (let j = 0; j < 6; j++) {
        await dispatchPtr(ptrMove(0, -200 / 6, 260, 260 - (200 / 6) * (j + 1)))
        await new Promise((r) => setTimeout(r, 20))
      }
      await dispatchPtr(ptrUp)
      await new Promise((r) => setTimeout(r, 100))
    }
    const c3 = petWin.getPosition()
    results.drag.topEdge = { after: { x: c3[0], y: c3[1] }, reached: Math.abs(c3[1] - wa.y) <= 2 }
  } catch (err) {
    results.drag = 'FAIL: ' + String((err && err.message) || err)
  }

  openMenu()
  await new Promise((r) => setTimeout(r, 700))
  await capturer(menuWin, 'smoke-menu.png')

  const cfg = configMod.getEffective()
  results.configPath = configMod.CONFIG_FILE
  results.apiKeySource = cfg.apiKeySource || (cfg.apiKey ? 'config' : 'missing')
  results.balance = await withTimeout(balanceService.getSnapshot(cfg), 25000, { ok: false, error: 'balance timeout' })
  console.log('[smoke] ' + JSON.stringify(results, null, 2))
  app.exit(0)
}
