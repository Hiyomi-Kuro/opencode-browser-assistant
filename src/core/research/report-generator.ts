import type { SourceRecord } from '../../shared/types';

export function buildResearchReport(question: string, method: string, findings: string, sources: SourceRecord[], language = '简体中文') {
  const validCitations = new Set(sources.map((source) => source.index));
  const checkedFindings = findings.replace(/\[(\d+)\]/g, (whole, number: string) => validCitations.has(Number(number)) ? whole : '[待核实来源]');
  const table = sources.length
    ? sources.map((source) => `| [${source.index}] ${escapeCell(source.title)} | ${escapeCell(source.excerpt.slice(0, 240))} | 页面正文已读取 | 页面可能有更新或上下文限制 |`).join('\n')
    : '| 无已验证来源 | 本次无法读取网页来源 | 无 | 结论仅供参考 |';
  const references = sources.length ? sources.map((source) => `[${source.index}] [${source.title}](${source.url}) — accessed ${new Date(source.accessedAt).toISOString()}`).join('\n') : '本次未成功读取可引用来源。';
  return `# 研究报告\n\n## 一、研究问题\n\n${question}\n\n## 二、研究方法\n\n${method}\n\n## 三、核心发现\n\n${checkedFindings}\n\n## 四、不同来源对比\n\n| 来源 | 主要发现 | 证据 | 局限性 |\n|---|---|---|---|\n${table}\n\n## 五、关键结论\n\n${checkedFindings || '目前证据不足，无法给出可靠结论。'}\n\n## 六、争议与不确定性\n\n请区分已验证事实、推断和仍待核实的信息；本报告只引用实际读取的网页。\n\n## 七、研究局限\n\n来源数量：${sources.length}。页面正文可能不完整；登录、付费墙或访问失败的内容不作为证据。报告语言：${language}。\n\n## 八、参考来源\n\n${references}\n`;
}

function escapeCell(value: string) { return value.replace(/[|\r\n]+/g, ' ').trim(); }
