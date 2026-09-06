# Medical Knowledge Sources

家医 Claw 将“医学知识”“医学实体”“居民语言语料”和“RAG 方法参考”分开管理，避免把一个开源医疗 QA 数据集直接当成患者端权威知识。

## 四层知识结构

```text
A. 权威医学 / 政策知识
国家卫健委、NMPA、上海/奉贤官方、正式指南和标准
  -> 人工审核
  -> knowledge_documents / knowledge_chunks
  -> 可作为居民端 RAG 证据

B. 医学实体与别名本体
药品通用名、商品名、疾病标准名、ICD、常见别名
  -> medical_entities / medical_entity_aliases
  -> Entity Linking / Query Expansion
  -> 不单独形成诊疗结论

C. 居民语言与 QA 研究语料
Huatuo 等真实/合成问法
  -> Query paraphrase / intent / retrieval benchmark
  -> 默认不作为患者端临床证据

D. RAG 开源方法参考
RAGFlow / QAnything / MedRAG 等
  -> 借鉴 Hybrid Retrieval、Reranker、Benchmark
  -> 不整体替换现有 TypeScript + PostgreSQL/pgvector 技术栈
```

所有第三方来源必须先登记在 `data/knowledge-source-registry.json`，明确许可证、可信等级和允许用途后才能进入导入流水线。

## 首批接入：hint-lab/chinese-medical-kg

该项目 README 声明 MIT License，并提供约 1.98 万药物、3.58 万疾病、3,433 个基因/靶点以及 2.8 万余别名，支持精确匹配、别名识别和模糊纠错。项目文档显示药物部分包含 NMPA 来源，疾病使用 ICD-10 临床版。

家医 Claw **只把它接入实体标准化层**：

- 药品商品名 / 通用名归一；
- 疾病标准名与常见别名；
- 输入拼写差异和口语表达的候选匹配；
- 为后续 RAG 检索补充 canonical terms。

它不会直接替代药品说明书、诊疗指南或医生判断。

### 导入步骤

1. 从原仓库准备其 SQLite 数据库 `medical_kg.db`。
2. 转换成家医 Claw 的稳定 NDJSON 中间格式：

```bash
python scripts/convert-chinese-medical-kg.py \
  --db /path/to/medical_kg.db \
  --out /tmp/chinese-medical-kg.ndjson \
  --types Drug,Disease
```

建议先用 `--limit 1000` 做小批量验证。

3. 先 dry-run：

```bash
npm run import:medical-ontology -- \
  --input /tmp/chinese-medical-kg.ndjson \
  --source hint-lab-chinese-medical-kg \
  --dry-run
```

4. 确认数据库迁移 `202609060003_medical_entity_ontology.sql` 已应用后，再执行正式导入。

导入后的数据进入：

- `medical_entities`
- `medical_entity_aliases`
- `resolve_medical_entities(...)`

RAG 查询时实体解析与 embedding 并行执行，解析失败或相关表尚未部署时 fail-open，不阻塞原有检索。

## Huatuo-26M 的使用边界

Huatuo-26M 仓库声明 Apache-2.0，包含百科、知识图谱、在线咨询和 Lite 子集。它适合扩大中文医学问题表达覆盖，但不同子集的事实可信度不能等同。

当前规则：

- **Encyclopedia / KG**：用于候选术语发现、待审核事实发现、QA 测试；任何内容成为居民端证据前必须回查权威来源。
- **Consultation**：只用于居民问法、意图识别、Query Rewrite 和检索评测；不导入患者端临床 grounding。
- **Huatuo-Lite**：可作为研究和评测语料，不能跳过来源审核直接升级为 A 级知识。

## 开源 RAG 方法参考

- **RAGFlow**：参考 Hybrid Retrieval、Retrieval Test、相似度阈值和 Rerank 观察台；许可证 Apache-2.0。
- **QAnything**：参考中文 Embedding 初排 + Reranker 精排；仓库当前许可证为 AGPL-3.0，因此只借鉴架构思想，复制代码前必须单独评估许可证义务。
- **MedRAG**：参考医学 Corpus / Retriever / LLM 分层、Retriever 对比和医学检索 Benchmark。

## 后续医学知识包优先级

第一批只做项目 P0 病种：

1. 高血压
2. 2 型糖尿病
3. COPD

每个病种按统一 schema 建包：

```text
disease_profile
screening
assessment
monitoring_targets
medication_reference
followup
referral_red_flags
patient_education
source / version / reviewed_at / expires_at
```

随后再扩展血脂异常、冠心病/ASCVD、CKD。所有个人诊断、调药和处方决策仍由安全规则及医生兜底。
