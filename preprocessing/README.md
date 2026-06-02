# preprocessing

Java tools for working with the GloVe word embeddings dataset.

## Setup

1. Download the dataset from [Kaggle](https://www.kaggle.com/datasets/danielwillgeorge/glove6b100dtxt) (or use the original Stanford source below)
2. Put the file in this directory and rename it to `data.txt`
3. Run `GloveKBuilder.java`

The zip file and `data.txt` are gitignored since they're large (~1.2GB unzipped).

### Alternative download (Stanford direct)

```bash
curl -L -o glove.6B.zip https://downloads.cs.stanford.edu/nlp/data/glove.6B.zip
unzip glove.6B.zip glove.6B.100d.txt
mv glove.6B.100d.txt data.txt
```

## What's in here

- `GloveKBuilder.java` — builds a graph of the top-K nearest neighbors for each word
- `DataProcessor.java` — parses the raw GloVe text file
- `GraphAnalyzer.java` — analyzes the resulting graph
- `AdjacencyList.java`, `Node.java`, `NodeScore.java` — data structures

## Note

The JavaScript `game/` engine has its own build script (`game/scripts/build-data.js`) that takes the same `data.txt` and produces the binary embeddings file the game actually uses. The Java tools here are for exploring and analyzing the raw data.
