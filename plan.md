# K线之王 — 过夜长任务开发计划（2026-09-28）

## 数据源现状
- 线上题库：q1-q7.js = 28 只个股（真实数据, meta.real:true），q8-q11.js = 15 只 ETF，共 43 标的，每文件 3-4 题
- gen_data.py 为早期合成数据脚本，仅指标计算/校验函数可复用；真实数据需重新写抓取脚本

## 阶段划分

### Stage A — 数据扩充（并行，后台子代理）
- 任务6：用 akshare 抓取 72 只新个股日线（前复权），复用 gen_data.py 的指标/校验函数
- 输出 q12.js..q29.js（每文件4题）到 /mnt/agents/output/app/data/，meta.real:true
- 网络不通时降级方案：在用户服务器上执行

### Stage B — 服务端（server.js）
- 任务3后端：GET /api/daily（按日期哈希确定性选题，Asia/Shanghai 时区）；POST /api/score 增加 code/name/mode/dailyId 校验与存储；GET /api/leaderboard?board=total|daily&date=
- 新增 data/manifest.json（标的名录，供每日一题选题）
- 修 bug：个人战绩 bestRating 排序错误（字典序导致 A>S，应为 S>A>B>C>D）

### Stage C — 前端结构（index.html / app.js）
- 任务8：懒加载——manifest.js 列出全部数据文件，首屏随机预载 3-5 个文件（含每日一题标的优先），开始挑战即可玩；后台闲时加载剩余
- 任务1+3前端：独立排行榜全屏界面（总榜/每日一题双 Tab），行展示：排名/昵称/标的/收益/基准/超额/回撤/评级/日期
- 任务9：新手指引弹窗
- 任务2：BOLL 补中轨，上/中/下轨三色区分
- 任务4：挑战页迷你收益曲线加纵坐标刻度 + “收益曲线”文字标注
- 任务5：AI 分析界面重设计（分维度卡片式渲染）
- 任务7：横坐标 1 月显示年份（YYYY-01），其余 MM-DD

### Stage D — 集成测试 + 部署
- 本地端到端全量测试（含每日一题链路）
- 部署到 175.178.16.78:3100，浏览器自动化验证

### Stage E — 自查 + 文档
- 任务11：全应用自查清单逐项验证、修复发现的 bug
- 任务10：改进建议清单写入交付文档
- 输出 /mnt/agents/output/K线之王-开发文档.md（开发进度 + 自查结果 + 后续建议）
