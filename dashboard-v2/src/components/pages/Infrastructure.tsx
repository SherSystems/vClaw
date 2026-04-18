import { useState } from "react";
import TopologyMap from "../TopologyMap";
import Nodes from "../Nodes";
import Resources from "../Resources";

export default function Infrastructure() {
  const [subTab, setSubTab] = useState("topology");

  return (
    <div className="page">
      <div className="page-header">
        <h2>Infrastructure</h2>
        <div className="sub-tabs">
          <button
            className={`sub-tab${subTab === "topology" ? " active" : ""}`}
            onClick={() => setSubTab("topology")}
          >
            Topology
          </button>
          <button
            className={`sub-tab${subTab === "nodes" ? " active" : ""}`}
            onClick={() => setSubTab("nodes")}
          >
            Nodes
          </button>
          <button
            className={`sub-tab${subTab === "resources" ? " active" : ""}`}
            onClick={() => setSubTab("resources")}
          >
            Resources
          </button>
        </div>
      </div>
      {subTab === "topology" && <TopologyMap />}
      {subTab === "nodes" && <Nodes />}
      {subTab === "resources" && <Resources />}
    </div>
  );
}
