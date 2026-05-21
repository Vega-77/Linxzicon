public class NodeScore implements Comparable<NodeScore> {

    public final Node node;
    public final float score;

    public NodeScore(Node node, float score) {
        this.node = node;
        this.score = score;
    }

    @Override
    public int compareTo(NodeScore other) {
        return Float.compare(this.score, other.score);
    }
}