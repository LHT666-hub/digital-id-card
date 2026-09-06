const punctuationPattern = /[，。！？；：、,.!?;:"'“”‘’（）()\[\]{}<>《》【】]/g;

const expansionRules: Array<{ pattern: RegExp; terms: string[] }> = [
  { pattern: /(?:预防针|打疫苗|疫苗|接种)/, terms: ["预防接种", "接种门诊", "疫苗"] },
  { pattern: /(?:家医|家庭医生)/, terms: ["家庭医生", "家庭医生签约", "签约服务"] },
  { pattern: /(?:长处方|长期处方|慢病配药|配慢病药)/, terms: ["长期处方", "长处方", "慢病用药"] },
  { pattern: /(?:体检报告|报告解读|看报告|体检单)/, terms: ["体检报告", "报告解读", "健康体检"] },
  { pattern: /(?:坐班|值班|出诊|门诊排班|谁在)/, terms: ["门诊排班", "坐诊", "服务时间"] },
  { pattern: /(?:几点|啥辰光|什么时候|哪几天|哪天|开门|营业)/, terms: ["服务时间", "门诊时间"] },
  { pattern: /(?:电话|联系方式|号码)/, terms: ["联系电话", "联系方式"] },
  { pattern: /(?:地址|在哪里|在哪儿|去哪|怎么走)/, terms: ["地址", "服务点", "位置"] },
  { pattern: /(?:分中心|服务点|服务站|网点|几个点|几个分中心)/, terms: ["分中心", "服务点", "服务站", "服务网络"] },
  { pattern: /(?:义诊|讲座|健康活动|活动)/, terms: ["健康活动", "义诊", "讲座"] },
  { pattern: /(?:高血压)/, terms: ["高血压", "血压管理"] },
  { pattern: /(?:糖尿病|血糖)/, terms: ["糖尿病", "血糖管理"] },
  { pattern: /(?:慢阻肺|copd)/i, terms: ["慢性阻塞性肺疾病", "COPD", "慢阻肺"] },
];

const localityRules: Array<{ pattern: RegExp; terms: string[] }> = [
  { pattern: /(?:海湾镇|海湾社区|海湾社卫|海湾卫生|海湾)/, terms: ["海湾镇", "海湾镇社区卫生服务中心"] },
  { pattern: /(?:南桥镇|南桥社区|南桥社卫|南桥卫生|南桥)/, terms: ["南桥镇", "南桥镇社区卫生服务中心"] },
  { pattern: /(?:奉贤|奉贤区)/, terms: ["奉贤区", "奉贤区卫生健康委员会"] },
  { pattern: /(?:五四|五四农场)/, terms: ["五四", "五四分中心", "海湾镇"] },
  { pattern: /(?:海旅|海旅分中心)/, terms: ["海旅分中心", "海湾镇"] },
  { pattern: /(?:民乐路55号|民乐路)/, terms: ["民乐路55号", "海湾镇社区卫生服务中心"] },
  { pattern: /(?:育秀东路29号|育秀东路)/, terms: ["育秀东路29号", "南桥镇社区卫生服务中心"] },
];

function normalizeWeekday(value: string) {
  return value
    .replace(/(?:礼拜|星期)([一二三四五六日天])/g, "周$1")
    .replace(/周天/g, "周日")
    .replace(/礼拜([1-7])/g, "周$1")
    .replace(/星期([1-7])/g, "周$1");
}

export function normalizeRetrievalQuery(input: string) {
  return normalizeWeekday(input.normalize("NFKC").toLowerCase())
    .replace(punctuationPattern, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function expandRetrievalQuery(input: string) {
  const normalized = normalizeRetrievalQuery(input);
  if (!normalized) return "";

  const terms = new Set<string>([normalized]);
  for (const rule of [...expansionRules, ...localityRules]) {
    if (rule.pattern.test(normalized)) {
      for (const term of rule.terms) terms.add(normalizeRetrievalQuery(term));
    }
  }

  if (/周[一二三四五六日1-7]/.test(normalized)) {
    terms.add(normalized.match(/周[一二三四五六日1-7]/)?.[0] ?? "");
  }

  return [...terms].filter(Boolean).join(" ");
}

export function getRetrievalTerms(input: string) {
  const expanded = expandRetrievalQuery(input);
  if (!expanded) return [];

  const terms = new Set<string>();
  const segments = expanded.split(/\s+/).map((item) => item.trim()).filter(Boolean);
  for (const segment of segments) {
    if (segment.length >= 2) terms.add(segment);
  }

  for (const rule of [...expansionRules, ...localityRules]) {
    if (rule.pattern.test(expanded)) {
      for (const term of rule.terms) {
        const normalized = normalizeRetrievalQuery(term);
        if (normalized.length >= 2) terms.add(normalized);
      }
    }
  }

  return [...terms];
}
