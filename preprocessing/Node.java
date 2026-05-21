public class Node {
    public final String word;
    public final float[] vec;

    public Node(String word, float[] vec) {
        this.word = word;
        this.vec = vec;

        normalize();
    }

    private void normalize() {
        float mag = 0f;

        for (float v : vec) {
            mag += v * v;
        }

        mag = (float)Math.sqrt(mag);

        if (mag == 0f) return;

        for (int i = 0; i < vec.length; i++) {
            vec[i] /= mag;
        }
    }

    public float cosineSimilarity(Node other) {
        float dot = 0f;

        for (int i = 0; i < vec.length; i++) {
            dot += vec[i] * other.vec[i];
        }

        return dot;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof Node)) return false;

        Node other = (Node)o;
        return word.equals(other.word);
    }

    @Override
    public int hashCode() {
        return word.hashCode();
    }

    @Override
    public String toString() {
        return word;
    }
}