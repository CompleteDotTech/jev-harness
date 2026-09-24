/** Offline demonstration only. Running this file never contacts Jev or executes fixture source. */
import { pathToFileURL } from "node:url";
import { syntheticSnapshot, mockResponse } from "../fixtures/code-review/synthetic.js";
import { nodePlanningDependencies, runCodeReview } from "../src/host/code-review.js";
import { replayReview } from "../src/code-review/index.js";

export async function demo() {
  const result = await runCodeReview(syntheticSnapshot(), {
    source: "mock", dataClass: "synthetic", allowEgress: async () => true,
    transport: async payload => mockResponse(payload, { negativeDebit: "supported" }),
  });
  const replayed = replayReview(result.trace, nodePlanningDependencies);
  return { source: "mock", note: "Scripted protocol demonstration, not a live Jev quality measurement.",
    report: result.report, replayMatches: replayed.reportHash === result.report.reportHash };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  demo().then(result => console.log(JSON.stringify(result, null, 2))).catch(() => {
    console.error("Offline code-review demonstration failed."); process.exitCode = 1;
  });
}
