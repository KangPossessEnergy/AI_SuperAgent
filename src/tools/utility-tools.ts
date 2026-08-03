import type { ToolDefinition } from './registry.js';

/**
 * 一个工具由三样东西组成：
 * description：告诉模型这个工具是干什么的（模型靠这个判断什么时候该调它）
 * inputSchema：工具接受什么参数（用 JSON Schema 定义）
 * execute：实际执行函数
 */

/**
 * 这里面有个很重要的直觉：工具的 description 和 inputSchema 里的属性 description，本质上就是在写 prompt。 
 * 你写得越清楚、越具体，模型调用的准确率就越高。"查天气"不如"查询指定城市的实时天气信息，包括温度、风向等"。
 * 
 * inputSchema 里的属性 description。这里指的是parameters的description。
 * 
 */
 
export const weatherTool: ToolDefinition = {
  name: 'get_weather',// 工具名称，模型调用时会用到
  description: '查询指定城市的天气信息',// 工具描述，告诉模型这个工具是干什么的
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: '城市名称' } },
    required: ['city'],
    additionalProperties: false,
  },// 工具参数定义，告诉模型这个工具需要什么参数
  isConcurrencySafe: true,// 是否支持并发调用，true 表示支持，false 表示不支持
  isReadOnly: true,// 是否只读，true 表示只读，false 表示会修改数据
  execute: async ({ city }: { city: string }) => {
    const data: Record<string, string> = {
      '北京': '晴，15-25°C，东南风 2 级',
      '上海': '多云，18-22°C，西南风 3 级',
      '深圳': '阵雨，22-28°C，南风 2 级',
      '广州': '多云转晴，20-28°C，东风 3 级',
      '杭州': '晴，14-24°C，北风 2 级',
      '成都': '阴，16-22°C，微风',
    };
    return data[city] || `${city}：暂无数据`;
  },// 工具执行函数，实际执行工具的逻辑
};

export const calculatorTool: ToolDefinition = {
  name: 'calculator',
  description: '计算数学表达式的结果',
  parameters: {
    type: 'object',
    properties: { expression: { type: 'string', description: '数学表达式，如 "2 + 3 * 4"' } },
    required: ['expression'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ expression }: { expression: string }) => {
    try {
      const result = new Function(`return ${expression}`)();
      return `${expression} = ${result}`;
    } catch { return `无法计算: ${expression}`; }
  },
};
