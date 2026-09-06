# RAG Knowledge Service

家医 Claw 的 RAG 只索引经过机构审核、仍在有效期内的公开服务与健康教育内容。排班、预约进度、居民指标和临床事实继续由结构化业务表与权限工具提供。

## 数据流

```text
content_items / public_info_entries
  -> 人工审核为 published
  -> knowledge_index_jobs
  -> 结构化中文分块
  -> Embedding（生产：text-embedding-v4）
  -> knowledge_document_versions / knowledge_chunks
  -> 机构、社区、权限、有效期过滤
  -> 居民问法归一化 / 同义词与本地别名扩展
  -> 关键词/别名候选 + 向量候选
  -> RRF 融合
  -> 可选 Qwen Reranker 二阶段重排
  -> 置信度门槛，弱匹配直接丢弃
  -> Top-K 证据
  -> Qwen 基于证据回答 + chunk 级引用
```

原始业务记录是唯一事实源。知识文档、版本、分块和向量均为可重建索引，不用于保存居民病历。

## RAG V2 检索原则

1. **先理解居民怎么说，再检索标准知识。** 例如“礼拜六打预防针伐”会归一化为“周六 / 预防接种 / 接种门诊 / 疫苗”等检索表达；“五四”“海旅”会补充其海湾镇片区语义。
2. **两路召回。** Lexical 路径负责机构名、药名、政策名、地址、电话号码等精确信息；Dense Vector 路径负责自然语言改写和语义近义表达。
3. **RRF 融合。** 两路候选先合并，避免单一 embedding 在知识库变大后召回退化。
4. **Reranker 只做二阶段精排。** 初排保留较宽候选，再使用百炼文本重排模型把最直接回答问题的 5–8 个证据放到前面。Reranker 超时或未配置时自动退回原混合排序，不阻塞回答。
5. **检索到不等于能回答。** Rerank / lexical / vector 分数低于置信度门槛时，结果直接当作“未命中”，不把弱证据强行喂给生成模型。
6. **时效和来源高于“看起来相关”。** 只使用 active、indexed、未过期、当前版本；实时医生排班、号源和个人业务状态不进入静态 RAG。

设计参考 RAGFlow 的 Hybrid Retrieval / Retrieval Test、QAnything 的 Embedding + Reranker 两阶段检索，以及 MedRAG 的 Corpus / Retriever / LLM 分层思路；代码保持家医 Claw 自己的 TypeScript + PostgreSQL/pgvector 实现，不引入新的重型运行框架。

## 环境变量

- `RAG_EMBEDDING_PROVIDER=disabled|deterministic|openai-compatible`
- `RAG_EMBEDDING_DIMENSIONS=1024`
- `RAG_EMBEDDING_API_KEY`
- `RAG_EMBEDDING_BASE_URL`
- `RAG_EMBEDDING_MODEL`
- `RAG_RERANK_ENABLED=true|false`
- `RAG_RERANK_MODEL=qwen3.7-text-rerank`
- `RAG_RERANK_TIMEOUT_MS=2200`
- `RAG_RERANK_BASE_URL`（可选；优先使用百炼 Workspace native endpoint）
- `RAG_RERANK_MIN_SCORE`（默认 `0.35`）
- `RAG_LEXICAL_MIN_SCORE`（默认 `0.12`）
- `RAG_VECTOR_MIN_SCORE`（默认 `0.5`）
- `RAG_GENERATION_ENABLED=true|false`
- `RAG_GENERATION_MODEL`

`deterministic` 只用于本地测试，生产环境默认禁止。未配置 Embedding 时，系统继续使用关键词检索，不会伪装成语义检索。Reranker 未配置或失败时，系统使用关键词 + 向量融合结果继续回答。

## 索引 Worker

发布或更新审核知识后会写入 `knowledge_index_jobs`。如果队列长期不被 Worker 消费，即使 SQL 已经支持 Hybrid Retrieval，线上也会退化成纯关键词检索。

Vercel 生产环境通过 `vercel.json` 定时调用：

- `GET /api/v1/internal/rag/process`

该路由同时保留 `POST` 供内部手动调用，两种方式都要求：

```text
Authorization: Bearer $CRON_SECRET
```

运行健康度可直接检查：

```sql
select status, count(*)
from public.knowledge_index_jobs
group by status;

select count(*) as total,
       count(*) filter (where embedding is not null) as embedded
from public.knowledge_chunks;
```

如果 pending 长期积压，或者 `embedded < total`，说明语义检索没有真正上线。

## Live Retrieval Eval

静态 golden set 主要保护 Git 内 curated knowledge 的排序。真实链路还需要验证 Supabase + Embedding + Entity Linking + Reranker + Confidence Gate。

本地配置 `.env.production.local` 后执行：

```bash
npm run eval:rag:live
```

Live eval 会：

- 要求真实 Supabase service role；
- 要求真实 `openai-compatible` embedding provider；
- 检查当前 `knowledge_chunks` 是否全部已有向量；
- 用海湾、五四、南桥、上海家医、高血压规范等代表性居民问法直接跑 `searchKnowledge()`；
- 校验 Recall@5 = 100%，Hit@1 >= 75%。

普通 `npm test` 默认跳过该联网测试，不让外部 API 或生产数据库影响 CI 稳定性。

## 管理接口

- `POST /api/v1/admin/rag/index`：索引单个来源或处理待处理队列。
- `GET /api/v1/admin/rag/status`：查看文档、队列和失败状态。
- `GET /api/v1/knowledge/search?q=...`：在当前机构和社区范围内检索。
- `GET|POST /api/v1/internal/rag/process`：由定时任务或内部调用携带 `CRON_SECRET` 自动处理索引队列。

发布 `content_items` 时会立即尝试索引；数据库触发器也会为已发布内容和公开信息建立待处理任务。后台 Worker 使用行锁原子领取任务，多个实例并发时不会重复领取同一任务。

## 安全边界

- 先执行医疗安全分流，再调用 RAG。
- 仅召回 active、indexed、未过期的当前版本。
- RLS 强制机构和社区隔离，工作人员内部知识不向居民开放。
- 检索内容作为数据而非指令，忽略文档内提示注入。
- 居民可见 evidence 不得混入“Claw 可用”“后续知识库应”“分块索引”等开发/索引备注。
- 资料不足时进入现有确定性 fallback 或人工服务，不生成无来源事实。
- 回答保留 chunk、document、source、version、reviewedAt 和 traceId。
