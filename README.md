# DeepSeek Whale Pet · 余额小鲸鱼桌宠

![DeepSeek 余额小鲸鱼](assets/DSH2.png)

一只常驻桌面右下角的透明置顶小鲸鱼，实时提醒你的 **DeepSeek 余额与今日消耗**。拖得走、按得叫、会说随机台词；完全独立运行，不依赖 DSH / 浏览器。

## 功能

- 💰 余额监控：60s 自动刷新，点击鲸鱼手动刷新；余额变化有滚动动画
- 📊 今日已用：免令牌记账模式（默认，余额差值记账，跨天归档 30 天）或平台用量接口 + 峰谷定价实时换算
- 🖱️ 自由拖拽：无贴边吸附，可拖到屏幕任意边缘（含顶部）
- 💬 气泡交互：单击显示余额；点击气泡切换随机台词（可自定义池与权重）
- ⚙️ 系统集成：托盘、设置窗口（7 个 Tab）、全局热键 `Ctrl+Shift+R`、开机自启、单实例
- 🎵 按压音效、闲置半透明、预警换图、自定义主图/文案/颜色
- 😆 **余额减少播报表情**：余额下降时短暂切到「开心」表情，随后自动回落
- 😢 **预警表情**：余额低于阈值切到「委屈」表情并显示 `!` 徽标（优先级高于播报表情）

### v0.3.5 新功能（移植自上游）

- 🧩 **自定义泡泡**：点击序列（默认余额泡 / 随机台词泡 / 自定义模块泡）、
  模块化内容（文本 / 链接 / 随机语句 / 图片 / 随机图片 / 余额 / 今日已用 / 峰谷）、
  逐模块字号与字形、15 套跑马灯渐变、拖拽排序、A/B 并列加权随机
- 🎯 **点按角色推进队列**：开启后点一下＝往后翻一项，走到最后再点收起
- 🙈 **隐藏菜单按钮**：隐藏后桌面端**右键鲸鱼**、触屏**长按约 1.5 秒**唤出设置
- 🔔 **任务结束音**：默认关闭、默认选中内置「Minecraft·经验球」；
  可自定义音效组（两个槽位任一留空 = 该事件静音）
- 🐳 **自定义角色**与🖼️ **泡泡图库**：上传 PNG/GIF，随泡泡模块使用

> 详细设计与动画规范见 [`docs/design-v035.md`](docs/design-v035.md)。
> 下一阶段（多厂商 API 余额、Codex 本地统计、余额校正）的移植规格见
> [`docs/PORTING-SPEC-multivendor-and-accounting.md`](docs/PORTING-SPEC-multivendor-and-accounting.md)。

## 快速开始

```bash
npm install
npm start
```

启动后鲸鱼出现在屏幕右下角；右键鲸鱼 → 设置 → 填入 **API Key**（`sk-` 开头）即可显示余额。

## 使用

| 操作 | 效果 |
|---|---|
| 单击鲸鱼 | 弹气泡显示余额 + 今日已用；再点切换下一个泡泡（可自定义序列） |
| 按住拖动 | 移动鲸鱼，松手停在当前位置（自由摆放，可拖到任意边缘含顶部） |
| 右键鲸鱼 | 打开设置（隐藏菜单按钮后也可用；触屏长按约 1.5 秒） |
| `Ctrl+Shift+R` | 全局刷新 |

## 配置

- 配置文件：`~/.config/whale-pet/`（Windows `%APPDATA%/whale-pet`，macOS `~/Library/Application Support/whale-pet`）
- API Key 也可用环境变量 `DEEPSEEK_API_KEY` / `DEEPSEEK_PLATFORM_TOKEN` 提供
- 随机台词池：`lines.json`（首次自动生成，可自由编辑）

v0.3.5 新增的数据文件（都在同一配置目录内，权限 0600）：

| 路径 | 用途 |
|---|---|
| `bubble.json` | 自定义泡泡配置（点击序列 + 模块库 + 点按推进开关） |
| `audio/audio.json` + `audio/<id>.wav` | 自定义音效组与导入的音频片段 |
| `roles/roles.json` + `roles/<id>.<png\|gif>` | 自定义角色 |
| `bubble-imgs/bubble-imgs.json` + 同目录图片 | 泡泡图库 |
| `config.json` 的 `taskEnd` / `menuBtnHide` | 任务结束音 / 隐藏菜单按钮 |
| `config.json.bak-v*` | 升级时自动备份的旧配置（可删） |

> 升级到新版本首次启动时，会自动把新增配置项补进 `config.json`，
> **原有数据（API Key、窗口位置、自定义文案等）完整保留**，并先备份一份旧文件。

## 开发

```bash
npm test          # 单元测试（106 条：8 核心 + 69 v0.3.5 + 29 几何）
npm run smoke     # 冒烟测试（真实启动）
npm run dist:win  # 打包 Windows 安装包（可选安装路径）
npm run dist:linux # 打包 Linux（AppImage/deb/rpm）
```

## 参考

- 上游设计：[MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)
- 详细架构与行为规格见 [docs/design.md](docs/design.md) 与 [docs/repro-prompt.md](docs/repro-prompt.md)

## 许可证

MIT