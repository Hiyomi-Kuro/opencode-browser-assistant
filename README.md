# OpenCode Browser Assistant

在 Microsoft Edge 侧栏中与网页对话、执行浏览器任务，并跨网页开展研究。项目基于 Manifest V3、React 和 TypeScript，默认通过 OpenCode Go API 调用模型。

> 这是一个独立的社区项目，不是 OpenCode 官方产品。

## 功能

### 对话

- 支持多轮对话、流式回复和 Markdown 展示。
- 可按需附上当前网页内容，或附上网页中选中的文字。
- 内置总结、翻译和要点提取工具；可以添加、编辑、删除工具并自定义提示词。
- 支持对话历史、新建对话、复制回复和导出。

### 工作（Agent）

- 用自然语言描述目标，让 Agent 通过受限的浏览器工具导航网页、读取内容并执行任务。
- 长网页按段读取；任务可暂停、继续或停止，也可以查看历史记录。
- 扩展本身不设置固定的步数、运行时长或网页数量上限。实际运行仍受模型服务配额、浏览器资源和网站可访问性的影响。
- 密码、支付信息和验证码等敏感字段不会读取或填写。提交表单、下载文件及其他可能产生重要影响的操作需要用户确认。

### 研究（Research）

- 使用 Bing 或 Google 搜索并阅读多个网页，可在设置中选择搜索引擎和报告语言。
- 长页面可以分段读取；来源会去重，报告引用来自实际成功读取的页面。
- 扩展本身不设置固定的步数、运行时长或来源数量上限。遇到登录墙、付费墙或网站限制时，页面内容可能无法读取。
- 支持查看研究历史、复制报告和导出 Markdown。

工作与研究模式共享浏览器工具和任务控制，也提供历史记录与新建任务入口。

## 安装与运行

### 环境要求

- Microsoft Edge 116 或更高版本
- Node.js 20 或更高版本及 npm
- OpenCode Go API Key 和可用的 Go 订阅；也可以在设置中配置兼容的自定义 API 地址

### 在 Edge 中安装已构建版本

1. 从 GitHub Releases 下载扩展 ZIP 并解压；或者按下方步骤自行构建。
2. 在 Edge 地址栏打开 `edge://extensions`，启用“开发人员模式”。
3. 点击“加载解压缩的扩展”，选择解压后的 `dist` 文件夹。
4. 点击工具栏中的扩展图标打开侧栏。

### 配置 API

1. 打开侧栏设置，输入 API Key。
2. 保持默认 API 地址 `https://opencode.ai/inference/go/openai/v1`，或输入自己的 API 地址。
3. 测试连接并刷新模型列表，然后选择模型并保存。

模型 ID 按 Models API 返回值原样使用，不会自动添加 `opencode-go/` 前缀。连接测试检查模型列表接口；若要确认模型可以实际回复，请使用设置中的模型调用测试。

## 从源码构建

```powershell
npm ci
npm run typecheck
npm test
npm run build
```

构建产物：

- `dist/`：可在 Edge 中加载的解压缩扩展。
- `release/OpenCode-edge-extension.zip`：打包后的扩展 ZIP。

## 权限与数据

- 扩展声明了 HTTP 和 HTTPS 网站的主机访问权限，因此安装时可能会显示可访问所有网站的权限提示。聊天只会在你使用网页上下文或选中文字时读取相应内容；Agent 和 Research 会按任务需要访问网页。
- API Key、设置、聊天记录、任务记录和调用元数据保存在 Edge 的 `chrome.storage.local` 中。扩展不会把 API Key 放进模型请求正文；它会通过 Authorization 请求头发送到你配置的 API 地址。浏览器扩展本地存储不等同于硬件加密。
- 发送对话、网页上下文或启动 Agent/Research 时，相关提示词、网页内容和任务所需的浏览器工具结果会发送到配置的模型 API。Research 搜索时，搜索词会发送到所选的 Bing 或 Google。
- “导出数据”包含设置、聊天、任务和调用记录，不包含 API Key。你可以在设置中删除 API Key 或清除历史记录。
- 当前代码未集成第三方分析或遥测服务。
- 网页内容均视为不可信数据。浏览器操作通过固定工具集执行，不运行网页提供的 JavaScript 或模型生成的任意代码。

## 项目结构

```text
src/
├─ background/   # Service worker：API 请求、任务调度、权限与本地存储
├─ content/      # 当前网页内容提取与有限的 DOM 操作
├─ core/         # API 客户端、Agent 工具、安全校验和 Research
├─ shared/       # UI、后台和内容脚本共用的类型
└─ sidepanel/    # React 侧栏界面
tests/           # 使用模拟网络的自动化测试
```

