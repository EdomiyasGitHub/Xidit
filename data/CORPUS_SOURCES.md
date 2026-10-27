# Corpus Source and Attribution

`corpus.json` contains a 300-document subset of the Somali Open
Pre-Training Corpus v2 (SOPC-v2). The subset is balanced across eight
categories: health (Caafimaadka), business (Ganacsiga), culture
(Dhaqanka), education (Waxbarashada), agriculture (Beeraha), technology
(Teknolojiyada), stories (Sheekooyin), and news (Wararka).

- Source: https://huggingface.co/datasets/Zyroxx66/somali-pretraining-corpus
- Creator: Hamze Jamal
- License: CC BY 4.0
- Imported: 2026-09-04

Each document retains its source, license, category, keywords, style,
difficulty, and quality-score metadata. `quality_score` is empty for all
300 documents.

## Provenance status (open question)

Not yet confirmed whether SOPC-v2 is human-written, web-scraped, or
machine-generated. The same Hugging Face account publishes other Somali
datasets that are explicitly described as synthetic, and the texts here
are unusually clean and templated (with `style`/`difficulty` fields). Check
the dataset card and record the answer here before presenting results.

## Known near-duplicates

These pairs are variants of the same text (different length/wording).
They are kept, not deleted, so document IDs stay stable for evaluation.
Expect them to appear together in result lists.

| Pair | Title |
| --- | --- |
| sopc-v2-56 / sopc-v2-100 | Caafimaadka: Muhiimadda ay leedahay cunista khudradda cusub |
| sopc-v2-58 / sopc-v2-101 | Caafimaadka: Sida loo yareeyo isticmaalka sonkorta badan |
| sopc-v2-267 / sopc-v2-312 | Waxbarashada: Horumarka Waxbarashada ee Geeska Afrika |
| sopc-v2-337 / sopc-v2-656 | Sheekooyin: Bakayle iyo Qoolley |
