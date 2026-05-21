import java.io.*;
import java.util.*;

public class GloveKBuilder {

    static class WordVec {
        String word;
        float[] vec;

        WordVec(String w, float[] v) {
            word = w;
            vec = v;
            normalize();
        }

        private void normalize() {
            float mag = 0f;
            for (float v : vec) mag += v * v;
            mag = (float) Math.sqrt(mag);

            if (mag == 0) return;

            for (int i = 0; i < vec.length; i++) {
                vec[i] /= mag;
            }
        }

        float dot(WordVec o) {
            float sum = 0f;
            for (int i = 0; i < vec.length; i++) {
                sum += this.vec[i] * o.vec[i];
            }
            return sum;
        }
    }

    static class Neighbor implements Comparable<Neighbor> {
        String word;
        float score;

        Neighbor(String w, float s) {
            word = w;
            score = s;
        }

        public int compareTo(Neighbor o) {
            return Float.compare(this.score, o.score); // min-heap
        }
    }

    public static void main(String[] args) throws Exception {

        String inputFile = "data.txt";
        String outputFile = "glove_top25.txt";
        int K = 25;

        System.out.println("Loading GloVe...");

        ArrayList<WordVec> words = new ArrayList<>();
        HashMap<String, WordVec> map = new HashMap<>();

        BufferedReader br = new BufferedReader(new FileReader(inputFile));
        String line;

        while ((line = br.readLine()) != null) {

            String[] parts = line.split(" ");
            String word = parts[0];

            if (word.length() <= 3) continue;

            float[] vec = new float[parts.length - 1];

            for (int i = 1; i < parts.length; i++) {
                vec[i - 1] = Float.parseFloat(parts[i]);
            }

            WordVec wv = new WordVec(word, vec);

            words.add(wv);
            map.put(word, wv);
        }

        br.close();

        System.out.println("Words loaded: " + words.size());

        BufferedWriter out = new BufferedWriter(new FileWriter(outputFile));

        long start = System.currentTimeMillis();

        for (int i = 0; i < words.size(); i++) {

            WordVec w1 = words.get(i);

            PriorityQueue<Neighbor> pq = new PriorityQueue<>();

            for (int j = 0; j < words.size(); j++) {

                if (i == j) continue;

                WordVec w2 = words.get(j);

                float sim = w1.dot(w2);

                if (pq.size() < K) {
                    pq.add(new Neighbor(w2.word, sim));
                } else if (sim > pq.peek().score) {
                    pq.poll();
                    pq.add(new Neighbor(w2.word, sim));
                }
            }

            ArrayList<Neighbor> best = new ArrayList<>(pq);
            best.sort((a, b) -> Float.compare(b.score, a.score));

            StringBuilder sb = new StringBuilder();
            sb.append(w1.word).append("|");

            for (int k = 0; k < best.size(); k++) {
                Neighbor n = best.get(k);
                sb.append(n.word).append(":").append(n.score);

                if (k != best.size() - 1) sb.append(",");
            }

            out.write(sb.toString());
            out.newLine();

            if (i % 500 == 0) {
                System.out.println("Processed: " + i);
            }
        }

        out.close();

        long end = System.currentTimeMillis();

        System.out.println("Done.");
        System.out.println("Time: " + (end - start) / 1000.0 + "s");
    }
}