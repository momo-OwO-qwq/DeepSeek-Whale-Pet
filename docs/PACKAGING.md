# 打包发布（Linux 可安装脚本/包）

本页说明如何把 DeepSeek 余额小鲸鱼桌宠打成 Linux 可安装/可运行包（**AppImage** 与 **deb**），并用 **GitHub Actions** 自动构建发布。

## 一、本地打包（需要先 `npm install`）

```bash
# 构建 AppImage + deb（产物在 dist/）
npm run dist:linux

# 单独构建某一种
npm run dist:appimage    # AppImage：chmod +x 直接运行，无需安装
npm run dist:deb         # deb：Debian/Ubuntu 安装包
```

- 依赖：Node.js ≥ 18、Linux 桌面、内置素材（本项目自带 `assets/*.png` 与音效）。
- **架构**：在本机打包会得到本机架构（如 `aarch64`/arm64 或 `x86_64`）；GitHub Actions 的 `ubuntu-latest` 是 `x86_64`。
- **deb 构建说明**：electron-builder 用内置 fpm 生成 deb，需要在构建主机上有 `libcrypt.so.1`（标准 Ubuntu/Debian 一般都有；GitHub Actions 无此问题）。若本地缺失，可安装 `libcrypt1`，或只构建 AppImage。
- 若在国内网络较慢，可设置 Electron 下载镜像再打包：
  ```bash
  export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  npm run dist:linux
  ```

> 验证：本仓库在 aarch64 上已成功产出 AppImage（`dist/*.AppImage`）；本地 deb 因缺少 `libcrypt.so.1` 未生成（在 ubuntu-latest GitHub runner 上正常）。

### 安装/运行产物

- **AppImage**：`chmod +x "DeepSeek Balance Whale Pet-1.0.0.AppImage" && ./"DeepSeek Balance Whale Pet-1.0.0.AppImage"`（免安装，直接运行）。
- **deb**：`sudo dpkg -i "DeepSeek Balance Whale Pet-1.0.0.deb"`（或 `sudo apt install ./xxx.deb`），安装后在应用菜单搜索「DeepSeek」启动。

## 二、用 GitHub Actions 自动打包并发布

仓库已内置 `.github/workflows/build.yml`：推送 `v*` 标签或手动触发时，在 ubuntu-latest 上 `npm ci` + `npm run dist:linux`，产出 AppImage/deb 并上传为构建产物；若是标签推送还会**自动附加到 GitHub Release**。

### 步骤

1. **把项目推送到 GitHub**
   ```bash
   git remote add origin https://github.com/<你的用户名>/DeepSeek-Balance-Whale-Widget-Linux.git
   git push -u origin main
   ```
2. **在 GitHub 仓库设置里允许 Actions**：`Settings → Actions → General → Workflow permissions` 设为 `Read and write permissions`（写 Release 需要）。
3. **打标签触发构建**（或到仓库 Actions 页手动 Run workflow）：
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```
4. 在 `Actions` 页看到构建成功后，到 `Releases` 下载对应的 AppImage/deb 即可（也可在每次构建的 `Artifacts` 中取）。

> 提示：把 `DEEPSEEK_API_KEY` 放进 GitHub Secret 无必要——桌宠是本地应用，密钥在用户自己机器上的 `~/.config/whale-pet/config.json` 中配置；打包产物不含任何密钥。

## 三、多架构与更多格式

- `electron-builder` 的 `build.linux.target` 已配置 `AppImage` 与 `deb`；如需 `snap`/`rpm`/`tar.gz`，修改 `package.json` 的 `linux.target` 数组后重新构建。
- 跨架构（如 arm64）可用 `--arm64`：
  ```bash
  npx electron-builder --linux --arm64
  ```
  （GitHub Actions 如需，可在 `build.yml` 里加 `runs-on: ubuntu-latest` + `--arm64`，或用 `docker`/`qemu` 交叉打包。）

## 四、与本项目结构的对应

| 产物内容 | 来源 |
|---|---|
| 主程序 | `main.js` / `preload.js` / `lib/**` |
| 界面 | `renderer/**` |
| 素材与音效 | `assets/**`（鲸鱼图、mp3，打包内置） |
| 用户数据 | 运行时生成于 `~/.config/whale-pet/`（config.json、usage.json、lines.json、images/、sounds/）——**不入包** |

打包后首次打开：右键鲸鱼 → 设置 → 账户 → 填 API Key，即可显示余额；其余均为默认开箱即用。
