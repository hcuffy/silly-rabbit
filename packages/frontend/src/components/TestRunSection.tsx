import type { CheckOutcome, FeatureDocument, FeatureHypothesis, ResearchInventory, TestRun } from "@silly-rabbit/shared";
import { useState } from "react";
import { formatDateTime } from "../lib/formatDateTime.js";
import { useFeatureDocumentHistory, useGenerateFeatureDocument } from "../lib/queries.js";

function ResearchDetails({ research }: { research: ResearchInventory }) {
  return (
    <details className="research-details">
      <summary>Research: {research.sectionHeading}</summary>
      <p>
        Section URL: {research.sectionUrl} · Language: {research.detectedLanguage}
      </p>
      <h4>Elements</h4>
      <ul>
        {research.elements.map((element) => (
          <li key={`${element.role}-${element.accessibleName}`}>
            <strong>{element.kind}</strong>: {element.accessibleName} (<code>{element.role}</code>)
            {element.required && " — required"}
            {element.options && ` — options: ${element.options.join(", ")}`}
          </li>
        ))}
      </ul>
      <h4>Entity fields</h4>
      <ul>
        {research.entityFields.map((field) => (
          <li key={field}>{field}</li>
        ))}
      </ul>
    </details>
  );
}

function HypothesisCard({ hypothesis }: { hypothesis: FeatureHypothesis }) {
  return (
    <li className="hypothesis-card">
      <p className="hypothesis-card__assumption">{hypothesis.assumption}</p>
      <p>
        <strong>Happy path:</strong> {hypothesis.happyPathCheck.description} — expect: {hypothesis.happyPathCheck.expectedOutcome}
      </p>
      <p>
        <strong>Boundary ({hypothesis.boundaryCheck.category}):</strong> {hypothesis.boundaryCheck.description} — expect:{" "}
        {hypothesis.boundaryCheck.expectedOutcome}
      </p>
    </li>
  );
}

function summarizeOutcomes(checkOutcomes: CheckOutcome[]): Record<CheckOutcome["result"], number> {
  const summary: Record<CheckOutcome["result"], number> = { passed: 0, failed: 0, skipped: 0, timed_out: 0 };
  for (const outcome of checkOutcomes) summary[outcome.result] += 1;
  return summary;
}

function CheckOutcomesSummary({ checkOutcomes, testPlan }: { checkOutcomes: CheckOutcome[]; testPlan: FeatureHypothesis[] }) {
  const summary = summarizeOutcomes(checkOutcomes);
  const hypothesesById = new Map(testPlan.map((hypothesis) => [hypothesis.id, hypothesis]));

  return (
    <>
      <p className="check-outcomes__summary">
        Passed: {summary.passed} · Failed: {summary.failed} · Skipped: {summary.skipped} · Timed out: {summary.timed_out}
      </p>
      <table className="check-outcomes__table">
        <thead>
          <tr>
            <th>Hypothesis</th>
            <th>Check</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {checkOutcomes.map((outcome) => (
            <tr key={`${outcome.hypothesisId}-${outcome.check}`}>
              <td>{hypothesesById.get(outcome.hypothesisId)?.assumption ?? outcome.hypothesisId}</td>
              <td>{outcome.check}</td>
              <td className={`check-outcomes__result check-outcomes__result--${outcome.result}`}>{outcome.result}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function FeatureDocumentViewer({ document }: { document: FeatureDocument }) {
  return (
    <>
      <p className="feature-doc__meta">
        Generated {formatDateTime(document.generatedAt)} · {document.model}
      </p>
      <pre className="feature-doc__content">{document.content}</pre>
    </>
  );
}

function FeatureDocumentSection({ featureId }: { featureId: string }) {
  const { data: history, isPending } = useFeatureDocumentHistory(featureId);
  const generateDocument = useGenerateFeatureDocument(featureId);
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | undefined>(undefined);

  const latest = history?.[0];
  const selected = (selectedDocumentId ? history?.find((entry) => entry.id === selectedDocumentId) : undefined) ?? latest;

  return (
    <section className="feature-doc">
      <h3>Feature doc</h3>
      <button type="button" onClick={() => generateDocument.mutate()} disabled={generateDocument.isPending}>
        {generateDocument.isPending ? "Generating…" : "Generate feature doc"}
      </button>
      {generateDocument.isError && <p className="feature-doc__error">{generateDocument.error.message}</p>}
      {isPending && <p>Loading feature docs…</p>}
      {!isPending && !selected && <p>No feature doc generated yet.</p>}
      {selected && <FeatureDocumentViewer document={selected} />}
      {history && history.length > 1 && (
        <details className="feature-doc__history">
          <summary>History ({history.length})</summary>
          <ul>
            {history.map((entry) => (
              <li key={entry.id}>
                <button type="button" onClick={() => setSelectedDocumentId(entry.id)}>
                  {formatDateTime(entry.generatedAt)}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

export function TestRunSection({ testRun }: { testRun: TestRun }) {
  return (
    <section className="test-run">
      <ResearchDetails research={testRun.research} />

      <h3>Test plan</h3>
      {testRun.testPlan.length === 0 && <p>No hypothesis cards generated for this run.</p>}
      {testRun.testPlan.length > 0 && (
        <ul className="hypothesis-list">
          {testRun.testPlan.map((hypothesis) => (
            <HypothesisCard key={hypothesis.id} hypothesis={hypothesis} />
          ))}
        </ul>
      )}

      <h3>Check outcomes</h3>
      {testRun.checkOutcomes.length === 0 && <p>No checks have completed yet.</p>}
      {testRun.checkOutcomes.length > 0 && (
        <CheckOutcomesSummary checkOutcomes={testRun.checkOutcomes} testPlan={testRun.testPlan} />
      )}

      <FeatureDocumentSection featureId={testRun.featureId} />
    </section>
  );
}
