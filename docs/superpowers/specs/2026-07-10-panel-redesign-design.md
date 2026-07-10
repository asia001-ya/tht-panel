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

- GlobalPreferences：应用级默认供应商和模型。
- ProjectStore：项目元数据与排序。
- ProviderRegistry：供应商、不可变供应商修订、模型、驱动默认值和密钥引用。
- WorkspaceLayoutStore：已保存工作区、分屏树和窗口载荷。
- ConversationStore：会话元数据、运行段索引、稳定纯终端元数据和事件日志。
- ConversationManager：AI 会话生命周期、发送、取消、审批和协议事件。
- RuntimeCapabilityRegistry：按驱动和 CLI 版本记录已验证能力。
- RuntimeActivityRegistry：统一聚合 AI 运行段和 PTY 活动状态，供托盘、退出和保活使用。
- LegacyHistoryImporter：按稳定会话 ID 懒加载旧 Claude/Codex 历史。
- CodexAdapter：Codex app-server 协议适配。
- ClaudeAdapter：Claude stream-json 协议适配。
- TerminalManager：保留现有 PTY/xterm 纯终端能力。

边界规则：

- 前端不直接持有真实 API Key。
- ConversationManager 不解析布局；WorkspaceLayoutStore 不启动模型进程。
- CodexAdapter 与 ClaudeAdapter 分别理解各自协议，只输出稳定的统一事件。
- 纯终端和 AI 会话使用不同运行时类型，避免继续用 PtySessionInfo 同时表达两种语义。

## 4. 核心数据模型

### 4.1 GlobalPreferences

字段：

- defaultProviderId：应用级默认供应商，可空。
- defaultModelId：应用级默认模型，可空。

DriverDefaults 只提供某个驱动的公共启动参数，不能决定使用哪个驱动、供应商或密钥。新建项目时必须选择有效供应商；若已设置应用级默认供应商，可预填但仍允许修改。应用和项目都没有有效供应商时，禁止创建 AI 会话并引导用户先配置供应商。

### 4.2 Project

字段：

- id：稳定 UUID。
- name：菜单显示名。
- path：项目绝对路径。
- defaultProviderId：新会话默认供应商。
- defaultModelId：新会话默认模型，可空。
- sortOrder：菜单顺序。
- createdAt、updatedAt。
- keepAlive：保留现有设置，但迁移后必须重新确认 AI 会话保活。

Project 不再内嵌 baseUrl、apiKey 或完整 AgentConfig。项目只引用供应商和模型。

### 4.3 ProviderProfile

ProviderProfile 是用户可见的稳定身份：

- id：稳定 UUID，端点不同必须使用不同 ID。
- name：例如“Claude A”“Claude B”“Codex A”。
- driver：claude 或 codex。
- currentRevisionId：当前供应商修订。
- modelIds：该供应商下稳定的模型身份。
- enabled：是否允许创建新运行段。
- deletedAt：软删除时间，可空。
- createdAt、updatedAt。

### 4.4 ProviderRevision

供应商编辑不覆盖旧配置，而是创建不可变修订：

- id：稳定 UUID。
- providerId。
- driver。
- baseUrl。
- secretRef：该修订的系统凭据引用。
- modelSnapshots：该修订可选模型的不可变快照，按稳定 modelId 关联。
- overrides：供应商级参数快照。
- configHash：非敏感字段规范化哈希。
- createdAt。
- retiredAt：不再允许新运行段使用的时间，可空。

RuntimeSegment 必须引用 providerRevisionId。修改 URL、密钥、模型或认证设置时创建新修订；历史运行段继续引用旧修订。旧修订仍被运行段引用时不得删除其配置目录或密钥。用户显式退役旧密钥后，对应历史运行段变为不可恢复，并显示原因。

修订复用只能发生在同一个 ProviderProfile 内，并且必须同时满足 configHash 相同与 secretRef 完全相同。configHash 不包含密钥，绝不能单独用于凭据或跨供应商去重。编辑表单留空密钥表示沿用当前 secretRef；输入任何新密钥都先创建新的凭据引用和 ProviderRevision。

### 4.5 DriverDefaults

每个驱动只保存共用内容：

- executable：可执行文件或命令解析策略。
- commonArgs：公共参数。
- defaultModelName：默认模型名。
- settingsSources：驱动设置来源策略。

解析时使用两层合并：DriverDefaults 提供公共启动项，ProviderRevision 提供 URL、密钥、模型和必要差异。禁止通用多级继承。

### 4.6 ModelProfile

字段：

- id：稳定 UUID。
- providerId。
- displayName。
- createdAt。

每个 ProviderRevision 的 modelSnapshots 保存 modelId、传给 CLI 的 modelName 和 extraOptions。唯一性由稳定 modelId 保证，而不是 modelName；Project.defaultModelId 因此不会在供应商创建新修订时自动失效。若新修订主动移除该 modelId，新建运行段必须提示重新选择，历史运行段仍使用 modelNameSnapshot。

### 4.7 Conversation

字段：

- id：Panel 会话稳定 UUID。
- projectId。
- title。
- currentProviderId、currentModelId。
- runtimeSegmentIds：按时间顺序记录底层运行段。
- activeRuntimeSegmentId。
- summaryEventId：用户可见或确定性生成的摘要事件，可空。
- needsProviderSelection：迁移后无法可靠确定供应商时为 true；此时历史可读但禁止发送。
- state：idle、running、waitingApproval、failed。
- createdAt、updatedAt。

会话是菜单中的稳定对象。切换供应商不会替换 Conversation ID。

### 4.8 RuntimeSegment

字段：

- id。
- conversationId。
- providerId、providerRevisionId。
- modelId、modelNameSnapshot。
- driver。
- externalSessionId：Claude/Codex 原生线程 ID，可空。
- runtimeNamespaceId：定位不可变供应商修订目录。
- adapterVersion、protocolVersion：该运行绑定使用的 CLI 与协议版本。
- capabilitySnapshot：启动时验证的驱动能力。
- resumedFromSegmentId：从旧运行段恢复或重建时引用来源，可空。
- state。
- startedAt、endedAt。
- bridgeEventId：跨供应商上下文桥接事件，可空。

每个运行段表示一次具体的适配器进程或服务绑定，并冻结供应商修订、模型、版本、能力和命名空间。应用或服务重启后不得继续复用旧 capabilitySnapshot；旧运行段先结束，再创建带新版本和新能力快照的运行段。项目默认值或供应商后续编辑不会改写历史运行段。

### 4.9 TerminalSession

纯终端拥有独立稳定实体：

- id：稳定 UUID。
- projectId：所属项目，可空。
- title。
- cwd。
- shellDescriptor：Shell 类型及非敏感启动参数。
- runtimePtySessionId：当前进程内易失 PTY ID，可空。
- state：running、stopped、failed。
- createdAt、updatedAt。

完整退出后不能恢复原进程，只能依据 TerminalSession 元数据重新打开。旧 ManagedSession.kind=shell 迁移为 TerminalSession。

### 4.10 SavedWorkspace 与 WorkPane

SavedWorkspace 字段：

- id、name。
- version。
- tree：分屏二叉树。
- activePaneId。
- createdAt、updatedAt。

WorkPane 叶子字段：

- id：位置稳定 ID。
- items：有序 WorkspaceItemRef 数组，每项为 conversation 或 terminal，并引用稳定实体 ID。
- activeItemId。
- locked。
- projectId：空窗口的项目上下文，可空。

统一 items 数组保证 AI 会话与纯终端混排时仍能保存完整 Tab 顺序。持久化不得引用易失的 PTY Session ID。

### 4.11 CurrentWorkspace

CurrentWorkspace 始终存在，表示右侧当前正在编辑的布局：

- version。
- sourceSavedWorkspaceId：来源已保存工作区，可空；空表示尚未保存的临时工作区。
- tree。
- activePaneId。
- updatedAt。

它是当前布局和活动来源指针的唯一真相。首次启动、删除活动工作区或选择“新建空白工作区”时，sourceSavedWorkspaceId 为 null，但当前布局仍持续保存。

## 5. 持久化与密钥

建议文件：

- global-preferences.json：应用级默认供应商和模型。
- projects.json：项目。
- providers.json：驱动默认值、供应商、不可变修订和模型元数据，不含真实密钥。
- conversations.json：会话和运行段索引。
- terminal-sessions.json：稳定纯终端元数据。
- current-workspace.json：唯一当前布局及 sourceSavedWorkspaceId。
- workspace-layouts.json：全部已保存工作区，不保存当前活动指针。
- conversation-events/<conversationId>.jsonl：规范化完成事件。
- runtime/codex/<providerRevisionId>/：不可变供应商修订级 Codex HOME。
- runtime/claude/<providerRevisionId>/：应用生成的不可变 Claude settings 文件。

密钥策略：

- Windows 目标使用系统凭据存储或 DPAPI 封装的凭据层。
- JSON 只保存 secretRef 和“已配置/未配置”状态。
- config_get 类前端接口不得返回真实密钥。
- 密钥只通过子进程环境注入，不进入命令行、日志、错误文本或会话事件。

旧明文密钥迁移采用显式事务：

1. 扫描旧 settings.json 与 workspaces.json，只识别已知 apiKey 字段并显示待迁移数量和来源，不显示密钥正文。
2. 用户确认后，把包含明文的旧文件整体加密为 DPAPI 备份；禁止创建明文 .bak。
3. 将每个密钥写入凭据存储，并立即以 secretRef 读回校验。
4. 原子写入不含明文的新 JSON，再记录迁移完成版本。
5. 任一步失败都保留原文件并撤销已创建的新引用；不得留下半迁移状态。

无法确认来源或字段语义的字符串不自动当作密钥迁移。原始文件被原子替换后不承诺物理介质级安全擦除；应用需明确告知这一边界，并允许用户删除加密备份。

多文件迁移使用 migration-journal.json 协调，而不是假定多个 rename 具备整体原子性。Journal 保存 transactionId、旧文件与新临时文件哈希、加密备份路径、已创建 secretRef、当前阶段和目标 schema 版本。阶段依次为 prepared、secretsVerified、filesInstalled、committed：

- prepared：所有新 JSON 已写入临时路径并校验，加密备份已完成，旧文件尚未替换。
- secretsVerified：全部凭据已写入并读回。
- filesInstalled：按 manifest 安装新文件，但迁移版本尚未提交。
- committed：最后写入唯一迁移版本标记，迁移才对应用可见。

启动时发现未完成 Journal，必须根据文件哈希和阶段确定性地继续提交或从加密备份回滚，同时删除不再引用的临时凭据。Journal 恢复流程本身必须幂等；没有 committed 标记时，普通业务代码不得混读半迁移的新旧文件。

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
- 项目右键菜单：编辑、设置默认供应商、新建 AI 会话、新建纯终端、删除。
- 会话行显示供应商标识、状态和更新时间。
- 会话右键菜单：重命名、切换供应商、移动到窗口、删除。
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

点击 SavedWorkspace 时把其快照复制到 CurrentWorkspace，并设置 sourceSavedWorkspaceId。布局变化始终以防抖方式保存到 current-workspace.json：

- sourceSavedWorkspaceId 为 null：只更新临时当前布局；“保存当前工作区”创建 SavedWorkspace，并把新 ID 写回 CurrentWorkspace。
- sourceSavedWorkspaceId 非空：同一事务更新 CurrentWorkspace 和对应 SavedWorkspace，实现活动工作区自动保存。
- 删除当前来源 SavedWorkspace：只把 sourceSavedWorkspaceId 置空，保留当前布局为临时工作区。
- “复制为新工作区”：从 CurrentWorkspace 创建新 SavedWorkspace，并切换 sourceSavedWorkspaceId。

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

判定规则：

- sourcePane 与 targetPane 相同：无操作。
- 空窗口可作为来源或目标；交换时 items、activeItemId、projectId 和 locked 一起移动。
- 多 Tab 窗口整体移动，不能只拖动当前 Tab；Tab 单独移动不属于本期范围。
- locked 继续沿用现有“拒绝新 Tab”语义，不禁止换位；锁定状态随窗口载荷移动。
- 只能投放到窗口拖动接收区；分隔条、Tab、标题按钮和工作区空白处均为无效目标。
- 交换完成后 targetPane 成为 activePane，若目标载荷为空则 activeItemId 为 null。
- “向左/右/上/下移动”根据渲染后的窗口矩形选择指定方向上、边缘重叠最大且中心距离最近的窗口；没有候选目标时菜单项禁用。

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

1. 恢复旧运行段：使用该运行段冻结的 providerRevisionId、modelNameSnapshot、能力快照和命名空间。
2. 创建新运行段：会话显式选择。
3. 若无会话显式选择：项目默认供应商和模型。
4. 若项目未配置：应用级默认供应商和模型。
5. 若仍无有效供应商：阻止创建或发送，并引导用户配置；DriverDefaults 不能替代供应商。

后端必须校验 provider、model、driver 和项目关系，不能信任前端传入的 kind 字符串。未知 driver 必须报错，不能默认按 Claude 处理。

### 8.3 切换供应商

- 生成进行中禁止切换；用户需先完成或取消当前生成。
- 切换后 Conversation ID 不变，但创建新的 RuntimeSegment。
- 新运行段通过 ContextBridge 接收受长度限制的已有上下文。
- 消息流插入明确系统标记，展示来源供应商、目标供应商和时间。
- 原运行段保留，可审计且可查看。

ContextBridge 的唯一来源是 Panel 事件日志或 LegacyHistoryImporter 已显式导入的事件。它优先使用 summaryEventId 指向的用户可见摘要和最近若干轮消息；没有摘要时使用确定性的受限历史片段，不自动调用模型生成隐性摘要。桥接前清除密钥、环境变量值和被标记为敏感的工具输出。超出限制时提示用户选择继续、手动缩短或开启新会话。

### 8.4 删除与禁用

- 被历史会话引用的供应商只能软删除。
- 禁用后不可创建新运行段，但已运行进程可完成当前 turn。
- 恢复历史运行段时若供应商已禁用，显示修复入口，不静默换用其他供应商。

## 9. Codex 运行隔离

每个 Codex 供应商修订使用独立的应用自有 CODEX_HOME：

- runtime/codex/<providerRevisionId>/config.toml。
- 独立 sessions、auth 和运行状态。
- 每个供应商修订懒启动一个 Codex app-server stdio 进程。

启动规则：

- 进程环境仅注入该供应商密钥。
- 配置中的 model_provider 指向该供应商唯一命名空间。
- 不读写用户 ~/.codex。
- ProviderRevision 创建时原子生成不可变配置；spawn 时不重写共享配置。

ConversationManager 使用 app-server 的 initialize/initialized、thread/start、thread/resume、turn/start、turn/interrupt 和审批请求。一个供应商修订 app-server 可承载多个会话线程；空闲且无活动会话时允许释放。

每个 app-server 及其子进程加入独立 Windows Job Object，并启用 kill-on-close，保证服务级重启能终止其派生工具进程。单个 turn 取消超时按以下顺序最终遏制：

1. 请求 turn/interrupt，并把该运行段标记 cancelling。
2. 在短暂 grace period 内持续消费事件，等待明确的 interrupted/completed 终态。
3. 超时后把该供应商修订运行时标记 draining，阻止所有新 turn，并通知同进程其他会话即将恢复。
4. 关闭对应 Job Object，终止整个 app-server 及其子进程树，确保失控 turn 不再继续执行。
5. 把该进程承载的全部旧运行段结束为 interrupted，并为每个线程执行版本兼容检查。
6. 兼容时创建新的 RuntimeSegment，设置 resumedFromSegmentId，并按 externalSessionId resume；不兼容时拒绝原生恢复，提示用户以 ContextBridge 开启新线程。
7. 新运行段使用当前 adapterVersion、protocolVersion 和 capabilitySnapshot；事件按持久化 eventId、turnId 和顺序号去重，无法恢复的线程单独标记 failed。

该策略会在极端取消失败时短暂影响同供应商修订的其他会话，但提供确定的安全遏制，不能为了可用性让失控工具继续运行。

历史和会话探测必须显式使用 RuntimeSegment 的 CODEX_HOME 和 externalSessionId，不得读取 Tauri 父进程 CODEX_HOME 猜测。

## 10. Claude 运行隔离

Claude 运行段直接启动 CLI 机器模式：

- --print。
- --input-format stream-json。
- --output-format stream-json。
- --include-partial-messages。
- --no-session-persistence。

每个供应商修订生成应用自有 settings 文件，并通过 --settings 加载。URL 和密钥通过该子进程环境注入。Panel 不直接编辑用户 ~/.claude；本期默认禁用 Claude 原生会话持久化，以 Panel 事件日志作为历史真相，避免不同供应商共享 ~/.claude/projects 时发生历史归属混淆。

活动进程内的多轮上下文由 stream-json 进程维持。应用重启后不依赖 Claude --resume，而是从 Panel 事件日志通过受限 ContextBridge 创建新进程。若未来验证出可靠的供应商级 Claude 配置目录和原生 resume 能力，可作为后续能力启用，但不得作为本期验收前提。

应用退出或 Claude 进程结束时，当前 RuntimeSegment 必须写入 endedAt 并进入 stopped 或 failed，不能在下次启动复用。用户再次发送时，ConversationManager 使用同一 providerRevisionId 创建新的 RuntimeSegment，以 ContextBridge 重建上下文，并插入“运行段已重建”事件。该行为明确表示 Panel 会话连续，但不是 Claude 原生线程连续。

不把 CLAUDE_CONFIG_DIR 当作已确认能力。若未来采用，必须先通过目标版本矩阵验证其认证、历史和目录语义。

每个活动 Claude 运行段拥有独立进程。进程退出、协议错误或版本不兼容时，ConversationManager 产生结构化错误事件。

ClaudeAdapter 必须按 CLI 版本返回 RuntimeCapabilities。只有真实协议样例证明支持审批请求与响应时，capabilities.approvals 才为 true；否则原生模式使用不会弹出交互批准的安全权限策略，需批准的工具操作按拒绝处理，并提示用户切换终端兼容模式。取消、工具事件、局部消息和多轮输入同样必须逐项验证，不能由参数名称推断。

## 11. Windows 可执行文件解析

AI 会话不得再使用 PowerShell -NoExit 或 EncodedCommand。

解析顺序：

1. 用户明确配置的绝对可执行文件。
2. PATH 中原生 .exe。
3. PATH 中 .cmd，使用 cmd.exe /D /S /C 作为明确 shim。
4. 找不到则返回可操作错误。

启动前做版本和能力探测。版本未知或缺少机器协议能力时，原生 AI 会话禁止发送，并提供“使用终端兼容模式”按钮。不得静默降级或猜测交互按键。

RuntimeCapabilities 至少包含：

- streaming。
- multiTurn。
- nativeResume。
- cancelTurn。
- toolEvents。
- approvals。
- partialMessages。

能力记录必须包含 driver、CLI 版本、协议或 schema 版本及验证样例版本。界面只展示当前运行段真实支持的操作。

恢复规则：

- 历史 capabilitySnapshot 只用于解释旧事件，不能决定新进程可调用的方法。
- 每次进程或 app-server 启动都重新探测版本与能力，并创建新的 RuntimeSegment。
- Codex 只有在能力矩阵明确声明旧线程版本与当前 app-server 兼容时才调用 thread/resume。
- 版本或协议不兼容时，旧运行段保持只读，用户确认后通过 ContextBridge 创建新原生线程；禁止按旧能力快照继续发送、取消或审批。
- 当前操作按钮始终读取 active RuntimeSegment 的新能力快照。

## 12. ConversationManager 与统一事件

适配器接口至少包含：

- capabilities(version)。
- startOrResume(segment)。
- send(segmentId, input)。
- cancel(segmentId, turnId)。
- approve(requestId, decision)：仅 capabilities.approvals=true 时可调用，否则返回明确 UnsupportedCapability。
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

ConversationStore 还保存可选 ConversationSummaryEvent。摘要只能来自用户明确编辑、可见的模型总结消息或确定性压缩器；来源和覆盖的事件范围必须可查看。LegacyHistoryImporter 按旧 aiSessionId 和项目路径懒加载 Claude/Codex 历史，将能可靠识别的用户、助手和工具记录转成统一事件；无法解析的部分保存为 LegacyTranscriptBlock，不得伪造成完整结构化历史。

LegacyHistoryImporter 使用确定性事件 ID：

- eventId = hash(driver、规范化源标识、externalSessionId、原生记录序号、事件类型、脱敏内容哈希)。
- 每个 Conversation 保存 LegacyImportCheckpoint，包含源标识、文件身份、已确认字节偏移或记录序号、最后事件 ID 和 completedAt。
- 导入前从最后一个完整换行或完整原生记录开始；写入事件时按 eventId 去重，更新检查点与事件追加使用同一导入 Journal。
- 崩溃后重试会重新读取最后一个检查点区间，但不会重复追加已有 eventId。
- 源文件被截断或替换时重置读取位置，并依靠确定性 eventId 去重；源文件只追加时从检查点继续。

发送数据流：

工作区编辑框 → Tauri command → ConversationManager → 当前适配器 → CLI → 规范化事件 → Tauri Channel → 前端会话 Store → 渲染与完成事件持久化。

## 13. 原生 AI 工作区界面

每个 AI 会话窗口包含：

- 顶栏：项目、当前供应商、模型、运行状态和切换入口。
- 消息流：用户消息、模型回复、工具调用、命令输出、文件变更和错误。
- 审批卡片：仅在当前驱动能力矩阵确认支持时展示操作类型、原因、目标、影响范围和风险。
- 底部编辑框：Enter 发送，Shift+Enter 换行。
- 生成状态：发送按钮变为停止按钮。

安全行为：

- 所有审批默认由用户决定。
- 用户拒绝后将拒绝结果回传适配器。
- 破坏性操作不得使用“永久允许”快捷项。
- 工作区外路径、网络权限和命令升级必须清晰显示。
- 当前驱动不支持结构化审批时，不渲染虚假审批卡片；需要交互批准的操作安全拒绝，并提供终端兼容模式。

纯终端继续渲染 TerminalPane。AI 会话兼容模式可打开终端，但不能与原生消息视图同时争抢同一个单 sink PTY。

## 14. 错误处理与生命周期

### 14.1 配置错误

- 供应商不存在、禁用、密钥缺失或模型不兼容：历史可查看，发送禁用，显示修复入口。
- baseUrl 无效：保存时做格式校验；连接失败展示供应商和端点，不展示密钥。
- 保留参数冲突：禁止 extraArgs 覆盖 --profile、--settings、--resume、session ID 和配置路径等后端保留参数。

### 14.2 运行错误

- CLI 崩溃：保留已完成事件，将运行段标记 failed，可重试或创建新运行段。
- JSONL 半包、UTF-8 分片和未知事件：增量缓冲；未知非关键事件记录安全摘要，关键协议不兼容则停止。
- 取消：优先使用协议取消；独占 Claude 进程超时后可终止该进程。共享 Codex app-server 按第 9 节的线程级与服务级故障规则处理，不能因单个 turn 超时直接杀死其他会话。
- 应用退出：停止接收新发送，flush 布局与事件，终止子进程树。

RuntimeActivityRegistry 统一聚合 PtyManager 与 ConversationManager：

- 托盘隐藏时，纯终端和 AI 运行段继续运行。
- 退出确认同时统计活跃 PTY、正在生成的 turn 和等待审批的请求。
- 强制退出按顺序取消 turn、停止适配器、终止剩余进程树，再退出 Tauri。
- 托盘状态和菜单徽标同时反映 terminal、running、waitingApproval 和 failed。

现有 keepAlive 配置迁移后不自动对原生 AI 会话生效。纯终端沿用 PTY 写入；AI 保活会产生模型请求和费用，必须由用户重新确认后通过 ConversationManager 发送，并展示下一次执行时间和供应商。

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

1. 按第 5 节事务把已知明文密钥迁入凭据存储。
2. 将旧 workspaces.json 中每个 Workspace 转成 Project。
3. 全局 claudeDefaults、codexDefaults 各生成一个 ProviderProfile 和初始 ProviderRevision，并设置可确认的应用级默认供应商。
4. 旧 useGlobalConfig=false 的项目配置生成项目专属 ProviderProfile 和初始修订。
5. 旧 ManagedSession.kind=claude/codex 转成 Conversation，并依据项目 agent 与配置推导 providerRevisionId；无法确认时标记 needsProviderSelection。
6. 旧 ManagedSession.kind=shell 转成 TerminalSession。
7. LegacyHistoryImporter 使用 aiSessionId、项目路径和旧 Codex HOME 定位历史；只导入可可靠识别的消息，无法解析部分保存为 LegacyTranscriptBlock。
8. 旧布局 v1 转成 v2 分屏骨架；旧格式没有稳定 Tab 引用时不得虚构绑定。
9. 全部新文件和加密备份成功原子写入后才记录迁移完成。

迁移失败时继续使用旧数据只读启动或回退旧版本，不允许部分写入后覆盖原文件。

### 16.1 分阶段兼容

阶段 A 不立即删除 Workspace、AgentConfig 和旧 Tauri command。新增 CompatibilityFacade：

- 后端优先双读新旧 schema，新写入只落新 schema。
- 旧组件继续通过只读兼容 DTO 工作，直到阶段 B 菜单与布局切换完成。
- workspace_save：把旧 Workspace 写请求转换为 Project；内嵌 AgentConfig 仅可在该项目已绑定的同一 ProviderProfile 内，按 configHash + secretRef 精确匹配复用修订。不同 ProviderProfile 不去重；配置或密钥有变化时创建新 ProviderRevision，并更新项目默认引用。
- config_set：把旧 claudeDefaults、codexDefaults 转换为对应默认 ProviderProfile 的新修订，同时更新 GlobalPreferences；主题、终端字号等非供应商字段写入新的应用设置。
- config_get 与旧编辑表单不再回填密钥正文，只返回“已配置”状态；密钥输入留空表示保留 secretRef，输入新值表示创建新凭据和 ProviderRevision。
- workspace_delete：删除 Project 记录并清理工作区引用，但不删除磁盘目录；关联会话在用户确认后删除 Panel 元数据。
- layout_get/layout_save：旧组件读取 CurrentWorkspace 的 v2 兼容骨架；旧 v1 写请求经校验写入 current-workspace.json。若 sourceSavedWorkspaceId 非空，按第 7.1 节事务同步对应 SavedWorkspace；不得覆盖其他已保存工作区。
- legacy pty_spawn：通过 Project 和当前 ProviderRevision 解析出旧 ResolvedLaunch，直到新 ConversationManager 成为默认路径。
- AI 启动路径通过功能开关选择 legacy PTY 或新 ConversationManager，阶段 C 验证前默认保持 legacy。
- 每个阶段结束必须同时跑 legacy 回归和已启用的新能力测试。
- 只有阶段 D 完成并通过迁移烟测后，才移除旧 DTO、命令和旧配置写路径。

该策略保证阶段 A 到 D 都可独立构建和回退，不要求一次性“大爆炸”切换。

## 17. 测试策略

新增命令：

- npm run test：Vitest 单次运行。
- npm run test:watch：Vitest 监听模式。
- cargo test --manifest-path src-tauri/Cargo.toml：Rust 单元与集成测试。
- npm run test:cli-smoke：显式 opt-in 的真实 CLI 烟测，不进入默认离线测试。

### 17.1 前端

引入 Vitest + jsdom。所有 Tauri 调用经 BackendClient 接口封装，测试注入 FakeBackendClient 和可控 Channel；Zustand store 不直接 import invoke。覆盖：

- 布局 v1 → v2 迁移。
- swapPanePayload 的同父、跨父、空窗口、多 Tab 和锁定场景。
- 拖动同源无操作、无效投放、方向候选选择和 activePane 更新。
- conversation 与 terminal 混排 Tab 顺序。
- 供应商解析优先级。
- 菜单项目/会话选择和过滤。
- ContextBridge 长度限制与确定性。
- 会话事件去重和状态机。
- fake timer 下的防抖保存、空闲释放和超时。

### 17.2 Rust

只在外部副作用边界定义最小可替换接口：

- ProcessHost：启动、写入、取消和终止子进程。
- Clock：超时、空闲和时间戳。
- SecretStore：凭据读写与失败注入。
- ConfigFileStore：原子写、备份和迁移。

测试使用 tempdir、FakeProcessHost、FakeClock 和 FakeSecretStore，覆盖：

- ProviderRegistry 校验、软删除和密钥引用。
- ProviderRevision 不可变性及旧修订保留。
- 原子写、加密备份、migration journal 各阶段崩溃恢复和迁移幂等性。
- Codex/Claude JSONL 任意字节分片解析。
- 统一事件映射和顺序号。
- 子进程环境清理与供应商隔离。
- 取消、Job Object 进程树遏制、共享 app-server 恢复、进程退出和超时。
- 共享 app-server 重启时多线程状态恢复和去重。
- RuntimeActivityRegistry 的托盘、退出和 keepAlive 路由。
- CompatibilityFacade 对 workspace_save、config_set、workspace_delete 和 layout_save 的写转换。
- LegacyHistoryImporter 检查点、确定性 eventId、源文件追加/截断和崩溃重试。

### 17.3 固定样例

保存按 CLI 版本标记的脱敏 JSONL fixtures，验证适配器解析。固定样例不得包含真实项目路径、密钥或用户对话。

### 17.4 真实联调

真实 CLI 烟测为显式 opt-in：

- Claude/Codex CLI 存在与版本探测。
- Codex 新会话、续接、流式输出、取消和审批。
- Claude 多轮 stream-json、无原生持久化重启桥接，以及能力矩阵实际支持的取消/审批行为。
- 同一模型的两个供应商并发，确认 URL、密钥和历史不串线。

模拟测试不能替代真实 CLI 联调结论。

## 18. 分阶段实施

### 阶段 A：领域模型与安全基础

- GlobalPreferences、Project、ProviderProfile、ProviderRevision、Conversation、RuntimeSegment、TerminalSession。
- 密钥存储。
- 版本迁移。
- CompatibilityFacade、功能开关、后端校验和前端 DTO。

验收：旧数据可迁移；旧界面和 PTY 路径仍可运行；多供应商元数据和密钥隔离可用；构建与测试通过。

### 阶段 B：菜单与工作区

- 菜单项目/会话结构。
- SavedWorkspace。
- 布局 v2。
- 窗口拖动换位。

验收：在兼容 DTO 仍存在时可保存并恢复布局；AI/终端混排 Tab 顺序正确；窗口交换不改变比例；重启后稳定引用不丢失。

### 阶段 C：运行时适配器

- Codex app-server。
- Claude stream-json。
- ConversationManager。
- 统一事件和固定样例。

验收：Codex 能新建、原生续接、流式输出、取消和审批；Claude 能维持进程内多轮、从 Panel 历史重建上下文，并只暴露能力矩阵验证通过的取消/审批；两个驱动均能报告明确错误。

### 阶段 D：原生消息工作区

- 消息流、编辑框、工具卡片、审批卡片。
- 会话级供应商切换与 ContextBridge。
- 终端兼容模式。
- 在启用原生消息渲染前收紧 CSP、禁用 Markdown 原始 HTML、限制外链，并设置历史与工具输出容量上限。
- 切换新 AI 启动路径为默认，并移除旧配置写路径前完成迁移烟测。

验收：AI 会话不依赖 PowerShell；项目默认、应用默认与会话覆盖行为正确；跨供应商切换可解释；托盘、退出和纯终端无回归。

### 阶段 E：完整回归

- 性能、空闲释放、崩溃恢复。
- 安全审计。
- 回归验证 CSP、Markdown 安全策略及历史、工具输出和事件日志容量上限。
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
