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
  resizeWindow: (w, h) => ipcRenderer.send('window:resize', { w, h }),
  setWindowPos: (x, y) => ipcRenderer.send('window:set-pos', { x, y }),
  // 主图 / 预警图上传（复制到配置目录） + 恢复默认
  pickImage: (kind) => ipcRenderer.invoke('image:pick', { kind }),
  resetImage: (kind) => ipcRenderer.invoke('image:reset', { kind }),
  // 自定义音效（按压/松手）上传 + 恢复默认
  pickSound: (which) => ipcRenderer.invoke('sound:pick', { which }),
  resetSound: (which) => ipcRenderer.invoke('sound:reset', { which }),
  // 自定义随机台词/动图（~/.config/whale-pet/custom.json）
  getCustom: () => ipcRenderer.invoke('custom:get'),
  reloadCustom: () => ipcRenderer.invoke('custom:reload'),
  // 设置窗口
  openMenu: () => ipcRenderer.send('menu:open'),
  closeMenu: () => ipcRenderer.send('menu:close'),
  // 事件
  onConfigChanged: (cb) => ipcRenderer.on('config:changed', (_e, cfg) => cb(cfg)),
  onCustomChanged: (cb) => ipcRenderer.on('custom:changed', (_e, data) => cb(data)),
  onRefresh: (cb) => ipcRenderer.on('whale:refresh', () => cb()),
})
