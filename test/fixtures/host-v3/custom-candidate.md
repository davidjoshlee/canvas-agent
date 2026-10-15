Task: {{TASK_ID}}

## Recommendation

Run a limited randomized pilot, not a full rollout. The supplied scenario forecasts $500 additional contribution, but unchanged demand and no additional operating costs are assumptions rather than observed results. Comparing the pilot against the next-best alternative is appropriate; the forecast alone does not establish a profitable real-world change. `ECON101/Assignments/pricing.md` `ECON101/Week 03 - Oct 12/marginal-analysis.md`

Randomly assign comparable eligible customers to the existing offer or the pilot offer. Measure conversion, booking mix, revenue and incremental operating cost, then compare net incremental contribution between groups. Fix the decision rule before observing outcomes: expand only if estimated incremental contribution after measured costs is positive and its prespecified uncertainty interval excludes zero; otherwise extend the experiment if informative and feasible, or retain the existing offer. This uncertainty-interval rule is a proposed design choice, not a rule supplied by the instructor. Avoid a before-after comparison because seasonality or another concurrent change could explain the apparent effect. `ECON101/Week 03 - Oct 12/experiment-design.md`

## Computations

The executed operations gave 500 × 40 = 20000; 150 × 12 = 1800; 100 × 3 = 300; sum(1800, -300, -1000) = 500; and 20000 + 500 = 20500. Inputs were checked against the scenario prompt. The $2,000 already-paid study fee is sunk and is not an incremental pilot cost. `ECON101/Assignments/pricing.md` `ECON101/Week 03 - Oct 12/marginal-analysis.md`

### Contribution scenario

| Component | Contribution ($) |
| --- | ---: |
| Baseline | 20000 |
| Premium uplift | 1800 |
| Discount loss | -300 |
| Pilot setup | -1000 |
| Net incremental | 500 |
| Scenario total | 20500 |

## Limitations

PENDING — requires demand, operating-cost and outcome-variance data to estimate actual profitability, choose sample size and experiment duration, and set a defensible uncertainty interval. No sample size, observed causal effect, demand response or successful pilot is claimed. The unchanged-volume/no-additional-operating-cost assumptions apply only to the supplied calculation scenario. `ECON101/Assignments/pricing.md` `ECON101/Week 03 - Oct 12/experiment-design.md`

Host self-review: I checked all three prompt requests, the sunk-cost distinction, both readings, scenario inputs and executed arithmetic. The recommendation and test design are conditional proposals. Source completeness beyond the supplied fixture, empirical outcomes and statistical precision remain unverified; this review is not independent grading or student approval.

## Sources

- `ECON101/Assignments/pricing.md` — scenario inputs, questions and rubric.
- `ECON101/Week 03 - Oct 12/marginal-analysis.md` — marginal comparison, sunk costs and conditional forecasts.
- `ECON101/Week 03 - Oct 12/experiment-design.md` — random assignment, outcome measures and before-after confounding.
