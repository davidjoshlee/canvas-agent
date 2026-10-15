Task: {{TASK_ID}}

## Assignment requirements

The deliverable computes baseline and incremental contribution, distinguishes
the already-paid study fee from pilot costs, applies both readings, and recommends
a test while making missing demand and operating-cost evidence explicit. All
scenario inputs below come from `ECON101/Assignments/pricing.md`; the scenario
assumes unchanged booking volume and no additional operating costs.

## Draft

### Baseline and incremental contribution

Baseline contribution is 500 bookings × $40 = $20,000. The premium uplift is
150 × $12 = $1,800; the discount loss is 100 × $3 = $300. After the $1,000
pilot setup cost, incremental contribution is $1,800 − $300 − $1,000 = $500.
Adding that to the baseline gives $20,500 under the stated scenario.
These operations were executed with the CLI calculator, and their inputs were
checked against `ECON101/Assignments/pricing.md`.

### Scenario contribution table

| Component | Contribution USD |
| --- | ---: |
| Baseline | 20000 |
| Premium uplift | 1800 |
| Discount loss | -300 |
| Pilot setup | -1000 |
| Incremental contribution | 500 |
| Scenario total | 20500 |

The $2,000 study fee is already paid. It is not incurred because of choosing
the pilot and should not be subtracted again from incremental contribution.
This follows the reading's distinction between sunk costs and changes relative
to the next-best alternative.
`ECON101/Assignments/pricing.md`
`ECON101/Week 03 - Oct 12/marginal-analysis.md`

### Recommendation and experimental decision rule

I recommend testing the pricing change, not an immediate unrestricted rollout.
The scenario's positive $500 is conditional: it does not establish that demand
will remain unchanged or that service costs will not rise. Losing bookings or
incurring extra operating costs could overturn that forecast.
`ECON101/Week 03 - Oct 12/marginal-analysis.md`

As a proposed design, randomly assign eligible customers to the new offer or
the existing offer during the same test period. Track conversion, booking mix,
contribution and incremental operating cost in both groups. Set the decision rule
before observing results: recommend rollout only if the test supports a positive
net contribution change after incremental operating costs and implementation costs;
otherwise retain the existing offer or revise and retest. This is a proposed rule,
not a result asserted by either reading. A before-after revenue increase alone
would not resolve seasonality or simultaneous-change confounding.
`ECON101/Week 03 - Oct 12/experiment-design.md`

## Open questions

PENDING — demand response and incremental operating-cost data are required to
estimate actual business impact. No supplied evidence establishes unchanged
volume outside the prompt's scenario. Sample size, test duration and a statistical
precision threshold also require baseline conversion and variability data; I have
not invented them. The proposed test should settle these design choices before
results are observed.

Host self-review: I checked the prompt's three requested outcomes and rubric,
traced every scenario input to the prompt, verified all five derived values with
executed calculations, applied both readings, and distinguished sunk expenditure
from pilot setup. I checked that the recommendation is conditional and contains
no fabricated outcomes or personal experience. Real demand, operating costs and
test precision remain unverified. This is a self-review, not independent grading
or approval to submit.

## Sources

- `ECON101/Assignments/pricing.md`
- `ECON101/Week 03 - Oct 12/marginal-analysis.md`
- `ECON101/Week 03 - Oct 12/experiment-design.md`
