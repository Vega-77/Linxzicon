import java.util.*;
import java.io.*;

public class DataProcessor {

    public static ArrayList<Node> nodes = new ArrayList<>();
    public static HashMap<String, Node> wordMap = new HashMap<>();

    public static void main(String[] args) {

        long start = System.currentTimeMillis();

        loadData("data.txt");

        long end = System.currentTimeMillis();

        System.out.println();
        System.out.println("Finished loading.");
        System.out.println("Total words: " + nodes.size());
        System.out.println("Load time: " + ((end - start) / 1000.0) + "s");

        GraphAnalyzer analyzer = new GraphAnalyzer(nodes);

        float[] thresholds = {
            0.55f,
            0.50f,
            0.45f,
            0.40f,
            0.35f,
            0.30f,
        };

        System.out.println();
        System.out.println("===== GRAPH ANALYSIS =====");

        for (float threshold : thresholds) {

            System.out.println();
            System.out.println("Threshold: " + threshold);

            double avgDegree = analyzer.averageDegree(threshold, 100);

            System.out.println("Estimated average degree: " + avgDegree);

            double isolatedRate = analyzer.isolatedNodeRate(threshold, 100);

            System.out.println("Estimated isolated node %: " + (isolatedRate * 100.0));

            Node randomNode = nodes.get(new Random().nextInt(nodes.size()));

            int componentEstimate = analyzer.estimateComponentSize(
                randomNode,
                threshold,
                5000
            );

            System.out.println("Estimated reachable nodes: " + componentEstimate);
        }

        System.out.println();
        System.out.println("===== EXAMPLE NEIGHBORS =====");

        testNeighbors(analyzer, "king");
        testNeighbors(analyzer, "computer");
        testNeighbors(analyzer, "music");
    }

    public static void testNeighbors(GraphAnalyzer analyzer, String word) {

        Node node = wordMap.get(word);

        if (node == null) {
            System.out.println(word + " not found.");
            return;
        }

        System.out.println();
        System.out.println("Neighbors for: " + word);

        List<Node> neighbors = analyzer.nearestNeighbors(node, 10);

        for (Node n : neighbors) {
            System.out.println("  " + n.word);
        }
    }

    public static void loadData(String filename) {

        try (BufferedReader reader = new BufferedReader(new FileReader(filename))) {

            String line;
            int count = 0;

            while ((line = reader.readLine()) != null) {

                String[] tokens = line.split(" ");

                String word = tokens[0];

                if (word.length() <= 3) continue;

                float[] vec = new float[100];

                for (int i = 1; i <= 100; i++) {
                    vec[i - 1] = Float.parseFloat(tokens[i]);
                }

                Node node = new Node(word, vec);

                nodes.add(node);
                wordMap.put(word, node);

                count++;

                if (count % 10000 == 0) {
                    System.out.println("Loaded: " + count);
                }
            }

        } catch (IOException e) {
            e.printStackTrace();
        }
    }
}