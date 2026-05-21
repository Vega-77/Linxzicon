import java.util.*;

public class GraphAnalyzer {

    private final ArrayList<Node> nodes;

    public GraphAnalyzer(ArrayList<Node> nodes) {
        this.nodes = nodes;
    }

    // Estimate average degree for a cosine threshold
    public double averageDegree(float threshold, int sampleSize) {
        Random rand = new Random();

        long totalDegree = 0;

        for (int s = 0; s < sampleSize; s++) {
            Node node = nodes.get(rand.nextInt(nodes.size()));

            int degree = 0;

            for (Node other : nodes) {
                if (node == other) continue;

                if (node.cosineSimilarity(other) >= threshold) {
                    degree++;
                }
            }

            totalDegree += degree;

            if ((s + 1) % 10 == 0) {
                System.out.println("samples completed: " + (s + 1));
            }
        }

        return (double)totalDegree / sampleSize;
    }

    // Estimate isolated node percentage
    public double isolatedNodeRate(float threshold, int sampleSize) {
        Random rand = new Random();

        int isolated = 0;

        for (int s = 0; s < sampleSize; s++) {
            Node node = nodes.get(rand.nextInt(nodes.size()));

            boolean foundNeighbor = false;

            for (Node other : nodes) {
                if (node == other) continue;

                if (node.cosineSimilarity(other) >= threshold) {
                    foundNeighbor = true;
                    break;
                }
            }

            if (!foundNeighbor) isolated++;
        }

        return (double)isolated / sampleSize;
    }

    // BFS component size estimate from one node
    public int estimateComponentSize(Node start, float threshold, int maxVisited) {
        Queue<Node> queue = new LinkedList<>();
        HashSet<Node> visited = new HashSet<>();

        queue.add(start);
        visited.add(start);

        while (!queue.isEmpty()) {
            Node current = queue.poll();

            for (Node other : nodes) {
                if (visited.contains(other)) continue;

                if (current.cosineSimilarity(other) >= threshold) {
                    visited.add(other);
                    queue.add(other);

                    if (visited.size() >= maxVisited) {
                        return visited.size();
                    }
                }
            }
        }

        return visited.size();
    }

    // Find top K nearest neighbors
    public List<Node> nearestNeighbors(Node target, int k) {
        PriorityQueue<NodeScore> pq = new PriorityQueue<>();

        for (Node other : nodes) {
            if (target == other) continue;

            float sim = target.cosineSimilarity(other);

            pq.add(new NodeScore(other, sim));

            if (pq.size() > k) {
                pq.poll();
            }
        }

        ArrayList<NodeScore> result = new ArrayList<>();

        while (!pq.isEmpty()) {
            result.add(pq.poll());
        }

        Collections.reverse(result);

        ArrayList<Node> neighbors = new ArrayList<>();

        for (NodeScore ns : result) {
            neighbors.add(ns.node);
        }

        return neighbors;
    }
}