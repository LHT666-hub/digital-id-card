import type { SkillDefinition } from "@jiayi/contracts";
import { isSafetyTriageQuestion } from "../safety/classifier";

export const skillRegistry: SkillDefinition[] = [
  {
    id: "speech-transcription-bailian-qwen",
    name: "百炼实时语音转写",
    version: "qwen-audio-3.0-asr-flash.1",
    purpose: "把居民手机录音通过服务端转成可编辑文字，支持普通话、吴语等中文口音。",
    source: "阿里云百炼 Qwen-Audio 3.0 ASR Flash",
    license: "Commercial API",
    risk: "medium",
    enabled: true,
    allowedTools: ["speech.transcribe"],
    solves: "避免依赖不同手机浏览器的语音实现，并在松手后给出可核对文字。",
    evalScore: 0,
  },
  {
    id: "speech-transcription-whisper-wu",
    name: "普通话与吴语语音转写",
    version: "v09-local.1",
    purpose: "把居民录制的普通话、上海话或吴语转换为可编辑文字，确认后再进入 Claw。",
    source: "kaiwang0574/whisper-wu，基于 OpenAI Whisper Small 的 LoRA 适配器",
    license: "Apache-2.0",
    risk: "medium",
    enabled: true,
    allowedTools: ["speech.transcribe"],
    solves: "降低老年居民打字门槛，并保留居民确认环节，避免错误转写直接进入服务记录。",
    evalScore: 0,
  },
  {
    id: "safety-triage",
    name: "安全分流",
    version: "1.0.0",
    purpose: "优先识别急症提示和禁止由 AI 处理的诊疗请求。",
    source: "家医 Claw 自研",
    license: "Proprietary",
    risk: "high",
    enabled: true,
    allowedTools: ["audit.append"],
    solves: "避免 AI 延误急症、诊断、开方或调药。",
    evalScore: 100,
  },
  {
    id: "public-info-qa",
    name: "公开信息问答",
    version: "1.1.0-rag",
    purpose: "通过机构隔离、有效期过滤和混合检索，从已审核知识中回答服务时间、流程和联系方式。",
    source: "家医 Claw 自研",
    license: "Proprietary",
    risk: "low",
    enabled: true,
    allowedTools: ["knowledge.search", "public_info.read"],
    solves: "减少居民反复打电话询问公开服务信息。",
    evalScore: 100,
  },
  {
    id: "medical-entity-extractor",
    name: "居民信息结构化",
    version: "1.0.0-cn.1",
    purpose: "从中文口述中提取症状、药品、健康指标、时间和请求动作。",
    source: "OpenClaw medical-entity-extractor（MIT）本地化",
    sourceCommit: "ca216c092121f0d68d8a1e6ab8d075a7c4a6d56d",
    license: "MIT",
    risk: "medium",
    enabled: true,
    allowedTools: [],
    solves: "把居民零散口述整理成医生可以快速浏览的事实。",
    evalScore: 92,
  },
  {
    id: "service-intent-extractor",
    name: "服务意图识别",
    version: "1.0.0",
    purpose: "识别预约、续方、配药进度、随访和报告解释诉求。",
    source: "家医 Claw 自研",
    license: "Proprietary",
    risk: "medium",
    enabled: true,
    allowedTools: ["service_catalog.search"],
    solves: "把问答转为明确的基层服务类别，但不自动写入。",
    evalScore: 96,
  },
  {
    id: "appointment-intake",
    name: "预约资料收集",
    version: "1.0.0",
    purpose: "检查预约目标、日期、联系电话和候补意愿，并提示缺失项。",
    source: "家医 Claw 自研，参考 LangCare referral-generator",
    sourceCommit: "430598bb5a76619ef55fa34fb1fd90c65f3d4783",
    license: "MIT / Proprietary localization",
    risk: "medium",
    enabled: true,
    allowedTools: ["service_request.create"],
    solves: "让老人一次说清预约诉求，减少工作人员来回追问。",
    evalScore: 95,
  },
  {
    id: "followup-task-generator",
    name: "随访任务生成",
    version: "1.0.0-cn.1",
    purpose: "根据明确的随访安排生成责任人、截止时间和所需材料。",
    source: "LangCare follow-up-task-generator（MIT）本地化",
    sourceCommit: "430598bb5a76619ef55fa34fb1fd90c65f3d4783",
    license: "MIT",
    risk: "medium",
    enabled: true,
    allowedTools: ["service_request.create", "notification.send"],
    solves: "把口头随访要求变成可追踪的团队任务。",
    evalScore: 90,
  },
  {
    id: "patient-document-explainer",
    name: "医疗文件适老解释",
    version: "1.1.0-vision",
    purpose: "临时读取用户主动拍摄的报告、处方或药盒图片，忠实提取并通俗整理，不推断诊断或治疗建议。",
    source: "家医 Claw 自研，借鉴 Patiently AI 交互原则",
    license: "Proprietary clean-room implementation",
    risk: "high",
    enabled: true,
    allowedTools: ["vision.extract"],
    solves: "帮助居民从图片中核对报告或药品文字，并准备向医生提问的问题；原图默认不留存。",
    evalScore: 90,
  },
  {
    id: "clinician-previsit-summary",
    name: "医生接诊前摘要",
    version: "1.0.0-cn.1",
    purpose: "仅汇总居民原话、已填写资料和最近指标，显式标出缺失与来源。",
    source: "LangCare clinical-summary-generator（MIT）本地化",
    sourceCommit: "430598bb5a76619ef55fa34fb1fd90c65f3d4783",
    license: "MIT / Proprietary localization",
    risk: "high",
    enabled: true,
    allowedTools: ["resident_profile.read", "health_observation.search"],
    solves: "医生接诊前快速掌握诉求、时间线和待核实信息。",
    evalScore: 94,
  },
  {
    id: "health-trend-summary",
    name: "健康趋势摘要",
    version: "1.0.0",
    purpose: "描述血压、血糖、体重和步数的客观变化，不判断病情。",
    source: "家医 Claw 自研",
    license: "Proprietary clean-room implementation",
    risk: "medium",
    enabled: true,
    allowedTools: ["health_observation.search"],
    solves: "把零散手工记录整理成医生可核查的时间趋势。",
    evalScore: 91,
  },
];

export function getSkillDefinition(id: string) {
  return skillRegistry.find((skill) => skill.id === id) ?? null;
}

export function routeSkillIds(question: string) {
  const result = new Set<string>();
  if (isSafetyTriageQuestion(question)) result.add("safety-triage");
  if (
    /(几点|什么时候|地址|电话|在哪里|怎么查|流程|门诊时间|服务时间|家庭医生签约|签约服务|长处方|社区卫生服务中心|海湾镇|南桥镇|奉贤区|接种|疫苗|义诊|健康讲座|社区活动)/.test(question)
  ) {
    result.add("public-info-qa");
  }
  if (/(预约|挂.{0,2}号|约.{0,4}医生|帮.{0,4}约|一键约|转诊|上转|转院|报名|参加活动)/.test(question)) {
    result.add("service-intent-extractor");
    result.add("appointment-intake");
  }
  if (/(随访|复诊|复查|回访)/.test(question)) result.add("followup-task-generator");
  if (/(报告|化验单|检查单|出院小结|看不懂|看不明白)/.test(question)) result.add("patient-document-explainer");
  if (/(血压|血糖|体重|步|吃药|用药|药吃|降压药|阿司匹林|二甲双胍|不舒服|疼|痛|晕|咳)/.test(question)) {
    result.add("medical-entity-extractor");
  }
  return [...result];
}
