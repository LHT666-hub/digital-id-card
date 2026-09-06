#!/usr/bin/env python3
"""Convert hint-lab/chinese-medical-kg SQLite data to JiaYi canonical NDJSON.

This script intentionally exports only entity names and aliases for entity
linking/query normalization. It does not promote the source into an
authoritative patient-answer corpus.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path


def normalize_type(value: str | None) -> str:
    mapping = {
        "drug": "drug",
        "disease": "disease",
        "gene": "gene",
        "symptom": "symptom",
        "test": "test",
        "procedure": "procedure",
    }
    return mapping.get((value or "").strip().lower(), "other")


def table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True, help="Path to medical_kg.db")
    parser.add_argument("--out", required=True, help="Output NDJSON path")
    parser.add_argument("--types", default="Drug,Disease", help="Comma-separated source entity types")
    parser.add_argument("--limit", type=int, default=0, help="Optional max entities for a trial import")
    args = parser.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        raise SystemExit(f"Database not found: {db_path}")

    allowed_types = {item.strip() for item in args.types.split(",") if item.strip()}
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    entity_columns = table_columns(conn, "entities")
    alias_columns = table_columns(conn, "aliases")
    required_entity = {"id", "name", "type"}
    required_alias = {"entity_id", "alias"}
    if not required_entity.issubset(entity_columns):
        raise SystemExit(f"Unexpected entities schema. Missing: {required_entity - entity_columns}")
    if not required_alias.issubset(alias_columns):
        raise SystemExit(f"Unexpected aliases schema. Missing: {required_alias - alias_columns}")

    query = "SELECT * FROM entities"
    params: list[object] = []
    if allowed_types:
        placeholders = ",".join("?" for _ in allowed_types)
        query += f" WHERE type IN ({placeholders})"
        params.extend(sorted(allowed_types))
    query += " ORDER BY id"
    if args.limit > 0:
        query += " LIMIT ?"
        params.append(args.limit)

    count = 0
    with out_path.open("w", encoding="utf-8") as output:
        for entity in conn.execute(query, params):
            entity_id = entity["id"]
            source_type = entity["type"]
            standard_name = (
                entity["standard_name"]
                if "standard_name" in entity_columns and entity["standard_name"]
                else entity["name"]
            )
            aliases = {
                row["alias"]
                for row in conn.execute(
                    "SELECT alias FROM aliases WHERE entity_id = ?",
                    (entity_id,),
                ).fetchall()
                if row["alias"]
            }
            if entity["name"] and entity["name"] != standard_name:
                aliases.add(entity["name"])

            generic_name = None
            if "generic_name" in entity_columns:
                generic_name = entity["generic_name"]
                if generic_name and generic_name != standard_name:
                    aliases.add(generic_name)

            payload = {
                "sourceKey": f"{source_type}:{entity_id}",
                "entityType": normalize_type(source_type),
                "standardName": standard_name,
                "aliases": sorted(aliases),
                "metadata": {
                    "sourceEntityId": entity_id,
                    "sourceEntityType": source_type,
                    "genericName": generic_name,
                },
            }
            output.write(json.dumps(payload, ensure_ascii=False) + "\n")
            count += 1

    conn.close()
    print(f"Converted {count} entities -> {out_path}")


if __name__ == "__main__":
    main()
