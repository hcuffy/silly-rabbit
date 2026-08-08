export type CharterStep = { kind: "navigate"; path: string } | { kind: "clickFirstLink" };

export interface CharterPlan {
  name: string;
  steps: CharterStep[];
}
