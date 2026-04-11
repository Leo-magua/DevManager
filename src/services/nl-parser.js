/**
 * 自然语言解析
 */
const fs = require('fs').promises;
const path = require('path');
const { getConfig } = require('../config');

class NLParser {
  async parse(input, context = {}) {
    const input_lower = input.toLowerCase();
    
    let operation = 'create';
    
    if (input_lower.includes('修改') || input_lower.includes('更新') || input_lower.includes('改成')) {
      operation = 'update';
    } else if (input_lower.includes('删除') || input_lower.includes('移除')) {
      operation = 'delete';
    } else if (input_lower.includes('查询') || input_lower.includes('查看') || input_lower.includes('有哪些')) {
      operation = 'query';
    }

    const parsed = {
      operation,
      title: this.extractTitle(input),
      description: input,
      category: this.extractCategory(input),
      keywords: this.extractKeywords(input),
      related_features: await this.findRelatedFeatures(input, context.projectId)
    };

    if (operation === 'create') {
      const similar = await this.findSimilarFeature(parsed.title, context.projectId);
      if (similar) {
        parsed.warning = `发现相似需求: ${similar.name} (${similar.id})`;
        parsed.suggested_action = 'update';
        parsed.related_feature = similar;
      }
    }

    return parsed;
  }

  extractTitle(input) {
    let title = input
      .replace(/^(请|帮我|需要|想要|希望|能不能|可以).*?(添加|创建|实现|开发|做|搞)?/i, '')
      .replace(/^[，,、\.\s]+/, '')
      .trim();
    
    if (title.length > 50) {
      title = title.substring(0, 50) + '...';
    }
    
    return title || input.substring(0, 50);
  }

  extractCategory(input) {
    const lower = input.toLowerCase();
    if (lower.includes('api') || lower.includes('后端') || lower.includes('数据库') || lower.includes('server')) {
      return 'Backend';
    }
    if (lower.includes('ui') || lower.includes('界面') || lower.includes('页面') || lower.includes('样式') || lower.includes('css')) {
      return 'Frontend';
    }
    if (lower.includes('bug') || lower.includes('fix') || lower.includes('修复') || lower.includes('报错')) {
      return 'Bug';
    }
    if (lower.includes('脚本') || lower.includes('工具') || lower.includes('自动化')) {
      return 'Tool';
    }
    return 'Feature';
  }

  extractKeywords(input) {
    const techKeywords = ['react', 'vue', 'node', 'api', 'database', 'ui', 'css', 'docker', 'k8s'];
    return techKeywords.filter(kw => input.toLowerCase().includes(kw));
  }

  async findRelatedFeatures(input, projectId) {
    if (!projectId) return [];
    
    try {
      const config = getConfig();
      const project = config.monitored_projects.find(p => p.id === projectId);
      if (!project) return [];

      const devStatePath = path.join(project.path, 'dev_state.json');
      const data = await fs.readFile(devStatePath, 'utf-8');
      const devState = JSON.parse(data);

      const keywords = this.extractKeywords(input);
      return devState.feature_list?.filter(f => 
        keywords.some(kw => f.name.toLowerCase().includes(kw) || 
                           f.category?.toLowerCase().includes(kw))
      ) || [];
    } catch {
      return [];
    }
  }

  async findSimilarFeature(title, projectId) {
    if (!projectId) return null;
    
    try {
      const config = getConfig();
      const project = config.monitored_projects.find(p => p.id === projectId);
      if (!project) return null;

      const devStatePath = path.join(project.path, 'dev_state.json');
      const data = await fs.readFile(devStatePath, 'utf-8');
      const devState = JSON.parse(data);

      return devState.feature_list?.find(f => {
        const similarity = this.calculateSimilarity(title, f.name);
        return similarity > 0.6;
      }) || null;
    } catch {
      return null;
    }
  }

  calculateSimilarity(str1, str2) {
    const set1 = new Set(str1.toLowerCase().split(''));
    const set2 = new Set(str2.toLowerCase().split(''));
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    return intersection.size / union.size;
  }
}

const nlParser = new NLParser();

module.exports = {
  nlParser,
  getNLParser: () => nlParser
};
