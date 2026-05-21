import java.util.*;
import java.io.*;

public class AdjacencyList {
    private final Map<Node, List<Node>> adjacencyList;

    public AdjacencyList() {
        this.adjacencyList = new HashMap<Node, List<Node>>();
    }

	public int size() {
		return adjacencyList.size();
	}

    public void addNode(Node node) {
        adjacencyList.putIfAbsent(node, new ArrayList<Node>());

        //System.out.println("Adding " + node);

        for (Node other : adjacencyList.keySet()) {
			double distance = node.distanceSq(other);

			if (distance < 0.04) addEdge(node, other);
		}
    }

    public void addEdge(Node node1, Node node2) {
        if (adjacencyList.containsKey(node1) && adjacencyList.containsKey(node2)) {
            adjacencyList.get(node1).add(node2);
            adjacencyList.get(node2).add(node1);
        }
    }

    public void removeEdge(Node node1, Node node2) {
		if (adjacencyList.containsKey(node1) && adjacencyList.containsKey(node2)) {
			adjacencyList.get(node1).remove(node2);
			adjacencyList.get(node2).remove(node1);
		}
	}

    public List<Node> getNeighbors(Node node) {
        if (!adjacencyList.containsKey(node)) return null;
        return adjacencyList.get(node);
    }

    public boolean isAdjacent(Node node1, Node node2) {
		if (!adjacencyList.containsKey(node1) || !adjacencyList.containsKey(node2))
            return false;

        for (Node node : adjacencyList.get(node1)) {
			if (node.equals(node2)) return true;
		}

        return false;
    }

	public List<Node> highestDegree() {
		int max = 0;
		List<Node> highest = new ArrayList<>();

		for (Node node : adjacencyList.keySet()) {
			int degree = getNeighbors(node).size();

			if (degree > max) {
				highest.clear();
				highest.add(node);
				max = degree;
			} else if (degree == max) {
				highest.add(node);
			}
		}

		return highest;
	}

	public int totalEdges() {
		int edges = 0;

		for (Node node : adjacencyList.keySet()) {
			edges += getNeighbors(node).size();
		}

		return edges / 2;
	}


	private void dfs_recursive(Node current, Set<Node> visited, Set<Node> component) {
		visited.add(current);
		component.add(current);

		for (Node n : getNeighbors(current)) {
			if (visited.contains(n)) continue;

			dfs_recursive(n, visited, component);
		}
	}

	public Set<Node> connectedComponent(Node start) {
		Set<Node> visited = new HashSet<>();
		Set<Node> component = new HashSet();

		dfs_recursive(start, visited, component);

		return component;
	}

	public ArrayList<Set<Node>> connectedComponents() {
		Set<Node> visited = new HashSet<Node>();
		ArrayList<Set<Node>> components = new ArrayList<Set<Node>>();

		for (Node n : adjacencyList.keySet()) {
			if (visited.contains(n)) continue;

			Set<Node> component = new HashSet<Node>();

			dfs_recursive(n, visited, component);

			components.add(component);
		}

		return components;
	}

	@Override
	public String toString() {
		String output = "";

		for (Node n : adjacencyList.keySet()) {
			output += n + " -> " + adjacencyList.get(n) + "\n";
		}

		return output;
	}

	public void print() {
		System.out.println(toString());
	}
}
