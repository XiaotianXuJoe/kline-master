# K线之王

单标的 K 线盘感训练器。前端使用原生 HTML、CSS 和 JavaScript，后端使用 Node.js 原生 HTTP 服务，无第三方运行时依赖。

## 功能

- 日 K／周 K 模拟交易、T+1、仓位和交易成本规则
- 股票与 ETF 题库，当前包含 29 个数据文件、115 道题
- 每日一题、排行榜、个人战绩和演示／微信登录
- 可选的 Kimi AI 交易复盘；密钥只保存在服务端
- 静态文件白名单，不公开服务端源码、配置和用户数据

## 目录

```text
index.html             页面结构与样式
app.js                 前端交互和交易逻辑
server.js              HTTP 服务、API、登录与运行时数据持久化
build-manifest.js      重建题库清单
data/                  题库及生成的 manifest
Dockerfile             可选容器运行方式
docs/DEPLOY.md         生产部署与更新说明
AGENTS.md              Agent 维护约束
```

## 本地运行

要求 Node.js 20 或兼容版本，无需 `npm install`。

```bash
export PORT=3100
# 可选：仅 AI 复盘需要
export KIMI_API_KEY="你的密钥"
node server.js
```

打开 `http://127.0.0.1:3100`。没有 `KIMI_API_KEY` 时，非 AI 功能仍可运行。

如果新增或修改 `data/q*.js`，需要重建题库清单：

```bash
node build-manifest.js
node --check server.js
node --check app.js
```

## 配置与数据

参考 `.env.example` 和 `wx-config.example.json`。真实配置、用户、会话、排行榜和战绩只保存在运行环境，不进入 Git。

生产运维细节见 [docs/DEPLOY.md](docs/DEPLOY.md)。
