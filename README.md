# 听澜 TINGLAN 4.1

轻量级、移动优先的多音轨声音合成与耳鸣辅助管理工具。支持奶油风响应式界面、四页导航及本地声音方案管理。

> 注意：本项目是声音丰富化及自我观察工具，不是经过临床验证的医疗器械，不用于诊断或治愈耳鸣。请从低音量开始试听，出现不适时停止使用。

## 功能

- **首页**：多轨声音合成、独立音轨调节、实时播放与频谱、WAV 导出。
- **预设**：内置声音组合，搜索、筛选和自定义方案。
- **记录**：保存实际播放记录、耳鸣困扰及入睡自评，显示趋势，导出 CSV。
- **我的**：本地配置与数据备份导入/导出。

## 开始使用

本项目不依赖后端，也不需要安装 npm 依赖。解压后通过本地静态服务器访问：

```bash
python3 -m http.server 8080
```

然后在浏览器打开 `http://localhost:8080`。也可直接把项目部署到 Vercel 静态站点。

## 技术说明

- 原生 HTML / CSS / JavaScript
- Web Audio API 实时合成与混音
- 播放状态机、确认出声计时，以及数字峰值保护
- 浏览器本地存储。设置保存在 localStorage，播放和自评记录保存在 IndexedDB
- 静态文件入口 `index.html`

音量滑杆是数字增益，不是声压级。峰值保护只限制数字信号，不能保证耳机的实际响度。

## 测试

不需要安装依赖。在项目目录运行：

```bash
node --test tests/core.test.mjs
```

测试覆盖噪声频谱斜率、循环接缝、陷波带宽、播放计时、导出削波判断、备份校验和 CSV 安全处理。

GitHub Actions 在每次推送到 `main` 以及每个 PR 上运行语法检查、单元测试和行宽棘轮检查，见 `.github/workflows/ci.yml`。行宽检查（`node scripts/check-style.mjs`）只阻止新增超长行，允许改动既有长行，也不要求一次性重排历史代码。

## 开发约定

- [代码规范.md](./代码规范.md)：模块边界、命名、单位量纲、音频专项规则、存量债务
- [Review检查清单.md](./Review检查清单.md)：提交门槛、按领域的检查项与验证命令、意见模板
- [design/设计方案.md](./design/设计方案.md)：界面设计方案 v5「夜航」，含可运行原型 [design/prototype.html](./design/prototype.html)、设计令牌、元素映射与分阶段落地建议

改动前请至少读完代码规范的第 0、7、9 节；提交 PR 时模板会自动带上硬门槛清单。涉及音频链路或数据模型的改动，需要在 PR 里说明影响面。

## Vercel 部署

在 Vercel 中导入这个 GitHub 仓库，选择 **Other** / 无框架，保留默认根目录并部署。项目为纯静态网页，通常无需设置环境变量或构建命令。

原有演示站点：https://tinglan-tinnitus-studio.vercel.app/

## 隐私与安全

自评数据和个人声音设置主要保存在当前浏览器。请定期手动导出备份；不要上传包含他人个人信息的备份文件。声音播放不是经声学校准的临床刺激，请控制设备音量。

## 文件结构

```text
index.html            页面结构
styles.css            响应式奶油风样式
core.js               可测试核心：噪声、滤波、时钟、导出与数据校验
app.js                播放、混音、预设、存储与界面编排
tests/core.test.mjs   核心逻辑自动化测试
scripts/check-style.mjs  行宽棘轮检查（CI 与本地共用）
.github/workflows/ci.yml CI：语法、测试、行宽
README.md             项目说明
.gitignore            Git 忽略规则
```

记录按条写入 IndexedDB（`logs`、`sessions` 两个对象仓库），不再整份覆盖；旧版 `kv` 存储会在启动时自动迁移。

## 持续部署

本项目使用 GitHub `main` 分支作为 Vercel 生产环境的代码来源。提交到 `main` 后，Vercel 会自动构建并发布静态站点；分支或拉取请求的预览部署由 Vercel 项目设置决定。

在线地址：https://tinglan-tinnitus-studio.vercel.app/

