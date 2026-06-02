# scripts/data

Contains `wordlist.txt` — a list of ~20,000 common English words used to filter down the GloVe vocabulary when building `embeddings.bin`.

Words were picked from GloVe by frequency, filtered to content words only (nouns, verbs, adjectives). Function words, stopwords, and proper nouns are excluded.
