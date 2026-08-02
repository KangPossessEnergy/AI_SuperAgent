// ===== 环境与第三方基础库 =====
import "dotenv/config"; // 启动时自动加载 .env 中的环境变量（如 API Key）
import fs from "node:fs"; // Node 文件系统模块（读写本地文件）
import { type ModelMessage } from "ai"; // AI SDK 的消息类型定义
import { createOpenAI } from "@ai-sdk/openai"; // 创建 OpenAI 兼容的模型提供者
import { createMockModel } from "./mock-model"; // 无 API Key 时使用的假模型（离线测试）
import { createInterface } from "node:readline"; // 命令行交互界面（REPL 输入）

// ===== Agent 核心循环与会话 =====
import { agentLoop } from "./agent/loop"; // Agent 主循环：模型调用 + 工具执行的循环驱动
import { allTools } from "./tools/index"; // 内置工具集合（文件、命令等）
import { MockMCPClient } from "./tools/mcp-client"; // MCP 协议的模拟客户端
import { SessionStore } from "./session/store"; // 会话持久化存储（消息历史的保存/恢复）
import { ToolRegistry } from "./tools/registry"; // 工具注册表：统一管理工具的注册与查找

// ===== 提示词（Prompt）构建与上下文防御 =====
import {
  coreRules, // 核心规则提示片段
  deferredTools, // 延迟加载的工具说明
  PromptBuilder, // 提示词构建器：组合各片段生成系统提示词
  PromptContext, // 构建提示词时所需的上下文类型
  sessionContext, // 会话信息提示片段
  toolGuide, // 工具使用指南提示片段
} from "./context/prompt-builder";
import { estimateMessageTokens } from "./context/defense"; // 估算消息的 token 数（上下文超长防御）
import { UsageTracker } from "./usage/tracker"; // token 用量统计跟踪器

// ===== 斜杠命令系统 =====
import { CommandContext, createDispatcher } from "./commands"; // 命令上下文类型与命令分发器

// ===== 记忆系统 =====
import { createMemoryTool } from "./tools/memory-tools"; // 提供给模型的记忆读写工具
import { MemoryStore } from "./memory/store"; // 记忆存储层

// ===== RAG 检索增强（向量化 + 检索） =====
import {
  createDashScopeEmbedder, // DashScope（阿里云）向量嵌入器
  createMockEmbedder, // 模拟嵌入器（无 Key 时测试用）
  embed, // 通用嵌入函数
} from "./rag/embedder";
import { createToolSearchTool } from "./tools/tool-search"; // 工具检索工具（按语义搜索可用工具）
import { createRagTools } from "./tools/rag-tools"; // RAG 相关工具（知识库查询等）
import { chunkDocument } from "./rag/chunker"; // 文档分块器：将文档切分为适合嵌入的片段

// ===== 提示词管道（把记忆/RAG 结果注入上下文） =====
import { memoryContext, ragContext } from "./context/prompt-pipes";

// ===== 各类斜杠命令实现 =====
import { ragCommands } from "./commands/rag"; // RAG 知识库命令
import { memoryCommands } from "./commands/memory"; // 记忆管理命令
import { contextCommands } from "./commands/context"; // 上下文查看/管理命令
import { debugCommands } from "./commands/debug"; // 调试命令
import { VectorStore } from "./rag/store"; // 向量数据库（存储与相似度检索）

// ===== 技能（Skills）系统 =====
import { SkillLoader } from "./skills/loader"; // 技能加载器：发现并加载技能定义
import { dreamCommands } from "./commands/dream"; // dream 命令（记忆整理/反思类）
import { createSkillCommands } from "./commands/skill"; // 技能管理命令

// ===== 插件系统 =====
import { PluginManager } from "./plugins/manager"; // 插件管理器：加载与生命周期管理
import { PluginDefinition } from "./plugins/types"; // 插件定义的类型
import { supabasePlugin } from "./plugins/supabase-plugin"; // 内置 Supabase 插件
import { createPluginCommands } from "./commands/plugin"; // 插件管理命令

// ===== 消息渠道接入 =====
import { ChannelGateway } from "./channels/gateway"; // 渠道网关：统一收发各平台消息
import { FeishuChannel } from "./channels/feishu"; // 飞书渠道接入
import { createChannelCommands } from "./commands/channel"; // 渠道管理命令

// ===== 安全钩子 =====
import { HookPipeline } from "./security/hooks"; // 钩子管道：在关键操作前后执行安全检查
import { createSecurityCommands } from "./commands/security"; // 安全相关命令

// ===== 定时任务（Cron） =====
import { CronService } from "./cron/service"; // 定时任务调度服务
import { createCronTool } from "./tools/cron-tools"; // 提供给模型的定时任务工具
import { createCronCommands } from "./commands/cron"; // 定时任务管理命令
import { any } from "zod"; // zod 的 any 类型（注意：疑似误导入，未使用可删除）

// ===== 子 Agent（多智能体） =====
import { SpawnContext } from "./agents/spawn"; // 子 Agent 派生上下文
import { createSpawnTool } from "./tools/spawn-tools"; // 提供给模型的子 Agent 派生工具
import { SubAgentRegistry } from "./agents/registry"; // 子 Agent 注册表
import { createAgentCommands } from "./commands/agents"; // 子 Agent 管理命令

// ===== 配置 =====
import { SuperAgentConfig } from "./config/schema"; // 配置的 TypeScript 类型定义
import { loadConfig } from "./config/loader"; // 配置加载器（读取 super-agent.config.json 等）

// 程序启动时加载全局配置，后续所有模块（模型、渠道、插件等）都基于它初始化
const config = loadConfig();

/*
const baseURL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const apiKey = process.env.DASHSCOPE_API_KEY;
// const apiKey:any=false;  // 测试 mock 模型
const qwen = createOpenAI({
  baseURL,
  apiKey,
});
const model: any = apiKey ? qwen.chat("qwen-plus-latest") : createMockModel();
*/

/* 按配置读取 */
function createModel(cfg: SuperAgentConfig["model"]) {
  if (!cfg.apiKey) return createMockModel();
  const provider = createOpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey });
  return provider.chat(cfg.name);
}
const model = createModel(config.model);

// ── Registry ────────────────────────────────────────
const registry = new ToolRegistry();
registry.register(...allTools);
registry.register(createToolSearchTool(registry));

// ── Memory ────────────────────────────────────────
const memoryStore = new MemoryStore(".");
memoryStore.init();
registry.register(createMemoryTool(memoryStore));

// ── RAG ────────────────────────────────────────
const vectorStore: any = new VectorStore();
const embedFn = process.env.DASHSCOPE_API_KEY
  ? createDashScopeEmbedder(process.env.DASHSCOPE_API_KEY)
  : createMockEmbedder();
registry.register(...createRagTools(vectorStore, embedFn));

async function connectMCP() {
  const mockClient = new MockMCPClient();
  const tools = await registry.registerMCPServer("github", mockClient);
  console.log(`  已注册 ${tools.length} 个 Mock MCP 工具`);
}

// ── Skills ────────────────────────────────────────
const skillLoader = new SkillLoader(".");
const loadedSkills = skillLoader.load();
const activeSkills = new Set<string>();

// ── Plugins ────────────────────────────────────────
const pluginManager = new PluginManager(registry);
const availablePlugins = new Map<string, PluginDefinition>([
  ["supabase", supabasePlugin],
]);

// ── Security: Hook Pipeline ────────────────────────────────────────
const hookPipeline = new HookPipeline();

// hookPipeline.registerPre('audit-log', (toolName, input) => {
//   if (toolName === 'write_file' || toolName === 'edit_file') {
//     const path = (input as any)?.path || 'unknown';
//     console.log(`  [audit] 文件写入操作: ${toolName} → ${path}`);
//   }
//   return { action: 'allow' };
// });

// hookPipeline.registerPost('bash-timestamp', (toolName, _input, output) => {
//   if (toolName === 'bash') {
//     const timestamp = new Date().toISOString();
//     return {
//       action: 'modify',
//       modifiedOutput: `[${timestamp}]\n${output}`,
//     };
//   }
//   return { action: 'allow' };
// });

/* 安全相关的hook按配置驱动 */
if (config.security.auditLog) {
  hookPipeline.registerPre("audit-log", (toolName, input) => {
    if (toolName === "write_file" || toolName === "edit_file") {
      const path = (input as any)?.path || "unknown";
      console.log(`  [audit] 文件写入操作: ${toolName} → ${path}`);
    }
    return { action: "allow" };
  });
}
if (config.security.bashTimestamp) {
  hookPipeline.registerPost("bash-timestamp", (toolName, _input, output) => {
    if (toolName === "bash") {
      const timestamp = new Date().toISOString();
      return {
        action: "modify",
        modifiedOutput: `[${timestamp}]\n${output}`,
      };
    }
    return { action: "allow" };
  });
}

registry.setHookPipeline(hookPipeline);

// ── Cron Service ────────────────────────────────────────
const cronService = new CronService(".");
registry.register(createCronTool(cronService));

// ── Sub-Agent
const agentRegistry = new SubAgentRegistry({
  maxSpawnDepth: config.agents.maxSpawnDepth,
  maxConcurrent: config.agents.maxConcurrent,
});

function getSpawnCtx(): SpawnContext {
  return {
    model,
    registry,
    agentRegistry,
    buildSystem: () => builder.build(makePromptCtx()),
    currentDepth: 0,
  };
}

registry.register(createSpawnTool(agentRegistry, getSpawnCtx));

// ── Prompt Builder ────────────────────────────────────────
const builder = new PromptBuilder()
  .pipe("coreRules", coreRules())
  .pipe("toolGuide", toolGuide())
  .pipe("deferredTools", deferredTools())
  .pipe("memoryContext", memoryContext(memoryStore))
  .pipe("ragContext", ragContext(vectorStore))
  .pipe("skillContext", () => skillLoader.buildPromptSection(activeSkills))
  .pipe("sessionContext", sessionContext());

// ── Channel Gateway ────────────────────────────────────────
const gateway = new ChannelGateway({
  model,
  registry,
  buildSystem: () => builder.build(makePromptCtx()),
});

// const FEISHU_PORT = Number(process.env.FEISHU_PORT || '3000');
// const feishuChannel = new FeishuChannel({
//   appId: process.env.FEISHU_APP_ID || '',
//   appSecret: process.env.FEISHU_APP_SECRET || '',
//   port: FEISHU_PORT,
// });
// gateway.register(feishuChannel);

if (config.channels.feishu.enabled) {
  const feishuChannel = new FeishuChannel({
    appId: config.channels.feishu.appId,
    appSecret: config.channels.feishu.appSecret,
    port: config.channels.feishu.port,
  });
  gateway.register(feishuChannel);
}

// ── Commands ────────────────────────────────────────
const dispatch = createDispatcher([
  ...debugCommands,
  ...contextCommands,
  ...memoryCommands,
  ...ragCommands,
  ...dreamCommands,
  ...createSkillCommands(skillLoader, activeSkills),
  ...createPluginCommands(pluginManager, availablePlugins),
  ...createChannelCommands(gateway),
  ...createSecurityCommands(registry, hookPipeline),
  ...createCronCommands(cronService),
  ...createAgentCommands(agentRegistry),
]);

function makePromptCtx(): PromptContext {
  return {
    toolCount: registry.getActiveTools().length,
    deferredToolSummary: registry.getDeferredToolSummary(),
    sessionMessageCount: 0,
    sessionId: "default",
  };
}

export async function startAgent() {
  await connectMCP();

  // 加载插件
  console.log("  加载插件...");
  /*    插件加载也从"全部加载"变成了"按配置启用"   */
  //   for (const [name, def] of availablePlugins) {
  //     try {
  //       const tools = await pluginManager.load(def);
  //       console.log(`  ✓ ${name} — ${tools.length} 个工具`);
  //     } catch {
  //       console.log(`  ✗ ${name} — 加载失败`);
  //     }
  //   }
  for (const pluginCfg of config.plugins) {
    const def = availablePlugins.get(pluginCfg.name);
    if (!def) {
      console.log(`  ✗ ${pluginCfg.name} — 未知插件`);
      continue;
    }
    if (!pluginCfg.enabled) {
      console.log(`  - ${pluginCfg.name} — 已禁用`);
      continue;
    }
    const tools = await pluginManager.load(def);
    console.log(`  ✓ ${pluginCfg.name} — ${tools.length} 个工具`);
  }

  // 启动 Channel
  console.log("  启动 Channel...");
  await gateway.startAll();

  // 启动 Cron
  cronService.load();
  cronService.setExecutor({
    runAgentPrompt: async (prompt, timeout) => {
      const cronMessages: ModelMessage[] = [{ role: "user", content: prompt }];
      const system = builder.build(makePromptCtx());
      await agentLoop(model, registry, cronMessages, system);
      const lastMsg = cronMessages[cronMessages.length - 1];
      if (!lastMsg) return "(无输出)";
      if (typeof lastMsg.content === "string") return lastMsg.content;
      if (Array.isArray(lastMsg.content)) {
        return (
          lastMsg.content
            .filter((p: any) => p.type === "text")
            .map((p: any) => p.text)
            .join("") || "(无输出)"
        );
      }
      return String(lastMsg.content);
    },
    notify: (message) => {
      console.log(`\n${message}`);
    },
  });
  cronService.start();
  const cronJobs = cronService.list();

  const store = new SessionStore("default");
  let messages: ModelMessage[] = [];
  const timestamps = new Map<number, number>();
  const tracker = new UsageTracker(".usage/today.jsonl");

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  function ask() {
    rl.question("\nYou: ", async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed === "exit") {
        console.log("Bye!");
        cronService.stop();
        await gateway.stopAll();
        await pluginManager.unloadAll();
        rl.close();
        return;
      }

      const ctx: CommandContext = {
        messages,
        timestamps,
        registry,
        builder,
        tracker,
        sessionStore: store,
        model,
        makePromptCtx,
        ask,
        memoryStore,
        vectorStore,
      };
      const handled = dispatch(trimmed, ctx);
      if (handled === "async") return;
      if (handled) {
        ask();
        return;
      }

      const userMsg: ModelMessage = { role: "user", content: trimmed };
      messages.push(userMsg);
      timestamps.set(messages.length - 1, Date.now());
      store.append(userMsg);

      const currentSystem = builder.build(makePromptCtx());
      const beforeLen = messages.length;
      await agentLoop(model, registry, messages, currentSystem, tracker);

      const newMessages = messages.slice(beforeLen);
      const now = Date.now();
      for (let i = beforeLen; i < messages.length; i++) timestamps.set(i, now);
      store.appendAll(newMessages);

      console.log(`  [Token] ~${estimateMessageTokens(messages)} tokens`);
      ask();
    });
  }

  const role = registry.getRole();
  const toolCount = registry.getActiveTools().length;
  const hooks = hookPipeline.list();

  console.log('Super Agent v0.19 — Sub-Agent (type "exit" to quit)');
  console.log("快捷命令：");
  console.log("  /agents           — 查看子 Agent 记录");
  console.log("  /cron             — 查看定时任务");
  console.log("  /role [角色]      — 查看/切换角色");
  console.log("");
  console.log(`  当前角色: ${role}，可用工具: ${toolCount} 个`);
  console.log(
    `  Sub-Agent: 最大深度 ${agentRegistry.getConfig().maxSpawnDepth}，最大并发 ${agentRegistry.getConfig().maxConcurrent}`,
  );
  console.log("");
  console.log("  试试：");
  console.log("    帮我对比 Hono、Fastify 和 Express 的性能和生态");
  console.log("    /agents       — 查看子 Agent 执行记录");
  console.log("");

  if (fs.existsSync("docs")) {
    const files = fs.readdirSync("docs").filter((f) => f.endsWith(".md"));
    if (files.length > 0) {
      console.log(`  发现 ${files.length} 个文档，自动导入知识库...`);
      for (const f of files) {
        const path = `docs/${f}`;
        const text = fs.readFileSync(path, "utf-8");
        const chunks = chunkDocument(path, text);
        const embeddings = await embed(
          embedFn,
          chunks.map((c) => c.text),
        );
        vectorStore.addBatch(
          chunks.map((c, i) => ({ chunk: c, embedding: embeddings[i] })),
        );
      }
      console.log(`  知识库就绪，共 ${vectorStore.size()} 个片段\n`);
    }
  }

  ask();
}
