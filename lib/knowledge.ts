import { knowledgeItems } from "@/data/knowledge";
import { normalizeQuestion } from "@/lib/faq";
import { shouldSearchInstitutionalKnowledge } from "@/lib/rag/search";
import { KnowledgeItem } from "@/lib/types";

const weakKnowledgeKeywords = new Set([
  "服务",
  "流程",
  "问题",
  "社区",
  "医生",
  "报告",
  "体检",
  "配药",
]);

function scoreKnowledgeItem(item: KnowledgeItem, normalizedQuestion: string) {
  let score = 0;
  let hitCount = 0;

  const normalizedTitle = normalizeQuestion(item.title);

  if (normalizedQuestion === normalizedTitle) {
    score += 40;
  } else if (
    normalizedQuestion.includes(normalizedTitle) ||
    normalizedTitle.includes(normalizedQuestion)
  ) {
    score += 18;
  }

  for (const keyword of item.keywords) {
    const normalizedKeyword = normalizeQuestion(keyword);

    if (!normalizedKeyword) {
      continue;
    }

    if (normalizedQuestion.includes(normalizedKeyword)) {
      hitCount += 1;
      score += weakKnowledgeKeywords.has(normalizedKeyword)
        ? 4
        : Math.max(8, normalizedKeyword.length * 2);
    }
  }

  return { score, hitCount };
}

export function searchKnowledge(question: string): KnowledgeItem[] {
  if (process.env.NEXT_PUBLIC_DEMO_MODE !== "true") {
    return [];
  }

  if (!shouldSearchInstitutionalKnowledge(question)) return [];

  const normalizedQuestion = normalizeQuestion(question);

  if (!normalizedQuestion) {
    return [];
  }

  const ranked = knowledgeItems
    .map((item) => ({
      item,
      ...scoreKnowledgeItem(item, normalizedQuestion),
    }))
    .filter((entry) => entry.hitCount > 0 && entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return b.hitCount - a.hitCount;
    })
    .slice(0, 3)
    .map((entry) => entry.item);

  return ranked;
}

const inScopeKeywords = [
  "家庭医生",
  "家医",
  "签约",
  "体检",
  "报告",
  "健康云",
  "小程序",
  "配药",
  "开药",
  "拿药",
  "长处方",
  "延伸处方",
  "随访",
  "血压",
  "血糖",
  "高血压",
  "糖尿病",
  "转诊",
  "专家号",
  "一键找人",
  "联系医生",
  "居委",
  "楼组长",
  "护士",
  "药师",
  "群聊",
  "健康小组",
  "打卡",
  "积分",
  "小课堂",
  "保健品",
  "药茶",
  "中医理疗",
  "老人不会用手机",
  "服药提醒",
];

export function isInScope(question: string) {
  const normalizedQuestion = normalizeQuestion(question);

  if (!normalizedQuestion) {
    return false;
  }

  return inScopeKeywords.some((keyword) =>
    normalizedQuestion.includes(normalizeQuestion(keyword)),
  );
}

export function buildKnowledgePrompt(
  question: string,
  snippets: KnowledgeItem[],
) {
  const block = snippets
    .map(
      (item, index) =>
        `${index + 1}. 标题：${item.title}\n   内容：${item.content}\n   安全边界：${item.safeUse}`,
    )
    .join("\n\n");

  return `用户问题：
${question}

相关知识库片段：
${block}

请基于上述片段回答，不要扩展到诊断、处方、停药、换药或个体化治疗建议。`;
}
