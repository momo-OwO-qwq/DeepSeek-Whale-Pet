# DeepSeek 余额桌宠 —— 完整生成提示词

> 用途：在桌面右下角常驻一个「小鲸鱼余额挂件」。
> 本提示词汇总了完整需求、架构、全部行为规格、视觉参数与踩坑结论，可直接交给 AI 复现或维护。
> 文中 `/home/momo/projects/DSBWW/DeepSeek-Whale-Pet` 为本机示例路径，迁移时请替换为你环境中的实际路径。
> 当前版本：1.5.1（Electron 34 · electron-builder 25）

---

## 0. 项目一句话

一个 **Electron 桌面小鲸鱼桌宠**：透明置顶、无边框、可拖拽贴边的小鲸鱼常驻桌面上，定时拉取 DeepSeek 官方账户余额；点击弹出气泡显示余额与今日已用（记账 / 令牌峰谷双模式）；配独立设置窗口、托盘、全局热键、开机自启、随机台词、按压音效、闲置半透明。

## 1. 目标与验收

| # | 目标 | 验收标准 |
|---|------|----------|
| 1 | 独立运行 | `npm start` 即用；不依赖浏览器 / DSH / 任何凭证服务 |
| 2 | 透明置顶 | 鲸鱼无边框无阴影、始终置顶、可贴任意屏幕边缘 |
| 3 | 点击可靠 | 真实鼠标点击鲸鱼必然响应（气泡 / 刷新 / 拖拽）；非鲸鱼区域点击穿透到桌面 |
| 4 | 余额监控 | 60s 自动刷新 + 点击手动；余额数字滚动动画；接口瞬时失败沿用最近余额（带 stale 标记） |
| 5 | 今日已用 | 记账模式（免令牌）/ 令牌模式（平台用量接口 + 峰谷定价），与原版 DSH 插件 v0.2.8 语义一致 |
| 6 | 桌宠交互 | 自由拖拽（**必须能贴回屏幕任意边缘，无「空气墙」**）、按压 Q 弹、音效、随机台词、汉堡菜单 |
| 7 | 桌面动效 | 呼吸、闲置半透明（可调 0.2–1.0）、低余额提醒、预警换图 |
| 8 | 系统集成 | 托盘菜单、全局快捷键 Ctrl+Shift+R 刷新、开机自启、单实例、低余额系统通知（30 分钟节流） |
| 9 | 配置持久化 | `~/.config/whale-pet/config.json` + `usage.json` + `lines.json`；密钥文件权限 0600、目录 0700 |
| 10 | 多平台 | Linux（Wayland 强制走 XWayland）、Windows、macOS 均可运行 |

## 2. 技术栈与目录结构

- 语言：纯 JavaScript（主进程 / 渲染进程均无 TypeScript、无构建步骤）。
- Electron 主进程：`main.js`
- 预加载桥：`preload.js`（contextBridge 暴露 `window.whaleAPI`，`contextIsolation: true`、`nodeIntegration: false`）
- 鲸鱼窗口渲染：`renderer/pet.js` + `renderer/pet.css` + 入口 `renderer/pet.html`
- 设置窗口渲染：`renderer/menu.js` + `renderer/menu.css` + `renderer/menu.html`
- 逻辑库：`lib/config.js`（配置）、`lib/balance.js`（余额/用量/定价）、`lib/ledger.js`（记账）、`lib/lines.js`（台词池）
- 素材：`assets/`（DSniang1.png 主图、DSniang03.png 预警图、D1/D2/Ya1/Ya2 音效、rua.gif 动图）
- 测试：`test/unit.test.js`（纯 Node 单元测试，`npm test`）；冒烟测试 `npm run smoke`（主进程内 runSmoke）
- 打包：electron-builder（`npm run dist:win` / `dist:linux` / `dist:mac`）

## 3. 鲸鱼窗口规格

- `BrowserWindow`：尺寸 320×320（可缩放系数 0.6–2.5），`transparent: true`、`frame: false`、`backgroundColor '#00000000'`、`alwaysOnTop`（Windows 仅置顶；非 win32 走 `screen-saver` level + `setVisibleOnAllWorkspaces`）、`hasShadow: false`、`resizable: false`、`movable: false`、`skipTaskbar: true`、`acceptFirstMouse`（macOS）。
- 首帧前按 `cfg.scale` 计算尺寸、按 `cfg.posX/posY`（缺失则默认右下角 `wa.x+wa.width-w`、`wa.y+wa.height-h`）创建，避免 WM 丢弃启动时 setSize。
- **点击穿透**：不用 OS 级 `setIgnoreMouseEvents`（Linux/XWayland 不可靠、会丢点击），而是整窗接收事件 + 主进程 `win.setShape(rects)` 把窗口裁剪成「鲸鱼 + 气泡 + 菜单按钮」矩形，其余区域点击自然落到桌面。形状 = 渲染进程布局盒（offset*/width/height，padding 10px，镜像时水平翻转），每次换图/开关气泡/缩放后重新上报。
- **命中测试**：`isWhaleHit` 用 610×610 探针画布（`hitCanvas.getImageData` alpha > 10）；探针重载期间放宽为全命中，保证可点击。镜像（鲸鱼在屏幕左半 → 水平翻转）时坐标 `lx = 610 - lx` 反转。
- 气泡：SVG 云朵 + 文本三行（label/amount/hint）+ 动图；`BUBBLE_MS 5000` 自动关闭；点击鲸鱼弹气泡；`wm-bubble-interval` 为随机台词自动弹出间隔（0=关闭，默认 120s）。
- 闲置半透明：鼠标离开 3s 后加 `wp-idle` class（opacity 由 `cfg.idleOpacity` 控制，0.2–1.0），拖动/按钮悬浮时移除。
- 按压动画：`scaleY(0.88) scaleX(1.05)` 挤压，松手回弹；按压/松手音效（内置音效集或用户自定义 mp3/wav/ogg）。
- 低余额：`totalBalance < cfg.lowBalanceThreshold`（默认 5 元）→ 气泡换「余额预警」文案 + 颜色切换（默认 `#e0433f`），开启 `alertImage` 时切换预警图；主进程 30 分钟节流弹系统通知。

## 4. 拖拽引擎（**本项目最大雷区，规格严格**）

**坐标系统学前提（必须遵守，否则复现失败）：**
Electron 中这三者**全部是 DIP 坐标**，无需任何换算：
- 主进程 `screen.getCursorScreenPoint()` / `win.getBounds()` / `win.getPosition()`
- 渲染进程 PointerEvent 的 `clientX/clientY`（窗口内）与 `screenX/screenY`（屏幕绝对）
- **禁止** `× scaleFactor`/DPI 换算。旧代码把抓取锚点乘了 scaleFactor，导致 Windows 125–150% 缩放下「拖回屏幕边缘遇空气墙」——详见 §7 踩坑 #1。

**主进程拖拽协议（`drag:start` / `drag:delta` / `drag:end`）：**
1. `drag:start`：渲染进程 pointerdown 时上报 `{ offsetX, offsetY, screenX, screenY }`。主进程用**窗口真实边界**计算锚点：`anchor = screenX - win.x`（纯 DIP）。锚点只算一次，整个拖拽过程不变。
2. `drag:delta`（主通道）：渲染进程每次 pointermove 上报 `{ dx, dy, cx, cy, screenX, screenY }`。主进程若收到有效绝对坐标，则 `目标 = 光标绝对坐标 − anchor`，再钳制到**窗口所在显示器**（`screen.getDisplayMatching(bounds)`）的 `workArea`。绝对坐标由 OS 实时下发，**不依赖主进程光标缓存**。
3. `drag:delta`（备通道）：无绝对坐标时（旧渲染进程/冒烟测试）退化为增量 `win.x + dx`，带一致性守卫：`|cx − (lastClientX + dx − lastAppliedDx)| > 12` 则丢弃（拒绝窗口移动合成的回送事件）。
4. `drag:end`：清 timer，返回 `lastPos`；渲染进程 `finishDrag` 再按 `api.getDisplayBounds()`（完整显示器边界）二次钳制、`advancePos` 记录、`api.setWindowPos` 落位、`setConfig({posX,posY})` 持久化。
5. 主进程轮询通道（旧 `dragTick` 每秒 60 次轮 `getCursorScreenPoint`）**已移除**——Windows 下该 API 在拖拽中可能冻结，是「重启后恢复、过一会儿又卡死」的元凶。当前唯一移动来源是渲染进程的绝对坐标事件。

**钳制边界**：`workArea`（不含任务栏/ Dock），公式 `x = clamp(targetX, bd.x, bd.x + bd.width - win.width)`。

## 5. 配置模块（lib/config.js）

- 平台目录：Windows `%APPDATA%/whale-pet`、macOS `~/Library/Application Support/whale-pet`、其余 `~/.config/whale-pet`；`WHALE_PET_HOME` 可重定向（测试用）。
- `CONFIG_FILE = config.json`、`USAGE_FILE = usage.json`。
- 默认值：
  ```js
  {
    apiKey: '', platformToken: '', scale: 1.0, soundSet: 'duck',
    volume: 1.0, usageMode: 'ledger', peakMode: 'default',
    peakText: true, bubbleOn: true, bubbleInterval: 120,
    idleFade: true, idleOpacity: 0.6, refreshInterval: 60,
    lowBalanceThreshold: 5, alertImage: false,
    alertImgPath: 'assets/DSniang03.png', mainImgPath: 'assets/DSniang1.png',
    theme: 'system', bubbleTextOk: 'DeepSeek 余额', bubbleTextLow: '余额预警',
    textColorOk: '', textColorLow: '', peakTextOff: '', peakTextOn: '',
    pressSound: '', releaseSound: '', autostart: false,
    posX: null, posY: null, posH: 'right', posV: 'bottom'
  }
  ```
- 消毒规则（sanitize）：数值范围截断、枚举白名单（theme/usageMode/soundSet/peakMode）、颜色正则 `#rrggbb`、文案限长（气泡 20 字符、峰谷 12 字符）、布尔仅收 `boolean`、素材路径 `assets/*` 需存在否则置空。
- 环境变量覆盖（**优先级最高**）：`DEEPSEEK_API_KEY` → `apiKey`、`DEEPSEEK_PLATFORM_TOKEN` → `platformToken`；并输出 `apiKeySource`/`platformTokenSource`（'env'|'config'|''）供 UI 显示。
- `save(patch)`：读旧值 → 合并 → sanitize → mkdir 0700 → 写 tmp 0600 → rename 原子替换。

## 6. 余额与用量（lib/balance.js）

- **余额接口**：`GET https://api.deepseek.com/user/balance`，Header `Authorization: Bearer <apiKey>`，超时 20s。
- 响应解析：`data.balance_infos[]`，字段 `currency`、`total_balance`；选取优先级：`CNY 且 >0` → 任意非零 → CNY → 第一项。
- 重试：网络错误/超时/5xx 重试 1 次（间隔 500ms）；**4xx 不重试**（返回 `transient:false`；瞬时失败回退缓存最近余额并标 `stale`）。
- 缓存：25s 内存 TTL + in-flight 去重（并发拉取复用同一个 Promise）。
- **今日已用双模式**：
  - `ledger`（默认）：`lib/ledger.js` 记账——每次观测余额，用 `当前余额 - 上次余额`（仅下降方向）累计当日用量；跨天归档 history（保留 30 天）；充值后余额回升不扣减。文件 `usage.json`。
  - `token`：`GET https://platform.deepseek.com/api/v0/usage/by_api_key/amount?start&end&tz`，解析 `series[].buckets[].usage`（`PROMPT_CACHE_HIT_TOKEN` / `PROMPT_CACHE_MISS_TOKEN` / `RESPONSE_TOKEN`）按定价换算金额。
- **峰谷定价（DeepSeek CNY 每百万 token）**：
  - `PEAK_HOURS = [[9,12],[14,18]]`（北京时间 UTC+8）；周末全天按低谷不区分。
  - `BASE_PRICE = { hit:[0.05,0.1], miss:[1.5,3.0], out:[4.5,9.0] }`（[低谷, 高峰]）
  - `PRO_PRICE = { hit:[0.15,0.3], miss:[4.5,9.0], out:[13.5,27.0] }`（deepseek-v4-pro 为 flash 3 倍价）
  - 模型：`deepseek-v4-flash-vision-exp` / `deepseek-v4-flash` → BASE；`deepseek-v4-pro` → PRO；`deepseek-chat`/`deepseek-reasoner` → BASE；`_default` → BASE（`priceFor` 用 `indexOf` 子串匹配）。
- 返回值 `payload`：`{ ok, totalBalance, currency, updatedAt, isPeak, todayUsage, usageMode, provider?, stale?, error? }`。

## 7. 已踩坑结论（复现/维护必读）

1. **拖拽空气墙（issue #1）**：绝对不要 `offset × scaleFactor`。Electron 光标注标与窗口边界都是 DIP；放大锚点后，拖回边缘时窗口提前撞钳制，形成位置随抓取点变化的「隐形墙」（向中心能拖、向边角拖不动）。**已修复**：改用渲染进程绝对 screenX/Y 主通道 + 主进程算锚点；同步删除了轮询 `getCursorScreenPoint` 的旧通道（Windows 下该 API 拖拽中会冻结，导致重启后短暂恢复又复现）。
2. **硅基流动已取消**：本项目只支持 DeepSeek 官方。勿再加 SiliconFlow（`api.siliconflow.cn/v1/user/info` 等）——代码/文档均已清理（包括 docs/design.md 里的“硅基流动”字样），加回来属于回退。
3. **Wayland**：Linux 下若检测到 `WAYLAND_DISPLAY` 且无 `ELECTRON_OZONE_PLATFORM_HINT`，`app.commandLine.appendSwitch('ozone-platform','x11')` 强制 XWayland（否则 setPosition/拖拽不可用）。
4. **透明窗口点击**：不要用 `setIgnoreMouseEvents` 做穿透；用 `setShape` 裁剪点击区。改图/开气泡/缩放后必须重报 shape，否则区域残留导致点不到。
5. **单实例**：`app.requestSingleInstanceLock()`，二次启动只 `showInactive()`。
6. **余额失败体验**：瞬时失败回退 stale 缓存；未配置 Key 返回 `NO_KEY` 提示；坏 Key 返回 `HTTP 401`。

## 8. 设置窗口（renderer/menu.*）

- 原生窗口 520×700，6 个 Tab：账户 / 数据 / 外观 / 文案 / 音效 / 图片。
- 账户：API Key（密码框 + 显示/隐藏、环境变量来源时禁用并提示）、平台令牌、立即刷新、打开配置文件。
- 数据：用量模式（记账/令牌）、自动刷新秒数、低余额阈值（元）、开机自启、打开 usage.json。
- 外观：主题（system/light/dark，仅设置窗口配色 + matchMedia 联动）、鲸鱼大小滑块（0.6–2.5）、气泡/闲置半透明开关、闲置不透明度滑块、峰谷文案风格（默认/梁文峰谷/!?强强?!）、空闲/高峰自定义文案（限 12 字符）。
- 文案：余额充足/预警首行文字（限 20 字符）+ 颜色 + 恢复默认；台词间隔（秒，0=关闭）；台词池「重新载入 / 打开文件」。
- 音效：音效方案、音量滑块、按压/松手自定义音效上传 + 恢复默认、打开 sounds 目录。
- 图片：预警换图开关、主图/预警图上传 + 恢复默认、打开 images 目录。
- 所有控件 change → `api.setConfig(patch)`；输入框聚焦期间跳过 `config:changed` 回填（防打断输入）。

## 9. IPC 桥（preload.js 暴露 window.whaleAPI）

`getConfig` / `setConfig(patch)` / `getBalance` / `getWorkArea` / `getDisplayBounds` / `resizeWindow(w,h)` / `setWindowPos(x,y)` / `setShape(rects)` / `dragStart(ox,oy,sx,sy)` / `dragDelta(dx,dy,cx,cy,sx,sy)` / `dragEnd` / `pickImage(kind)` / `resetImage(kind)` / `pickSound(which)` / `resetSound(which)` / `getCustom` / `reloadCustom` / `openMenu` / `closeMenu` / `openPath` / `onConfigChanged` / `onCustomChanged` / `onRefresh`。

## 10. 台词池（lib/lines.js + lines.json）

- 首次启动写入 `~/.config/whale-pet/lines.json`（默认池）。格式：
  ```json
  { "gif": "", "groups": [
    { "weight": 1, "type": "balance" },
    { "weight": 1, "type": "gif" },
    { "weight": 1, "text": "…", "style": "B" },
    { "weight": 1, "text": "…", "style": "A", "wrap": true, "color": "#rrggbb" }
  ]}
  ```
- `style`：A=标签 / B=大字 / P=峰谷大字 / C=提示行；`text ≤ 40`；`type: balance`（动态余额+峰谷多行）、`type: gif`（动图组）；旧格式多条 lines 自动展开为等权独立组；`weight` 加权随机。

## 11. 测试与验证

- `npm test`（`node test/unit.test.js`，纯 Node）：峰谷边界、`priceFor` 匹配/默认、`pickBalanceInfo` 优先级、token 换算、`fetchBalance` 重试/4xx/超时瞬态、记账观察/充值不扣减/跨天归档、配置消毒/0600/环境变量覆盖、预警换图/路径/主题/20 字符截断。
- `npm run smoke`（`electron . --smoke-test`）：真实启动 → 截图 pet 窗口 → 注入点击验证气泡 → **合成 pointer 事件链验证拖拽**（movementX 单调性防抽搐、连续拖到 workArea 上边缘 reached=true）→ 无 Key 返回 NO_KEY、坏 Key 返回 HTTP 401 → 20s 兜底退出。
- 手测清单：拖拽**必须**能贴回四边（尤其缩放 125–150% 下从左下角拖到中心再拖回）；点击非鲸鱼区域穿透；重启后位置记忆；托盘/热键/自启。

## 12. 复现完成标准

- `npm start` 出现右下角小鲸鱼；点击弹余额气泡；60s 自动刷新。
- 拖拽在任意 DPI 缩放下可贴回屏幕任意边缘（无空气墙、无抽搐、无飞移）。
- `npm test` 与 `npm run smoke` 全绿。
- 设置窗口 6 个 Tab 均可改并持久化（重启后生效）。
- 包产物：`npm run dist:win` / `dist:linux` / `dist:mac` 可用 AppImage/NSIS/dmg 启动。

## 13. 迁移时需替换的路径

- `/home/momo/projects/DSBWW/DeepSeek-Whale-Pet` → 你的仓库根目录
- `~/.config/whale-pet/` → 你的平台配置目录（Windows `%APPDATA%/whale-pet`）
- `assets/DSniang*.png`、`rua.gif`、`Ya*.mp3`/`D*.mp3` → 你的素材文件名（保持 `assets/` 相对路径，因为配置默认值引用它）
- `DEEPSEEK_API_KEY` / `DEEPSEEK_PLATFORM_TOKEN` 环境变量名 → 如你所用，可保持原名