-- Small, auditable pilot for the medical entity layer. These concepts and
-- examples are taken from the public MIT-licensed hint-lab/chinese-medical-kg
-- README. They are used only for entity normalization/query expansion, never as
-- standalone clinical grounding. Bulk Drug/Disease import remains a separate
-- reviewed ingestion step.

with seed(entity_type, standard_name, source_key, metadata) as (
  values
    ('drug','阿司匹林','readme-example:drug:aspirin', '{"source":"hint-lab/chinese-medical-kg","sourceSection":"README examples","pilot":true}'::jsonb),
    ('drug','帕博利珠单抗','readme-example:drug:pembrolizumab', '{"source":"hint-lab/chinese-medical-kg","sourceSection":"README alias example","pilot":true}'::jsonb),
    ('drug','二甲双胍','readme-example:drug:metformin', '{"source":"hint-lab/chinese-medical-kg","sourceSection":"README batch example","pilot":true}'::jsonb),
    ('drug','胰岛素','readme-example:drug:insulin', '{"source":"hint-lab/chinese-medical-kg","sourceSection":"README batch example","pilot":true}'::jsonb),
    ('disease','肺癌','readme-example:disease:lung-cancer', '{"source":"hint-lab/chinese-medical-kg","sourceSection":"README relation example","pilot":true}'::jsonb),
    ('disease','糖尿病','readme-example:disease:diabetes', '{"source":"hint-lab/chinese-medical-kg","sourceSection":"README fuzzy example","pilot":true}'::jsonb)
)
insert into public.medical_entities (
  entity_type, standard_name, normalized_name, source_registry_id, source_key,
  authority_tier, metadata, reviewed_at
)
select
  entity_type,
  standard_name,
  lower(regexp_replace(standard_name, '\s+', '', 'g')),
  'hint-lab-chinese-medical-kg',
  source_key,
  'B',
  metadata,
  now()
from seed
on conflict (source_registry_id, source_key) do update set
  standard_name = excluded.standard_name,
  normalized_name = excluded.normalized_name,
  metadata = excluded.metadata,
  reviewed_at = excluded.reviewed_at;

with alias_seed(source_key, alias, alias_type) as (
  values
    ('readme-example:drug:aspirin','阿司匹林','synonym'),
    ('readme-example:drug:aspirin','阿司匹林片','other'),
    ('readme-example:drug:aspirin','阿斯匹林','spelling'),
    ('readme-example:drug:pembrolizumab','帕博利珠单抗','synonym'),
    ('readme-example:drug:pembrolizumab','可瑞达','brand'),
    ('readme-example:drug:metformin','二甲双胍','synonym'),
    ('readme-example:drug:metformin','二甲双瓜','spelling'),
    ('readme-example:drug:insulin','胰岛素','synonym'),
    ('readme-example:disease:lung-cancer','肺癌','synonym'),
    ('readme-example:disease:diabetes','糖尿病','synonym')
)
insert into public.medical_entity_aliases (
  entity_id, alias, normalized_alias, alias_type, source_registry_id
)
select
  e.id,
  a.alias,
  lower(regexp_replace(a.alias, '\s+', '', 'g')),
  a.alias_type,
  'hint-lab-chinese-medical-kg'
from alias_seed a
join public.medical_entities e
  on e.source_registry_id = 'hint-lab-chinese-medical-kg'
 and e.source_key = a.source_key
on conflict (entity_id, normalized_alias) do update set
  alias = excluded.alias,
  alias_type = excluded.alias_type,
  source_registry_id = excluded.source_registry_id;

comment on table public.medical_entities is
  'Canonical medical concepts used for entity normalization; pilot third-party rows are supporting terminology only and never standalone clinical grounding.';
