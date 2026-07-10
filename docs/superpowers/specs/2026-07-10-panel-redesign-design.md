# Panel AI 会话聚合面板重构设计

## 1. 文档状态

- 日期：2026-07-10
- 状态：用户已批准设计
- 目标仓库：D:\AI\tht-panel
- 设计基线：React 19 + TypeScript + Zustand 前端，Tauri 2 + Rust 后端

本设计覆盖菜单、项目与会话、工作区布局、窗口拖动、多供应商配置及不依赖 PowerShell 的原生 AI 会话工作区。由于范围跨越多个独立子系统，实施必须按阶段推进；每个阶段保持可构建、可回归，并遵循本文定义的稳定接口。

## 2. 术语与范围

### 2.1 固定术语

- 菜单：应用左侧导航区域。
- 工作区：应用右侧的多窗口区域。
- 项目：原代码和界面中的 Workspace，表示一个本地项目目录。
- 窗口：工作区分屏树中的单个叶子区域，不是 Tauri 或操作系统原生窗口。
- 会话：菜单中稳定存在、由 Panel 管理的 AI 对话。
- 纯终端：独立于 AI 会话的 Shell/PTTY 会话。
- 供应商：一套 Claude 或 Codex 连接配置，拥有稳定 ID。
- 运行段：一个会话在某个供应商和模型下对应的一段原生 Claude/Codex 线程。

### 2.2 本期范围

1. 菜单改为“项目 → 会话”层级，并增加已保存工作区列表。
2. 支持保存、加载和自动更新多窗口工作区。
3. 支持工作区窗口拖动换位。
4. 支持多个 Claude/Codex 供应商及同名模型共存。
5. 支持项目默认供应商与会话级切换。
6. 为 Codex 和 Claude 提供相互隔离的运行配置。
7. AI 会话改为原生消息界面，不再依赖 PowerShell；纯终端继续使用 xterm。

### 2.3 非目标

- 本期不自行实现完整模型 API Agent Runtime。
- 本期不支持多个 Tauri/操作系统原生窗口之间的拖动。
- 不把 Claude 原生会话 ID 伪装成可由 Codex 继续，反向同理。
- 不删除项目磁盘目录。
- 不静默迁移、回退或复用无法确认来源的密钥。

## 3. 总体架构

前端按领域拆分菜单、工作区、会话、供应商和纯终端状态。Rust 后端成为持久化、密钥、运行时进程和协议适配的真相来源。

主要单元：

- ProjectStore：项目元数据与排序。
- ProviderRegistry：供应商、模型、驱动默认值和密钥引用。
- WorkspaceLayoutStore：已保存工作区、分屏树和窗口载荷。
- ConversationStore：会话元数据、运行段索引和事件日志。
- ConversationManager：AI 会话生命周期、发送、取消、审批和协议事件。
- CodexAdapter：Codex app-server 协议适配。
- ClaudeAdapter：Claude stream-json 协议适配。
- TerminalManager：保留现有 PTY/xterm 纯终端能力。

边界规则：

- 前端不直接持有真实 API Key。
- ConversationManager 不解析布局；WorkspaceLayoutStore 不启动模型进程。
- CodexAdapter 与 ClaudeAdapter 分别理解各自协议，只输出稳定的统一事件。
- 纯终端和 AI 会话使用不同运行时类型，避免继续用 PtySessionInfo 同时表达两种语义。

## 4. 核心数据模型

### 4.1 Project

字段：

- id：稳定 UUID。
- name：菜单显示名。
- path：项目绝对路径。
- defaultProviderId：新会话默认供应商。
- defaultModelId：新会话默认模型，可空。
- sortOrder：菜单顺序。
- createdAt、updatedAt。
- keepAlive：保留现有配置，但仅作用于明确支持的运行类型。

Project 不再内嵌 baseUrl、apiKey 或完整 AgentConfig。项目只引用供应商和模型。

### 4.2 ProviderProfile

字段：

- id：稳定 UUID，端点不同必须使用不同 ID。
- name：例如“Claude A”“Claude B”“Codex A”。
- driver：claude 或 codex。
- baseUrl：可空，空表示驱动官方默认。
- secretRef：系统凭据存储中的密钥引用。
- enabled：是否允许创建新运行段。
- deletedAt：软删除时间，可空。
- modelProfiles：该供应商可选模型。
- overrides：供应商级可选参数覆盖。
- createdAt、updatedAt。

### 4.3 DriverDefaults

每个驱动只保存共用内容：

- executable：可执行文件或命令解析策略。
- commonArgs：公共参数。
- defaultModelName：默认模型名。
- settingsSources：驱动设置来源策略。

解析时使用两层合并：DriverDefaults 提供公共项，ProviderProfile 仅覆盖 URL、密钥、模型和必要差异。禁止通用多级继承，以免形成难以解释的配置链。

### 4.4 ModelProfile

字段：

- id：稳定 UUID。
- providerId。
- modelName：传给 CLI 的真实名称。
- displayName。
- extraOptions：驱动允许的模型级选项。

唯一性由 id 保证，而不是 modelName。因此相同模型名称可同时属于多个供应商。

### 4.5 Conversation

字段：

- id：Panel 会话稳定 UUID。
- projectId。
- title。
- currentProviderId、currentModelId。
- runtimeSegmentIds：按时间顺序记录底层运行段。
- activeRuntimeSegmentId。
- state：idle、running、waitingApproval、failed、archived。
- createdAt、updatedAt。

会话是菜单中的稳定对象。切换供应商不会替换 Conversation ID。

### 4.6 RuntimeSegment

字段：

- id。
- conversationId。
- providerId、modelId、modelNameSnapshot。
- driver。
- externalSessionId：Claude/Codex 原生线程 ID，可空。
- runtimeNamespaceId：定位供应商隔离目录。
- state。
- startedAt、endedAt。
- bridgeEventId：跨供应商上下文桥接事件，可空。

每个运行段冻结供应商、模型和命名空间。项目默认值或供应商配置后续变化，不会改写历史运行段。

### 4.7 SavedWorkspace 与 WorkPane

SavedWorkspace 字段：

- id、name。
- version。
- tree：分屏二叉树。
- activePaneId。
- createdAt、updatedAt。

WorkPane 叶子字段：

- id：位置稳定 ID。
- conversationIds：Tab 顺序，引用 Conversation ID。
- activeConversationId。
- terminalSessionIds：纯终端 Tab，可与 AI 会话分开表示。
- activeItemId、activeItemType。
- locked。
- projectId：空窗口的项目上下文，可空。

持久化不得引用易失的 PTY Session ID。

## 5. 持久化与密钥

建议文件：

- projects.json：项目。
- providers.json：驱动默认值、供应商和模型元数据，不含真实密钥。
- conversations.json：会话和运行段索引。
- workspace-layouts.json：全部已保存工作区及当前活动工作区。
- conversation-events/<conversationId>.jsonl：规范化完成事件。
- runtime/codex/<providerId>/：供应商级 Codex HOME。
- runtime/claude/<providerId>/：应用生成的 Claude settings 文件。

密钥策略：

- Windows 目标使用系统凭据存储或 DPAPI 封装的凭据层。
- JSON 只保存 secretRef 和“已配置/未配置”状态。
- config_get 类前端接口不得返回真实密钥。
- 密钥只通过子进程环境注入，不进入命令行、日志、错误文本或会话事件。

所有 JSON 写入使用临时文件、flush、原子替换和损坏文件备份。布局防抖写入必须提供 flushPersist，在真正退出前等待完成。

## 6. 菜单信息架构

菜单从上到下：

1. 新建项目。
2. 搜索。
3. 项目分组。
4. 工作区分组。
5. 模型供应商入口和全局设置。

### 6.1 项目分组

- 项目行支持展开/折叠。
- 展开后直接显示该项目会话，删除现有重复的全局“对话”分组。
- 项目行显示活动状态，并提供新会话按钮。
- 项目右键菜单：编辑、设置默认供应商、新建 AI 会话、新建纯终端、归档、删除。
- 会话行显示供应商标识、状态和更新时间。
- 会话右键菜单：重命名、切换供应商、移动到窗口、归档、删除。
- 当前项目、当前会话使用选中语义和 aria-current；行元素必须键盘可达。

### 6.2 工作区分组

- 顶部提供“保存当前工作区”。
- 列表项显示名称和窗口数量。
- 点击后加载保存的布局。
- 右键菜单：重命名、用当前布局更新、复制为新工作区、删除。

## 7. 工作区保存、恢复与拖动

### 7.1 保存与恢复

保存内容：

- 分屏方向与比例。
- 窗口顺序和位置。
- 每个窗口的会话 Tab 顺序。
- 活动会话、活动窗口、锁定状态和项目上下文。

加载行为：

- 当前进程仍存活的 AI 会话和纯终端直接重新挂载。
- 已停止的 AI 会话先加载 Panel 事件历史；用户下一次发送时才恢复底层运行段。
- 已结束的纯终端显示“重新打开终端”占位。
- 缺失项目或会话显示可解释占位，不阻止其余布局加载。

工作区加载后成为活动工作区。布局变化以防抖方式自动保存；用户可“复制为新工作区”保留变体。

### 7.2 窗口拖动换位

采用交换窗口载荷，而不是重写分屏树：

- sourcePane 与 targetPane 的会话 Tab、活动项、项目上下文和锁定状态互换。
- 两个 WorkPane 的 id、树位置、父节点、方向和比例不变。
- 换位完成后目标窗口成为活动窗口并立即持久化。

交互要求：

- 标题栏提供独立拖动把手，Tab、关闭和分屏按钮不能触发拖动。
- 投放目标显示明显高亮。
- 支持 Esc 取消和拖出工作区取消。
- 右键菜单和键盘提供“向左/右/上/下移动”替代操作。
- 空窗口、锁定窗口和多 Tab 窗口必须有明确规则；锁定状态随窗口载荷移动。

## 8. 供应商管理与解析

### 8.1 管理界面

“模型供应商”页面按 Claude/Codex 分组，支持：

- 新增。
- 复制。
- 编辑。
- 启用/禁用。
- 软删除。
- 显式连接测试。

连接测试如果会产生真实 API 请求，必须在执行前提示可能产生费用。只做格式校验时不得显示为“连接成功”。

### 8.2 解析优先级

创建或恢复运行段时：

1. 恢复旧运行段：使用该运行段冻结的 providerId、modelId 和命名空间。
2. 创建新运行段：会话显式选择。
3. 若无会话显式选择：项目默认供应商和模型。
4. 若项目未配置：驱动默认值。

后端必须校验 provider、model、driver 和项目关系，不能信任前端传入的 kind 字符串。未知 driver 必须报错，不能默认按 Claude 处理。

### 8.3 切换供应商

- 生成进行中禁止切换；用户需先完成或取消当前生成。
- 切换后 Conversation ID 不变，但创建新的 RuntimeSegment。
- 新运行段通过 ContextBridge 接收受长度限制的已有上下文。
- 消息流插入明确系统标记，展示来源供应商、目标供应商和时间。
- 原运行段保留，可审计且可查看。

ContextBridge 优先使用已持久化摘要和最近若干轮消息。没有摘要时使用确定性的受限历史片段，不自动调用模型生成隐性摘要。超出限制时提示用户选择继续、缩短或开启新会话。

### 8.4 删除与禁用

- 被历史会话引用的供应商只能软删除。
- 禁用后不可创建新运行段，但已运行进程可完成当前 turn。
- 恢复历史运行段时若供应商已禁用，显示修复入口，不静默换用其他供应商。

## 9. Codex 运行隔离

每个 Codex 供应商使用独立的应用自有 CODEX_HOME：

- runtime/codex/<providerId>/config.toml。
- 独立 sessions、auth 和运行状态。
- 每个供应商懒启动一个 Codex app-server stdio 进程。

启动规则：

- 进程环境仅注入该供应商密钥。
- 配置中的 model_provider 指向该供应商唯一命名空间。
- 不读写用户 ~/.codex。
- ProviderProfile 保存时原子生成配置；spawn 时不重写共享配置。

ConversationManager 使用 app-server 的 initialize/initialized、thread/start、thread/resume、turn/start、turn/interrupt 和审批请求。一个供应商 app-server 可承载多个会话线程；空闲且无活动会话时允许释放。

历史和会话探测必须显式使用 RuntimeSegment 的 CODEX_HOME 和 externalSessionId，不得读取 Tauri 父进程 CODEX_HOME 猜测。

## 10. Claude 运行隔离

Claude 运行段直接启动 CLI 机器模式：

- --print。
- --input-format stream-json。
- --output-format stream-json。
- --include-partial-messages。
- 新会话使用明确 session ID，恢复使用已保存 externalSessionId。

每个供应商生成应用自有 settings 文件，并通过 --settings 加载。URL 和密钥通过该子进程环境注入，不修改用户 ~/.claude。

不把 CLAUDE_CONFIG_DIR 当作已确认能力。若未来采用，必须先通过目标版本矩阵验证其认证、历史和目录语义。

每个活动 Claude 运行段拥有独立进程。进程退出、协议错误或版本不兼容时，ConversationManager 产生结构化错误事件。

## 11. Windows 可执行文件解析

AI 会话不得再使用 PowerShell -NoExit 或 EncodedCommand。

解析顺序：

1. 用户明确配置的绝对可执行文件。
2. PATH 中原生 .exe。
3. PATH 中 .cmd，使用 cmd.exe /D /S /C 作为明确 shim。
4. 找不到则返回可操作错误。

启动前做版本和能力探测。版本未知或缺少机器协议能力时，原生 AI 会话禁止发送，并提供“使用终端兼容模式”按钮。不得静默降级或猜测交互按键。

## 12. ConversationManager 与统一事件

适配器接口至少包含：

- startOrResume(segment)。
- send(segmentId, input)。
- cancel(segmentId, turnId)。
- approve(requestId, decision)。
- shutdown(segmentId)。

统一事件：

- UserMessage。
- AssistantDelta。
- AssistantMessageCompleted。
- ToolStarted。
- ToolOutput。
- ToolCompleted。
- ApprovalRequested。
- ApprovalResolved。
- StatusChanged。
- UsageReported。
- RuntimeError。
- ProviderSwitched。

AssistantDelta 只保存在内存，完成消息和状态转换写入 JSONL。事件必须带 eventId、conversationId、segmentId、时间戳和顺序号，以便去重和崩溃恢复。

发送数据流：

工作区编辑框 → Tauri command → ConversationManager → 当前适配器 → CLI → 规范化事件 → Tauri Channel → 前端会话 Store → 渲染与完成事件持久化。

## 13. 原生 AI 工作区界面

每个 AI 会话窗口包含：

- 顶栏：项目、当前供应商、模型、运行状态和切换入口。
- 消息流：用户消息、模型回复、工具调用、命令输出、文件变更和错误。
- 审批卡片：操作类型、原因、目标、影响范围和风险。
- 底部编辑框：Enter 发送，Shift+Enter 换行。
- 生成状态：发送按钮变为停止按钮。

安全行为：

- 所有审批默认由用户决定。
- 用户拒绝后将拒绝结果回传适配器。
- 破坏性操作不得使用“永久允许”快捷项。
- 工作区外路径、网络权限和命令升级必须清晰显示。

纯终端继续渲染 TerminalPane。AI 会话兼容模式可打开终端，但不能与原生消息视图同时争抢同一个单 sink PTY。

## 14. 错误处理与生命周期

### 14.1 配置错误

- 供应商不存在、禁用、密钥缺失或模型不兼容：历史可查看，发送禁用，显示修复入口。
- baseUrl 无效：保存时做格式校验；连接失败展示供应商和端点，不展示密钥。
- 保留参数冲突：禁止 extraArgs 覆盖 --profile、--settings、--resume、session ID 和配置路径等后端保留参数。

### 14.2 运行错误

- CLI 崩溃：保留已完成事件，将运行段标记 failed，可重试或创建新运行段。
- JSONL 半包、UTF-8 分片和未知事件：增量缓冲；未知非关键事件记录安全摘要，关键协议不兼容则停止。
- 取消：优先使用协议取消；超时后终止对应进程或供应商服务，并记录取消结果。
- 应用退出：停止接收新发送，flush 布局与事件，终止子进程树。

### 14.3 布局错误

- 缺失引用显示占位并提供移除操作。
- 损坏的单个工作区不影响其他工作区。
- 防抖保存失败必须向用户提示，不能继续静默丢失。

## 15. 安全设计

- API Key 不进入 WebView 状态。
- 前端仅获取掩码和 secretRef 状态。
- Rust 子进程启动前主动清理继承的 OPENAI_API_KEY、ANTHROPIC_API_KEY、ANTHROPIC_AUTH_TOKEN 等敏感变量，再注入当前供应商值。
- 日志和错误实现统一脱敏。
- CSP 不应继续长期保持 null；原生消息渲染不得允许任意 HTML。
- Markdown 渲染需要禁用原始 HTML，并限制外链行为。
- Provider baseUrl 指向非官方域名时显示明确风险提示。
- 不自动批准工具、命令、网络或工作区外文件操作。

## 16. 迁移设计

迁移必须幂等并带版本号：

1. 将旧 workspaces.json 中每个 Workspace 转成 Project。
2. 全局 claudeDefaults、codexDefaults 各生成一个默认 ProviderProfile。
3. 旧 useGlobalConfig=false 的项目配置生成项目专属 ProviderProfile。
4. 旧 ManagedSession 依据项目 agent 和配置推导 providerId；无法确认时标记 needsProviderSelection。
5. 旧布局 v1 转成 v2 分屏骨架；由于旧格式没有稳定会话引用，不能虚构 Tab 绑定。
6. 旧文件先备份，全部新文件成功原子写入后才记录迁移完成。

迁移失败时继续使用旧数据只读启动或回退旧版本，不允许部分写入后覆盖原文件。

## 17. 测试策略

### 17.1 前端

引入 Vitest，覆盖：

- 布局 v1 → v2 迁移。
- swapPanePayload 的同父、跨父、空窗口、多 Tab 和锁定场景。
- 供应商解析优先级。
- 菜单项目/会话选择和过滤。
- ContextBridge 长度限制与确定性。
- 会话事件去重和状态机。

### 17.2 Rust

单元和集成测试覆盖：

- ProviderRegistry 校验、软删除和密钥引用。
- 原子写、备份和迁移幂等性。
- Codex/Claude JSONL 任意字节分片解析。
- 统一事件映射和顺序号。
- 子进程环境清理与供应商隔离。
- 取消、进程退出和超时。

### 17.3 固定样例

保存按 CLI 版本标记的脱敏 JSONL fixtures，验证适配器解析。固定样例不得包含真实项目路径、密钥或用户对话。

### 17.4 真实联调

真实 CLI 烟测为显式 opt-in：

- Claude/Codex CLI 存在与版本探测。
- 新会话、续接、流式输出、取消。
- 审批允许与拒绝。
- 同一模型的两个供应商并发，确认 URL、密钥和历史不串线。

模拟测试不能替代真实 CLI 联调结论。

## 18. 分阶段实施

### 阶段 A：领域模型与安全基础

- Project、ProviderProfile、Conversation、RuntimeSegment。
- 密钥存储。
- 版本迁移。
- 后端校验和前端 DTO。

验收：旧数据可迁移；多供应商元数据和密钥隔离可用；构建与测试通过。

### 阶段 B：菜单与工作区

- 菜单项目/会话结构。
- SavedWorkspace。
- 布局 v2。
- 窗口拖动换位。

验收：可保存并恢复布局；窗口交换不改变比例；重启后稳定引用不丢失。

### 阶段 C：运行时适配器

- Codex app-server。
- Claude stream-json。
- ConversationManager。
- 统一事件和固定样例。

验收：两个驱动均能新建、续接、流式输出、取消和报告明确错误。

### 阶段 D：原生消息工作区

- 消息流、编辑框、工具卡片、审批卡片。
- 会话级供应商切换与 ContextBridge。
- 终端兼容模式。

验收：AI 会话不依赖 PowerShell；项目默认与会话覆盖行为正确；跨供应商切换可解释。

### 阶段 E：完整回归

- 性能、空闲释放、崩溃恢复。
- 安全审计。
- 七项需求逐条验收。

## 19. 原始需求验收矩阵

1. 菜单：存在“新建项目”，项目列表下直接显示会话，术语不再混用。
2. 窗口聚合：可把当前工作区保存为自定义工作区，点击后恢复布局和会话引用。
3. 窗口拖动：可交换左右、上下或嵌套位置中的窗口载荷，并有键盘替代。
4. 供应商配置：可新增、复制、编辑、禁用多个 Claude/Codex 供应商。
5. 会话供应商：新会话继承项目默认；右键可切换到任意启用供应商。
6. 同模型共存：相同 modelName 的多个供应商可并发运行，配置、密钥、历史和会话 ID 不串线。
7. 原生工作区：AI 会话使用消息流和编辑框，不依赖 PowerShell；纯终端仍可用。

所有条目必须同时有源码证据、自动化测试或可重复的真实联调证据，不能仅以界面存在作为完成证明。

## 20. 官方依据

- Codex App Server Getting started：
  https://learn.chatgpt.com/docs/app-server#getting-started
- Codex App Server API overview：
  https://learn.chatgpt.com/docs/app-server#api-overview
- Codex App Server Protocol：
  https://learn.chatgpt.com/docs/app-server#protocol
- Codex Custom model providers：
  https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers
- Codex Configuration reference：
  https://learn.chatgpt.com/docs/config-file/config-reference#configtoml

Claude 的 stream-json 能力已通过本机 Claude Code 2.1.199 的 --help 只读验证；具体事件结构仍需在阶段 C 使用脱敏固定样例和真实联调确认，不能仅凭参数存在假定跨版本兼容。
