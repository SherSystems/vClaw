import { useState } from "react";
import Incidents from "../Incidents";
import ActivePlan from "../ActivePlan";
import Governance from "../Governance";

export default function Operations() {
  const [subTab, setSubTab] = useState("incidents");

  return (
    <div className="page">
      <div className="page-header">
        <h2>Operations</h2>
        <div className="sub-tabs">
          <button
            className={`sub-tab${subTab === "incidents" ? " active" : ""}`}
            onClick={() => setSubTab("incidents")}
          >
            Incidents
          </button>
          <button
            className={`sub-tab${subTab === "plan" ? " active" : ""}`}
            onClick={() => setSubTab("plan")}
          >
            Active Plan
          </button>
          <button
            className={`sub-tab${subTab === "governance" ? " active" : ""}`}
            onClick={() => setSubTab("governance")}
          >
            Governance
          </button>
        </div>
      </div>
      {subTab === "incidents" && <Incidents />}
      {subTab === "plan" && <ActivePlan />}
      {subTab === "governance" && <Governance />}
    </div>
  );
}
