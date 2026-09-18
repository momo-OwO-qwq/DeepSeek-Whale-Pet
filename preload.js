'use strict'
// ---------------------------------------------------------------------------
// 预加载脚本：contextBridge 暴露安全的 IPC 桥（window.whaleAPI）
// 渲染进程（鲸鱼窗口 + 设置窗口）无法直接访问 Node，只能走这里的方法。
// ---------------------------------------------------------------------------
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('whaleAPI', {
  // 配置
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  // 余额（主进程内缓存 + 去重）
  getBalance: () => ipcRenderer.invoke('balance:get'),
  // 窗口
  getWorkArea: () => ipcRenderer.invoke('window:get-workarea'),
  getDisplayBounds: () => ipcRenderer.invoke('window:get-display-bounds'),
  // 改为 invoke：主进程执行后返回真实窗口 bounds（{x,y,width,height}），
  // 渲染进程据此同步 state.winW/winH/posX/posY 再重报 shape —— 缩放后
  // 碰撞箱（点击区/拖拽锚点）与视觉尺寸保持一致（修复「缩小时右/下空气墙」）。
  resizeWindow: (w, h) => ipcRenderer.invoke('window:resize', { w, h }),
  setWindowPos: (x, y) => ipcRenderer.invoke('window:set-pos', { x, y }),
  // 透明点击穿透：把窗口裁剪为 鲸鱼/气泡/按钮 区域，其余部分点击直接落到桌面
  setShape: (rects) => ipcRenderer.send('pet:shape', { rects }),
  // 拖拽：渲染进程上报原始位移增量 + 实时绝对屏幕坐标（screenX/Y，OS 实时下发，
  // 不依赖主进程 getCursorScreenPoint 缓存）。主进程以绝对坐标为主通道移动窗口；
  // dragEnd 返回最终窗口位置（供吸附/保存）
  // Muzyu新增：fish：可见鲸鱼在窗口内的矩形（CSS px，含镜像），主进程据此钳制四边贴边
  dragStart: (offsetX, offsetY, screenX, screenY, fish) => ipcRenderer.invoke('drag:start', { offsetX, offsetY, screenX, screenY, fish }),
  dragDelta: (dx, dy, cx, cy, screenX, screenY) => ipcRenderer.send('drag:delta', { dx, dy, cx, cy, screenX, screenY }),
  dragEnd: () => ipcRenderer.invoke('drag:end'),
  // 形象图上传（主形象 / 预警表情 / 播报表情） + 恢复默认
  pickImage: (kind) => ipcRenderer.invoke('image:pick', { kind }),
  resetImage: (kind) => ipcRenderer.invoke('image:reset', { kind }),
  // 自定义音效（按压/松手）上传 + 恢复默认
  pickSound: (which) => ipcRenderer.invoke('sound:pick', { which }),
  resetSound: (which) => ipcRenderer.invoke('sound:reset', { which }),
  // 自定义随机台词/动图（~/.config/whale-pet/lines.json，含默认池）
  getCustom: () => ipcRenderer.invoke('custom:get'),
  reloadCustom: () => ipcRenderer.invoke('custom:reload'),
  // 设置窗口
  openMenu: () => ipcRenderer.send('menu:open'),
  closeMenu: () => ipcRenderer.send('menu:close'),
  // ---- v0.3.5 新功能：自定义泡泡 / 吸附翻转 / 音效库 / 角色库 / 泡泡图库 ----
  getBubble: () => ipcRenderer.invoke('bubble:get'),
  setBubble: (cfg) => ipcRenderer.invoke('bubble:set', cfg),
  getAudio: () => ipcRenderer.invoke('audio:get'),
  uploadFragment: (name, audio) => ipcRenderer.invoke('audio:upload-fragment', { name, audio }),
  saveAudioGroup: (group) => ipcRenderer.invoke('audio:save-group', group),
  deleteAudioGroup: (id) => ipcRenderer.invoke('audio:delete-group', { id }),
  deleteFragment: (id) => ipcRenderer.invoke('audio:delete-fragment', { id }),
  pinAudioGroup: (id, pinned) => ipcRenderer.invoke('audio:pin-group', { id, pinned }),
  readAudio: (id) => ipcRenderer.invoke('audio:read', { id }),
  setTaskEnd: (patch) => ipcRenderer.invoke('taskend:set', patch),
  listRoles: () => ipcRenderer.invoke('role:list'),
  uploadRole: (name, image, format) => ipcRenderer.invoke('role:upload', { name, image, format }),
  pinRole: (id, pinned) => ipcRenderer.invoke('role:pin', { id, pinned }),
  deleteRole: (id) => ipcRenderer.invoke('role:delete', { id }),
  readRole: (id) => ipcRenderer.invoke('role:read', { id }),
  listBubbleImgs: () => ipcRenderer.invoke('bimg:list'),
  uploadBubbleImg: (name, image) => ipcRenderer.invoke('bimg:upload', { name, image }),
  deleteBubbleImg: (id) => ipcRenderer.invoke('bimg:delete', { id }),
  readBubbleImg: (id) => ipcRenderer.invoke('bimg:read', { id }),
  // 用系统默认程序打开文件/目录/URL
  openPath: (path) => ipcRenderer.invoke('shell:open-path', { path }),
  // 事件
  onConfigChanged: (cb) => ipcRenderer.on('config:changed', (_e, cfg) => cb(cfg)),
  onCustomChanged: (cb) => ipcRenderer.on('custom:changed', (_e, data) => cb(data)),
  onBubbleChanged: (cb) => ipcRenderer.on('bubble:changed', (_e, data) => cb(data)),
  onRefresh: (cb) => ipcRenderer.on('whale:refresh', () => cb()),
})
