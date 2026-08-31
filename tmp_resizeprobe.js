'use strict'
// 探测：真实透明置顶窗口（模拟 app 场景）setSize 缩小后 getBounds 是否立即变小
const { app, BrowserWindow } = require('electron')

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 480, height: 480, x: 800, y: 400, transparent: true, frame: false, alwaysOnTop: true, show: true, skipTaskbar: true })
  await new Promise((r) => setTimeout(r, 700))
  const b0 = win.getBounds()
  win.setSize(192, 192)
  await new Promise((r) => setTimeout(r, 100))
  const b1 = win.getBounds()
  await new Promise((r) => setTimeout(r, 500))
  const b2 = win.getBounds()
  await new Promise((r) => setTimeout(r, 900))
  const b3 = win.getBounds()
  console.log('BEFORE ' + JSON.stringify({ w: b0.width, h: b0.height }) +
    ' t=100ms ' + JSON.stringify({ w: b1.width, h: b1.height }) +
    ' t=600ms ' + JSON.stringify({ w: b2.width, h: b2.height }) +
    ' t=1500ms ' + JSON.stringify({ w: b3.width, h: b3.height }))
  app.exit(0)
})