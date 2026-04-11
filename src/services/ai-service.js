/**
 * AI服务 - 处理大模型API调用
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');

class AIService {
  constructor() {
    this.defaultSettings = {
      baseUrl: 'https://api.stepfun.com/v1',
      model: 'step-3.5-flash'
    };
  }

  /**
   * 调用大模型API
   */
  async callLLM(messages, settings = {}) {
    const apiKey = settings.apiKey;
    const baseUrl = settings.baseUrl || this.defaultSettings.baseUrl;
    const model = settings.model || this.defaultSettings.model;

    if (!apiKey) {
      throw new Error('API Key未配置');
    }

    const url = new URL(baseUrl + '/chat/completions');
    const client = url.protocol === 'https:' ? https : http;

    const requestData = JSON.stringify({
      model: model,
      messages: messages,
      temperature: 0.7,
      max_tokens: 4000
    });

    return new Promise((resolve, reject) => {
      const req = client.request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'Content-Length': Buffer.byteLength(requestData)
          },
          timeout: 60000
        },
        (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const response = JSON.parse(data);
              if (response.error) {
                reject(new Error(response.error.message || 'API调用失败'));
              } else if (response.choices && response.choices[0]) {
                resolve(response.choices[0].message.content);
              } else {
                reject(new Error('无效的API响应'));
              }
            } catch (err) {
              reject(new Error('解析响应失败: ' + err.message));
            }
          });
        }
      );

      req.on('error', (err) => reject(new Error('请求失败: ' + err.message)));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('请求超时'));
      });

      req.write(requestData);
      req.end();
    });
  }

  /**
   * 测试AI连接
   */
  async testConnection(settings) {
    const messages = [
      {
        role: 'system',
        content: '你是一个简单的测试助手，只需回复"pong"即可。'
      },
      {
        role: 'user',
        content: 'ping'
      }
    ];

    const response = await this.callLLM(messages, settings);
    return {
      success: true,
      model: settings.model,
      response: response.trim()
    };
  }

  /**
   * 解析需求为标准化任务列表
   */
  async parseRequirement(input, projectContext, settings) {
    const prompt = this.buildParsePrompt(input, projectContext);
    
    const messages = [
      {
        role: 'system',
        content: '你是一个专业的软件需求分析师，擅长将自然语言需求拆分成结构化的开发任务。'
      },
      {
        role: 'user',
        content: prompt
      }
    ];

    const response = await this.callLLM(messages, settings);
    
    try {
      // 尝试解析JSON响应
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return parsed.tasks || [];
      }
      
      // 如果不是JSON，尝试按行解析
      return this.parseTextToTasks(response);
    } catch (err) {
      // 如果解析失败，返回文本解析结果
      return this.parseTextToTasks(response);
    }
  }

  /**
   * 构建解析需求的提示词
   */
  buildParsePrompt(input, context) {
    const { projectName, completedFeatures, inProgressFeatures, pendingFeatures, techStack } = context;
    
    return `请将以下需求解析为结构化的开发任务列表。

## 需求描述
${input}

## 项目背景信息
- 项目名称: ${projectName || '未命名项目'}
- 技术栈: ${techStack?.join(', ') || '未知'}

### 已完成的功能
${completedFeatures?.length > 0 ? completedFeatures.map(f => `- ${f.id}: ${f.name}`).join('\n') : '暂无'}

### 正在开发的功能
${inProgressFeatures?.length > 0 ? inProgressFeatures.map(f => `- ${f.id}: ${f.name}`).join('\n') : '暂无'}

### 待处理的功能
${pendingFeatures?.length > 0 ? pendingFeatures.map(f => `- ${f.id}: ${f.name}`).join('\n') : '暂无'}

## 任务拆分要求
1. 将需求拆分为独立的、可执行的开发任务
2. 每个任务应包含：标题、详细描述、类别(Feature/Bug/Frontend/Backend/Tool)
3. 任务粒度适中，一个任务应在1-4小时内完成
4. 考虑与现有功能的关联和依赖
5. 如果需求涉及多个模块，按模块拆分

## 输出格式
请严格按以下JSON格式输出（不要包含其他说明文字）:

{\n  "tasks": [\n    {\n      "title": "任务标题",\n      "description": "详细描述，包含实现要点",\n      "category": "Feature|Bug|Frontend|Backend|Tool"\n    }\n  ]\n}`;
  }

  /**
   * 将文本解析为任务列表（降级方案）
   */
  parseTextToTasks(text) {
    const tasks = [];
    const lines = text.split('\n').filter(line => line.trim());
    
    let currentTask = null;
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      // 尝试匹配任务标题（数字开头或特定标记）
      const titleMatch = trimmed.match(/^(?:\d+[.、]|[-*]|[任务]\d*[：:])\s*(.+)$/);
      if (titleMatch) {
        if (currentTask) {
          tasks.push(currentTask);
        }
        currentTask = {
          title: titleMatch[1].substring(0, 50),
          description: '',
          category: 'Feature'
        };
      } else if (currentTask) {
        // 累加描述
        currentTask.description += trimmed + ' ';
        
        // 尝试提取类别
        if (/前端|界面|UI|页面|样式|CSS/im.test(trimmed)) {
          currentTask.category = 'Frontend';
        } else if (/后端|API|数据库|接口|Server/im.test(trimmed)) {
          currentTask.category = 'Backend';
        } else if (/Bug|修复|报错|错误/im.test(trimmed)) {
          currentTask.category = 'Bug';
        } else if (/脚本|工具|自动化/im.test(trimmed)) {
          currentTask.category = 'Tool';
        }
      }
    }
    
    if (currentTask) {
      tasks.push(currentTask);
    }
    
    // 如果没解析到任何任务，将整个文本作为一个任务
    if (tasks.length === 0 && text.trim()) {
      tasks.push({
        title: text.trim().substring(0, 50) + (text.trim().length > 50 ? '...' : ''),
        description: text.trim(),
        category: 'Feature'
      });
    }
    
    return tasks;
  }
}

const aiService = new AIService();

module.exports = {
  aiService,
  getAIService: () => aiService
};
