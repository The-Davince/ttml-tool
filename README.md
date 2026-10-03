# TTML Tool (基于 AMLL TTML Tool 原版构建)

基于 [amll-dev/amll-ttml-tool](https://github.com/amll-dev/amll-ttml-tool) 原项目源码直接构建的 100% 还原版本，并包含以下定制功能。

## 快速开始

```bash
python3 server.py
```

浏览器会自动打开 `http://127.0.0.1:26013`（端口被占用时可 `python3 server.py 8080` 换端口）。

仅需 Python 3.8+，无任何第三方依赖。

## 定制功能一览

### 基础定制

1. 右上角标题 "Apple Music-like Lyrics TTML Tool" → **"TTML Tool"**
2. 右上角新增 **登录按钮**（本地账号，会话保存在浏览器 localStorage，刷新不丢失；登录后可退出）
3. 文件菜单 "上传到 AMLL 歌词数据库" → **"上传到歌词数据库"**，且 **未登录时灰色不可点击**，登录后恢复可用

### 歌词编辑增强

4. **简化 ruby 格式兼容**：导入时自动为缺少 `textContainer` 包装层的简化格式假名补全结构（如 "恋" 直接挂 `tts:ruby="text"` 的写法），导入后即可显示/编辑假名；导出统一为 Apple TTML 规范格式
5. **预览界面翻译/音译位置交换**：预览（Play）模式功能区新增 "交换翻译与音译位置" 开关，即时生效并持久化保存
6. **TTML 格式异常修复**：导入解析失败时弹窗提示 "检测到 TTML 格式异常，是否尝试修复"，可一键修复常见问题（BOM/控制字符、HTML 实体、时间戳格式、截断标签等）后自动重新导入
7. **音节时间倒流标红**：编辑/打轴界面中，开始时间早于前一音节结束时间、或自身结束时间早于开始时间的音节会标红，修复后自动恢复
8. **消息视图**（侧边栏，与 "大纲"、"BPM" 并列）：
   - 集中显示检测到的倒流问题："第 X 行第 Y 个音节 'xxx' 出现倒流"，并附时间详情
   - 两类倒流均检测：与前一个音节重叠（开始时间早于前一个音节的结束时间）、自身倒挂（结束时间早于开始时间，如 03:32.115 ~ 03:31.742）
   - 点击消息定位并选中问题音节；修复后消息置灰且不可点击
   - 排序方式可切换：按检测时间 / 按行号与音节位置
   - 检测到首个倒流时自动打开消息视图

### 界面与工作区

9. **主题色设置**（设置 → 个性化 → 主题色）：提供 26 种强调色可选 —— "默认" 沿用原版配色（浅色为绿色、深色为玉色），另含 iris、violet、purple、indigo、blue、sky、cyan、teal、jade、green、grass、lime、mint、yellow、amber、orange、tomato、red、ruby、crimson、pink、plum、bronze、gold、gray 共 25 种 Radix Colors 主题色；点击即时生效，持久化保存，刷新后保留
10. **右侧工具窗口**（设置 → 个性化 → 工具窗口，开关启用；设置弹窗已升级为圆角矩形 + 毛玻璃模糊背景样式）：
    - 竖长窗口占据界面右侧：顶部 "文件/编辑/工具/帮助 + 编辑/打轴/预览" 按钮行保持全宽，功能区与底部歌曲进度条自动向左收缩让位
    - 浏览器式标签页：点击标签栏最后一个标签后的 "+" → 在菜单中选择 "预览" 即可打开标签；同一类型开多个标签时自动编号（预览 1、预览 2）；每个标签带独立关闭按钮，关闭后自动激活相邻标签
    - "预览" 标签渲染与预览页面完全相同的 AMLL 歌词效果（竖版），支持一边编辑/打轴一边实时预览，也可与全屏预览模式同时使用
    - 打开时默认无标签页（左上角即 "+" 按钮）；右上角 × 关闭整个窗口
    - 左边缘可拖动调节宽度（280–900px，自动限制不超出屏幕），宽度持久化保存
    - 架构可扩展：标签页类型采用注册表模式定义，后续可便捷添加更多功能标签
11. **工具窗口增强**（设置 → 个性化 → 工具窗口）：
    - **字号设置**：新增 "工具窗口字号" 设置行，关闭 "自动字号" 后可用滑杆在 14–56px 间精确调节歌词预览字体大小，即时生效并持久化保存；开启 "自动" 则跟随页面尺寸缩放（AMLL 默认行为）
    - **"+" 菜单升级**：菜单组件与原页面顶部菜单同款（Radix Themes DropdownMenu），修复此前透明背景问题，开合动画、圆角、阴影与原页面完全一致
    - **标签页拖动排序**：按住标签左右拖动即可调整顺序（浏览器标签栏同款交互），拖动时显示 accent 色插入位置指示线，被拖标签半透明显示
12. **工具窗口圆角与标签动画**：
    - 窗口左侧（左上/左下）改为 14px 圆角过渡，配合阴影呈现悬浮面板质感
    - 标签编号改为**按创建顺序**分配：拖动换位后编号跟随标签页本身移动（如换位后显示 "预览 2 预览 1"），位置变化一目了然
    - 标签页添加/删除/换位均有平滑动画（宽度展开收起 + 淡入淡出 + 位置滑动），切换标签页时内容区带轻微淡入
13. **打轴界面音节显示模式**（打轴模式功能区 → 显示选项 → "音节显示" 下拉，5 种模式即时切换并持久化）：
    - **只显示音节**：与原版一致的单行大字
    - **只显示音译**：音译放大居中，位置与原音节相同；无音译数据的音节自动回退显示原文
    - **音节 + 音译**：原文音节（大）+ 下方逐字音译（小），两行布局充分利用竖向空间，字号比三行模式稍大
    - **音节 + 假名**：上方假名（小）+ 原文音节（大）
    - **假名 + 音节 + 音译**：三行完整显示，假名上、音节中、音译下
    - 数据来源：音节 = 原文（有假名的词显示原词）、假名 = ruby 注音、音译 = 逐字音译；没有对应数据的行自动收起
    - 切换模式、字号缩放全部带 220ms 平滑过渡动画（高度渐变 + 淡入淡出 + 字号渐变）
    - 频谱视图的逐字音译显示与新模式联动（音译相关模式下自动开启）
14. **打轴界面假名合并显示**（修复一个字多个假名拆成多张卡片的问题）：
    - 一个字带多个假名（如 "沈" 带 "し""ず"）时，打轴界面只显示**一张**"沈"卡片，上方拼合显示 "しず"，不再按假名数复制卡片
    - 卡片时间 = 全部假名的时间并集（与 AMLL 渲染一致）；打轴按键（F/G/H 等）按**词**为单位进行，设置开始/结束时间自动写入首/末假名并保持假名内部边界不变
    - 无假名的音节在 "音节 + 假名"、"假名 + 音节 + 音译" 模式下同样**保留上方假名占位高度**，所有卡片高度一致，块下方的时间标签垂直对齐
    - 假名的精细时间调整仍可在编辑模式中通过注音编辑器进行
15. **点击歌词行切换右侧工具窗口**（设置 → 个性化 → 工具窗口 → "点击歌词行切换窗口"，默认开启）：
    - 编辑界面点击歌词行的背景框 → 显示右侧工具窗口（无标签页时自动打开 "预览" 标签）
    - 再次点击同一行 → 隐藏工具窗口（保留已打开的标签页，再点击其他行即恢复显示）
    - 点击不同行只切换选中，不影响窗口显隐；仅普通单击触发（Ctrl/Shift 多选不触发）
    - 关闭该设置后恢复原版行为（点击行只选中，不操作工具窗口）

16. **AI 助手**（工具窗口 "+" 菜单新增 "AI 助手" 标签页，类 MCP 架构）：
    - 接入任意 OpenAI 兼容大模型（内置智谱 GLM / DeepSeek / OpenAI / Kimi / 硅基流动 / Ollama 本地等服务商预设，填 Base URL + 模型名 + API Key 即可，"测试连接" 一键验证）
    - AI 通过工具调用（Function Calling）**直接操作歌词编辑器**，支持：读取歌词结构、搜索网页（Bing/DuckDuckGo 多引擎自动回退）、搜索 QQ 音乐曲库、导入 QQ 音乐官方歌词（逐字时间轴+假名+罗马音+翻译一键导入）、阅读网页、合并歌词行、合并音节、删除/插入行、修改音节文本、假名注音（单个/批量）、自动生成罗马音（基于假名，Hepburn 式）、设置整行音译、设置整行翻译、设置元数据（歌名/歌手等）
    - **执行步骤实时展示**：每一步"思考中 → 调用工具 → 工具结果 → 继续思考 → 最终回答"以时间线卡片形式动画展示，可展开查看工具参数 JSON 与耗时；支持随时"停止"
    - 聊天式界面：用户消息气泡、AI 回答气泡、错误卡片；空状态提供"导入 QQ 音乐歌词 / 搜索这首歌的信息 / 自动标注假名 / 生成罗马音 / 检查合并行 / 翻译为中文"快捷操作（双列网格布局）；执行步骤卡片在完成后自动折叠为"N 个步骤 · 总耗时"摘要行，点击可重新展开，长对话不再被过程刷屏
    - 网页搜索由本地启动器代理，**多引擎自动回退**（Bing 中国 → Bing 国际 → DuckDuckGo，无需额外 Key，国内环境可用），AI 可搜索歌曲资料并读取网页正文；搜索失败时会报告各引擎的具体错误便于排查
    - API Key 仅保存在浏览器 localStorage，经本地 server.py 转发给所选服务商；对话与歌词内容会发送给模型服务商
    - 每一次 AI 修改都会写入"历史操作"面板（来源标记 AI），可随时还原
17. **历史操作面板**（侧边栏新增 "历史" 标签页，编辑功能区也可开关）：
    - 记录人工或 AI 对 TTML 歌词的**每一次更改**：人工编辑（停止输入 0.7 秒后自动记录，连续输入合并为一条，自动 diff 生成描述如"修改 2 行文本 · 假名注音 +4"）、AI 工具操作（精确描述如"合并第 3-4 行"）、载入文档、还原操作
    - 每条记录显示：时间、来源徽标（手动 / AI / 还原 / 载入）、变更描述、行数与音节数
    - **任意还原**：悬停历史条目点击"还原到此版本"，歌词立即回到该次更改后的完整快照；还原本身也会记录一条历史
    - 还原后依然可以用 Ctrl+Z（编辑菜单"撤销"）撤销还原
    - **git 树状图视图**：最新版本始终在顶部（新记录到达时列表自动滚动到顶部）；每条记录带 git 风格短版本号（#001、#00a…）与彩色节点（绿=AI、灰=手动、琥珀=还原、蓝=载入）；"还原"记录以虚线边框卡片区分普通更改，并用琥珀色虚线曲线连到它取内容的源版本，悬停还原卡片时源版本同步高亮——还原与更改一眼可辨，不会混淆
    - **保留条数可配置**：面板顶部设置行提供 50 / 200 / 500 预设与自定义输入（20–500），修改后立即生效并持久化保存（默认 100 条）
18. **QQ 音乐歌词一站式导入**（通过 AI 助手使用，新增两个工具）：
    - `搜索 QQ 音乐`：在 QQ 音乐曲库中搜索歌曲（官方移动端接口 → 桌面端接口 → soso 接口三重回退，任一可用即返回），返回 songMid / 歌名 / 歌手 / 专辑 / 时长
    - `导入 QQ 歌词`：用 songMid 拉取该歌曲官方歌词并**自动解密**（腾讯魔改 3DES + zlib，纯标准库实现，零依赖），经 Ruby TTML 转换后一键导入编辑器（高保真）：
      - 逐字时间轴（QRC 格式，导入后无需打轴即可预览逐字点亮）
      - 假名注音：**逐假名时间轴**（优先用 [kana:] 自带时间戳，其次按罗马音时长比例分割，含熟字训如「今日→きょう」、拗音合并如「じゃ=じ+ゃ」）
      - 罗马音：**逐词音译**（与正文词 1:1 对齐、时间完全一致，可配合逐字音译显示）
      - 中文翻译（按时间对齐到行）
      - 时间轴防倒流：行时长矛盾修正、行内词 1ms 重叠钳制、假名时间锚定在词范围内
      - 自动过滤开头制作名单行（词/曲/编曲/Lyrics by/人声录音师 等中英文角色行，可保留）
      - 导入时自动补全元数据，键名与工具内建约定一致：`musicName`（歌曲名称）/ `artists`（艺术家，多人拆分为多条目）/ `songwriter`（词曲作者，从制作名单行提取）/ `album`（专辑名）/ `qqMusicId`（QQ 音乐 ID，优先数字 ID）
      - QQ 未提供的元数据保持原文档不变
    - 使用方式：AI 面板快捷芯片"导入 QQ 音乐歌词"（自动按当前文档歌名搜索），或直接说"帮我导入 XXX 的歌词"
19. **QRC 文件直接导入**（文件 → 打开，或直接把 `.qrc` 文件拖进窗口）：
    - 本地 `.qrc` 文件一键转换为 TTML（Ruby 格式）导入，支持四种文件形态：
      - 标准 QrcInfos XML（`<LyricContent="...">` 转义文本，社区分享的 .qrc 通用格式）
      - 三轨分段文本（`[lyric]` / `[trans]` / `[roma]` 段落，翻译罗马音齐全）
      - 纯 QRC 文本（`[ti:]` 头 + `[开始,持续]词(开始,持续)` 逐字行）
      - 加密内容（`<content><![CDATA[十六进制]]>` 原始接口数据，自动 3DES 解密）
    - 转换质量与 QQ 在线导入完全一致（同一套 Ruby TTML 转换器：逐假名时间轴注音 + 逐词音译 + 翻译 + 制作名单过滤）
    - 同样写入标准元数据（`musicName` / `artists` / `songwriter` / `album`，取自 QrcHeadInfo 或 [ti:]/[ar:]/[al:] 标签并自动去掉尾部括号注释；`qqMusicId` 仅 QQ 在线导入路径提供）
    - 转换成功后 Toast 显示行数与包含内容（假名注音/罗马音/翻译）；本地服务不可用（如 file:// 直开）时自动降级为客户端基础解析（仅逐字时间轴）

## 目录结构

```
├── server.py    # 本地启动器 (静态托管 dist/ + AI 助手后端代理 + QQ 音乐接口 + QRC 解密)
├── dist/        # 已构建好的前端产物 (vite build)
├── source/      # 修改后的完整源码, 可二次开发
└── README.md
```

## 二次开发

`source/` 是完整修改后的原项目源码（React + Vite + Radix Themes + jotai）：

```bash
cd source
bun install        # 或 pnpm install
bun run dev        # 开发模式 (热更新)
bun run build      # 重新构建到 source/dist/
```

构建后把 `source/dist/` 覆盖到根目录的 `dist/` 即可。

主要修改点源码位置：

| 修改 | 文件 |
|---|---|
| 标题 / 登录按钮 | `src/components/TitleBar/index.tsx` |
| 登录组件 | `src/components/LoginButton/index.tsx` |
| 登录状态 | `src/states/login.ts` |
| 菜单禁用逻辑 | `src/components/TopMenu/modals/FileMenu.tsx` |
| ruby 简化格式兼容 | `src/modules/ttml-processor/index.ts` (`normalizeRubyTextContainers`) |
| TTML 修复 | `src/modules/ttml-processor/index.ts` (`repairTTML`) + `src/components/Dialogs/TtmlRepairDialog.tsx` |
| 倒流检测 | `src/modules/lyric-editor/utils/backflow.ts` |
| 消息中心 | `src/components/MessageCenter/index.tsx` + `src/components/Sidebar/MessagesPanel.tsx` + `src/states/messages.ts` |
| 预览交换开关 | `src/states/preview-mode.ts` (`swapRomanTranslationAtom`) + `src/components/AMLLWrapper/index.tsx` |
| 主题色 | `src/modules/settings/states/theme.ts` + `src/modules/settings/modals/personalization.tsx` |
| 工具窗口 | `src/modules/settings/states/tool-window.ts` + `src/components/ToolWindow/` |
| 音节显示模式 | `src/modules/settings/states/index.ts` (`SyncWordDisplayMode`) + `src/modules/lyric-editor/components/lyric-word-view.tsx` |
| 假名合并显示 | `src/modules/lyric-editor/components/lyric-word-view.tsx` + `src/modules/lyric-editor/utils/lyric-states.ts` (`getWordSyncStartTime/EndTime`) + `src/modules/lyric-editor/components/sync-keybinding.tsx` |
| 行点击切换窗口 | `src/modules/lyric-drag/useLyricListDrag.ts` (`handleSelect`) + `src/modules/settings/states/tool-window.ts` (`lineClickTogglesToolWindowAtom`) |
| 多语言词条 | `locales/*/translation.json` |
| AI 助手 | `src/modules/ai/`（states / tools / agent / components/AIAssistantPanel）+ `server.py`（`/api/ai/chat`、`/api/web-search`、`/api/fetch-page`、`/api/qq-music-search`、`/api/qq-music-lyric`） |
| 历史操作 | `src/modules/history/`（states / components/HistoryPanel，git 树状图 + restoreOf 曲线 + 条数上限 atomWithStorage）+ `src/states/sidebar.ts` |

## 说明

- 登录为**本地账号**（用户名 + 密码，任意非空组合即可），仅用于门控"上传到歌词数据库"菜单项，数据不出浏览器
- "上传到歌词数据库"的实际提交行为仍与原版一致（提交到 AMLL TTML DB）
- 联网功能（LRCLIB 搜索等）与原版行为相同，需要网络环境
- **AI 助手**需要自行配置大模型接口：支持任意 OpenAI 兼容 API（智谱 GLM 的 `glm-4-flash` 有大量免费额度，适合入门；本地可用 Ollama 无需 Key）。模型需支持工具调用（Function Calling）
- AI 助手的网页搜索通过本地启动器的 `/api/web-search` 代理，多引擎自动回退（Bing 中国 → Bing 国际 → DuckDuckGo lite → DuckDuckGo html），无需搜索服务 API Key；`/api/fetch-page` 用于抓取网页正文
- QQ 音乐接口：`/api/qq-music-search`（搜索）、`/api/qq-music-lyric`（歌词解密，响应附 Ruby TTML）；`/api/qrc-to-ttml` 用于本地 .qrc 文件转换。HTTPS 接口在 Windows 证书链不全时会自动用免校验上下文重试，避免 "unable to get local issuer certificate" 报错
- 历史操作面板为会话级记录（刷新页面后清空，与自动保存的工程数据互相独立）；保留条数上限持久化保存在 localStorage（`amll.history.maxEntries`）
- QQ 音乐接口无需登录：搜索走 musicu.fcg 官方接口三重回退；歌词解密为腾讯 QRC 使用的魔改 3DES（S-box 含两处笔误 + 字节序差异，故标准库解出乱码），实现参考了 MIT 许可的公开项目并以纯 Python 标准库重写，零第三方依赖
