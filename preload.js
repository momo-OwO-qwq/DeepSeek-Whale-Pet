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
  // 拖拽：主进程轮询光标移动窗口，dragEnd 返回最终窗口位置
  dragStart: (offsetX, offsetY) => ipcRenderer.invoke('drag:start', { offsetX, offsetY }),
  dragEnd: () => ipcRenderer.invoke('drag:end'),
  // 透明像素点击穿透：主进程 setIgnoreMouseEvents
  setHoverHit: (hit) => ipcRenderer.send('pet:hover', { hit }),
  // 设置窗口
  openMenu: () => ipcRenderer.send('menu:open'),
  closeMenu: () => ipcRenderer.send('menu:close'),
  // 事件
  onConfigChanged: (cb) => ipcRenderer.on('config:changed', (_e, cfg) => cb(cfg)),
  onRefresh: (cb) => ipcRenderer.on('whale:refresh', () => cb()),
})
